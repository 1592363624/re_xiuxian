/**
 * 战斗数值解析层：把"打多少伤害 / 战力多少"从各 Service 的 if-else 里搬进声明式配置。
 *
 * 改造前的状况：
 *   - CombatService.attack / useSkill / monsterTurn 各自手写 `max(1, atk - def + rand - offset)`
 *   - PvpService._calculatePower、PvpService.getCombatPower、FengshenService 里又各抄了一份
 *     权重相同的战力公式（`atk*2 + def*1.5 + speed*1.2 + hp_max*0.1 + realm_rank*100`）
 *   - 而这些地方读的 `atk` 大多来自 player.attributes 这个陈旧 JSON 快照，
 *     不含装备/功法/灵兽加成 —— 面板显示 480 攻、实际按 25 攻结算。
 *
 * 现在：
 *   - 参战属性统一由 AttributeService 完整解析（含所有已注册来源）
 *   - 伤害形状来自 config/combat_formulas.json 的 profile；加一种伤害类型 = 加一条数据
 *   - 战力来自属性注册表的 powerWeight，只有定义里改权重，不再有多份公式
 */
'use strict';

const Expr = require('../stats/Expr');
const { ensureStatRegistryLoaded } = require('../stats');
const skillEffects = require('./skillEffects');

/** 取配置里的嵌套值，如 'combat.skill_damage_multiplier' */
function dig(obj, dottedPath) {
    return dottedPath.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

class CombatResolver {
    constructor() {
        this.configLoader = null;
        this._formulaCache = new Map();
        this._compiledPower = null;
    }

    initialize(configLoader) {
        this.configLoader = configLoader;
        this._formulaCache = new Map();
        this._compiledPower = null;
    }

    get config() {
        let config = null;
        try {
            config = this.configLoader?.getConfig('combat_formulas');
        } catch (error) {
            console.warn(`[CombatResolver] combat_formulas 配置读取失败，使用兜底常量: ${error.message}`);
        }
        return config || FALLBACK_CONFIG;
    }

    get registry() {
        return ensureStatRegistryLoaded(this.configLoader);
    }

    /**
     * 解析参战方的完整属性（含装备/灵兽/功法/法宝/傀儡）。
     * @param {Object} player - 玩家实例
     * @param {Object} [options] - 透传给 calculateFullAttributesAsync
     */
    async resolveCombatStats(player, options = {}) {
        const AttributeService = require('../core/AttributeService');
        const result = await AttributeService.calculateFullAttributesAsync(player, options);
        return {
            stats: result.final,
            breakdown: result.breakdown,
            byStat: result.by_stat,
            info: result.info
        };
    }

    profile(name) {
        const profile = this.config.profiles?.[name];
        if (!profile) throw new Error(`未注册的战斗公式 profile: ${name}`);
        return profile;
    }

    /**
     * 选一条"主动出手"用的伤害档位。
     *
     * 为什么要有这个：以前 PvP/PvE 都写死 player_basic / player_skill，
     * 于是 combat_formulas 里声明的 player_sword_intent、资料片新加的 player_five_element
     * 永远不会被任何代码取到——配置写了，战斗里却打不出这种伤害。
     * 现在由数据决定：神通在自己的配置里写 damage_profile，出手时按领悟顺序取第一条声明过的。
     *
     * @param {Array<{damage_profile?: string}>} skills 已领悟神通（CombatResolver.resolveCombatStats 的 info.technique_skills）
     * @param {string} [fallback='player_skill']
     * @returns {string} profile 名
     */
    selectSkillProfile(skills, fallback = 'player_skill') {
        if (Array.isArray(skills)) {
            for (const skill of skills) {
                const profile = skill && skill.damage_profile;
                // 只认注册过的档位：资料片写了个不存在的 profile 时宁可退回默认档，
                // 也不要让一次普通出手直接抛错打断战斗
                if (typeof profile === 'string' && this.config.profiles?.[profile]) return profile;
            }
        }
        return fallback;
    }

    /**
     * 按 profile 结算一次伤害。
     * @param {string} profileName
     * @param {Object} inputs
     * @param {Object} inputs.attackerStats 攻击方属性块（attack_from=monster 时传怪物数据）
     * @param {Object} inputs.defenderStats 防御方属性块
     * @param {Array} [inputs.skills] 出手方已领悟的神通（战斗特效：额外伤害/破防）
     * @param {Array} [inputs.defenderSkills] 承受方已领悟的神通（伤害减免/格挡）
     * @param {Object} [inputs.balanceConfig] game_balance 配置（用于取 skill_damage_multiplier 等）
     * @param {number} [inputs.random] 0~1 随机数，用于伤害浮动（测试可注入固定值）
     * @param {() => number} [inputs.roll] 0~1 随机源，神通发动/暴击/闪避/格挡各掷一次（测试可注入）
     * @returns {{damage: number, attack: number, mitigate: number, profile: string, crit: boolean, missed: boolean, blocked: boolean, lifesteal: number, lifesteal_rate: number}}
     */
    computeDamage(profileName, inputs) {
        const profile = this.profile(profileName);
        const { attackerStats = {}, defenderStats = {}, balanceConfig = {}, random = Math.random() } = inputs;
        const roll = typeof inputs.roll === 'function' ? inputs.roll : Math.random;
        const randomConfig = this.config.random || {};

        // 神通的战斗特效先汇总：破防要改防御系数，所以必须落在公式之前
        const attackerProcs = skillEffects.collectSkillProcs(inputs.skills, roll);
        const defenderProcs = skillEffects.collectSkillProcs(inputs.defenderSkills, roll);

        const attack = this._statValue(profile, attackerStats, 'attack');
        const mitigate = this._statValue(profile, defenderStats, 'mitigate');

        let skillMultiplier = profile.skill_multiplier ?? 1;
        if (profile.skill_multiplier_config) {
            const configured = Number(dig(balanceConfig, profile.skill_multiplier_config));
            if (Number.isFinite(configured)) skillMultiplier = configured;
        }
        // 调用方可以按"这一次出手用的是哪一档技能"覆盖倍率（兽潮/世界Boss 的技能表是动态的）
        if (Number.isFinite(inputs.skill_multiplier)) skillMultiplier = inputs.skill_multiplier;

        // 随机浮动既支持按配置键取（player_damage_random_range 等），
        // 也支持 profile 直接写字面值——宗门战那种"±15% 乘算浮动"就是字面参数；
        // 再允许调用方覆盖一次：有的玩法把浮动写在**自己**的内容文件里（切磋木人的 damage_random_range），
        // 那份数值才是它的权威，档位不该反过来把全局常数盖到玩法头上。
        const randomRange = this._overrideNumber(inputs, 'random_range')
            ?? this._numberParam(profile, 'random_range', randomConfig);
        const randomOffset = this._overrideNumber(inputs, 'random_offset')
            ?? this._numberParam(profile, 'random_offset', randomConfig);
        // formula_vars：档位自带的常数（例如"减伤曲线分母里的 1000"），
        // 让形状完全不同的玩法也能用同一套结算，而不是各服务再抄一份公式
        const values = {
            ...(profile.formula_vars || {}),
            attack,
            mitigate,
            skill_multiplier: skillMultiplier,
            defense_coef: (Number.isFinite(profile.defense_coef) ? profile.defense_coef : 1)
                * (1 - attackerProcs.defense_pierce_rate),
            random,
            random_range: randomRange,
            random_offset: randomOffset,
            min_damage: Number.isFinite(profile.min_damage) ? profile.min_damage : 1
        };

        const base = Math.max(0, Math.floor(this._formula(profile)(values)));
        const proc = this._applyProcs(profile, base, {
            attackerStats, defenderStats, roll, attackerProcs, defenderProcs
        });
        // 玩法倍率（组队加成、境界压制、单人比例…）与属性无关，由调用方算好后传入。
        // 留一个口子，是为了让这些因子能乘在"同一套结算的结果"上，而不是逼着每个玩法再抄一份公式。
        const external = Number.isFinite(inputs.external_multiplier) ? inputs.external_multiplier : 1;
        const damage = external === 1 ? proc.damage : Math.max(0, Math.floor(proc.damage * external));

        return { ...proc, damage, attack, mitigate, profile: profileName, label: profile.label };
    }

    /**
     * 伤害算式：profile 可以自带 formula（形状完全不同的一种伤害，例如宗门战的乘算浮动），
     * 没写就用全局 formula。按算式文本缓存编译结果，配置热更后自动重新编译。
     */
    _formula(profile) {
        const source = profile.formula || this.config.formula;
        if (typeof source !== 'string' || !source.trim()) {
            throw new Error(`战斗公式 profile ${profile.label || '?'} 缺少可用的 formula`);
        }
        if (!this._formulaCache.has(source)) {
            this._formulaCache.set(source, Expr.compile(source, 'combat.damage'));
        }
        return this._formulaCache.get(source);
    }

    /** 数值参数：profile 字面值优先，其次按 *_config 键从 random 配置里取 */
    _numberParam(profile, name, randomConfig) {
        if (Number.isFinite(profile[name])) return profile[name];
        const configured = randomConfig[profile[`${name}_config`]];
        return Number.isFinite(configured) ? configured : 0;
    }

    /** 调用方按次覆盖的参数（未给或非数则返回 null，让 profile/全局值继续生效） */
    _overrideNumber(inputs, name) {
        if (inputs[name] === undefined || inputs[name] === null) return null;
        const value = Number(inputs[name]);
        return Number.isFinite(value) ? value : null;
    }

    /**
     * 一次出手的触发结算：闪避 → 格挡 → 神通增伤 → 暴击 → 承受方减伤 → 吸血。
     * 概率型属性（暴击/闪避/吸血）按 battleRole 从注册表反查属性键，所以装备、法宝深线、
     * 丹药、资料片新属性给的暴击都在这一处生效；改造前这些百分点只在面板和战力里出现，
     * 战斗从来没掷过骰子。神通的战斗特效走 skillEffects 的同一张表（破防已在公式里扣过）。
     */
    _applyProcs(profile, damage, { attackerStats, defenderStats, roll, attackerProcs, defenderProcs }) {
        const config = this.config.procs || {};
        const roles = this._procRoles(config);
        const enabled = (name) => profile.procs !== false && (profile.procs?.[name] !== false);
        const none = { missed: false, blocked: false, crit: false, lifesteal: 0, lifesteal_rate: 0 };

        if (enabled('dodge') && roles.dodge.length && roll() < this._chance(defenderStats, roles.dodge)) {
            return { ...none, damage: 0, missed: true };
        }
        if (enabled('block') && roll() < (defenderProcs?.block_chance || 0)) {
            return { ...none, damage: 0, blocked: true };
        }

        if (attackerProcs?.extra_damage_rate) {
            damage = Math.floor(damage * (1 + attackerProcs.extra_damage_rate));
        }

        let crit = false;
        if (enabled('crit') && roles.crit.length && roll() < this._chance(attackerStats, roles.crit)) {
            crit = true;
            const bonusPct = this._points(attackerStats, roles.critBonus,
                Number(config.crit?.default_bonus_pct) || 0);
            damage = Math.floor(damage * (1 + bonusPct / 100));
        }

        if (defenderProcs?.damage_reduction) {
            damage = Math.floor(damage * (1 - defenderProcs.damage_reduction));
        }

        let lifesteal = 0;
        let lifestealRate = 0;
        if (enabled('lifesteal') && roles.lifesteal.length) {
            lifestealRate = this._chance(attackerStats, roles.lifesteal);
            lifesteal = Math.floor(damage * lifestealRate);
        }
        // lifesteal_rate 单独返回：调用方在伤害被克制倍率/防御/护道再削减后，
        // 要按"实际打出去的伤害"回血，而不是本档位算出的那一份。
        return { damage, missed: false, blocked: false, crit, lifesteal, lifesteal_rate: lifestealRate };
    }

    /** battleRole → 已注册属性键列表（资料片把自己的属性挂到同名角色上就会一起生效） */
    _procRoles(config) {
        const index = this.registry.battleRoleIndex();
        const keys = (role) => (role ? index[role] : null) || [];
        return {
            dodge: keys(config.dodge?.defender_role),
            crit: keys(config.crit?.attacker_role),
            critBonus: keys(config.crit?.bonus_role),
            lifesteal: keys(config.lifesteal?.attacker_role)
        };
    }

    /** 面板百分点 → 0~1 概率；同一角色多个属性求和，全部缺失按 0 */
    _chance(stats, statKeys) {
        return Math.max(0, this._points(stats, statKeys, 0)) / 100;
    }

    _points(stats, statKeys, fallback) {
        const keys = Array.isArray(statKeys) ? statKeys.filter(Boolean) : [statKeys].filter(Boolean);
        if (!keys.length) return fallback;
        let total = 0;
        let seen = false;
        for (const key of keys) {
            const value = Number(stats?.[key]);
            if (!Number.isFinite(value)) continue;
            total += value;
            seen = true;
        }
        return seen ? total : fallback;
    }

    _statValue(profile, stats, role) {
        const primary = profile[`${role}_stat`];
        const fallback = profile[`${role}_fallback_stat`];
        const registry = this.registry;

        for (const key of [primary, fallback]) {
            if (!key) continue;
            const def = registry.resolveStatKey(key);
            const value = Number(def ? stats[def.key] : stats[key]);
            if (Number.isFinite(value) && value !== 0) return value;
        }
        // 允许真的为 0（例如没有法攻属性的怪物）：再走一次不带"非零"要求的取值
        const def = registry.resolveStatKey(primary);
        const exact = Number(stats[def ? def.key : primary]);
        return Number.isFinite(exact) ? exact : 0;
    }

    /**
     * 战力评分：唯一的一份公式。
     *
     * 权重优先级：game_balance.pvp_extended.combat_power 里的显式权重 > 属性注册表的 powerWeight。
     * 前者保留运营已经调好的数值（不改现网战力），后者保证"新属性自动计入战力"
     * ——改造前 PvpService._calculatePower、PvpService.getCombatPower、FengshenService
     * 各有一份互相冲突的权重表，同一对玩家在不同界面能算出高低相反的战力。
     *
     * @param {Object} stats 完整属性块
     * @param {number} realmRank
     * @param {Object} [balanceConfig] game_balance 配置（用于取覆盖权重）
     */
    computePower(stats, realmRank = 0, balanceConfig = {}) {
        const powerConfig = this.config.power || {};
        const configuredWeights = balanceConfig?.pvp_extended?.combat_power || {};

        // game_balance 里的战力字段名 → 属性键
        const WEIGHT_FIELD_TO_STAT = {
            base_hp_weight: 'hp_max',
            base_mp_weight: 'mp_max',
            base_atk_weight: 'atk',
            base_def_weight: 'def',
            base_speed_weight: 'speed',
            base_sense_weight: 'sense',
            base_matk_weight: 'matk',
            base_mdef_weight: 'mdef'
        };
        const overrides = {};
        for (const [field, statKey] of Object.entries(WEIGHT_FIELD_TO_STAT)) {
            if (Number.isFinite(configuredWeights[field])) overrides[statKey] = configuredWeights[field];
        }

        let statTotal = 0;
        for (const def of this.registry.all()) {
            const weight = overrides[def.key] ?? def.powerWeight;
            if (!weight) continue;
            const value = Number(stats[def.key]);
            if (Number.isFinite(value)) statTotal += value * weight;
        }

        const realmRankWeight = Number.isFinite(configuredWeights.realm_rank_multiplier)
            ? configuredWeights.realm_rank_multiplier
            : (Number.isFinite(powerConfig.realm_rank_weight) ? powerConfig.realm_rank_weight : 100);

        if (!this._compiledPower) {
            this._compiledPower = Expr.compile(powerConfig.formula || 'stat_total + realm_rank * realm_rank_weight', 'combat.power');
        }
        return Math.floor(this._compiledPower({
            stat_total: statTotal,
            realm_rank: Number(realmRank) || 0,
            realm_rank_weight: realmRankWeight
        }));
    }
}

/** combat_formulas.json 读不到时的兜底：保持与改造前完全一致的玩家普攻/怪物伤害形状 */
const FALLBACK_CONFIG = {
    random: {
        player_damage_random_range: 15,
        player_damage_random_offset: 7,
        monster_damage_random_range: 6,
        monster_damage_random_offset: 3
    },
    formula: 'max(min_damage, floor(attack * skill_multiplier - mitigate * defense_coef + floor(random * random_range) - random_offset))',
    power: { realm_rank_weight: 100, formula: 'stat_total + realm_rank * realm_rank_weight' },
    profiles: {
        player_basic: { label: '玩家普攻', attack_stat: 'atk', mitigate_stat: 'def', skill_multiplier: 1, defense_coef: 1, random_range_config: 'player_damage_random_range', random_offset_config: 'player_damage_random_offset', min_damage: 1 },
        player_skill: { label: '玩家技能', attack_stat: 'atk', mitigate_stat: 'def', skill_multiplier: 1.5, defense_coef: 1, random_range_config: 'player_damage_random_range', random_offset_config: 'player_damage_random_offset', min_damage: 1 },
        monster_basic: { label: '怪物普攻', attack_stat: 'atk', mitigate_stat: 'def', skill_multiplier: 1, defense_coef: 1, random_range_config: 'monster_damage_random_range', random_offset_config: 'monster_damage_random_offset', min_damage: 1 }
    }
};

const combatResolver = new CombatResolver();

module.exports = combatResolver;
// 测试与需要独立实例（不同配置的单元测试）用的构造入口；运行期一律用上面的单例
module.exports.CombatResolver = CombatResolver;
