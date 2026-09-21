/**
 * 怪物战斗属性表：PVE 里"这只怪有哪些数值"的唯一入口。
 *
 * 改造前的形状：`game_balance.combat` 里三个全局常数 × 一个随**玩家**境界浮动的倍率。
 * 也就是说怪物自己的 realm、以及任何属性声明都不参与结算 —— 野兔和妖王数值完全相同，
 * 而玩家侧早就有的暴击/闪避/格挡/抗性，怪物一个都拿不到：想让一只妖狼会暴击，
 * 只能回去改 CombatService 里那份写死的字典。
 *
 * 现在内容里直接写就行（map_data 可被资料片 add/override）：
 *   { "id": "shan_gao_lang", "realm": "炼气5层", "exp": 60,
 *     "power_multiplier": 1.5, "stats": { "crit_rate": 15, "dodge_rate": 20 } }
 * 之所以能"改数据就生效"，是因为结算用的 CombatResolver.computeDamage 本来就按属性块
 * 对称地读攻守两侧（暴击看攻方、闪避看守方），以前只是调用方各递了一个单字段对象过去。
 */
'use strict';

// 血量别名与"整块折算"是战斗侧共用的（友方的出战/护法傀儡走同一个原语的 registeredOnly 口径）
const { HP_KEYS, scaleStatBlock } = require('./CombatStats');

/**
 * 内容声明层：任何敌人来源都能用的那两件东西 —— `power_multiplier`（整块缩放，精英/首领档）
 * 与 `stats`（任意注册表属性键，逐键覆盖）。
 *
 * 单独成函数是为了让副本/兽渊/世界BOSS 这些"自己算自己的基数"的来源也能复用同一层声明，
 * 而不是每接一个玩法就再发明一次"怪物怎么带属性"。
 *
 * @param {Object} base - 调用方算好的基础属性块（会被缩放，但不改原对象）
 * @param {Object} enemyConfig - 内容里的敌人条目（读它的 power_multiplier / stats）
 */
function withDeclaredStats(base, enemyConfig = {}) {
    const power = Number.isFinite(Number(enemyConfig.power_multiplier))
        ? Number(enemyConfig.power_multiplier) : 1;
    const out = scaleStatBlock(base, power, { except: [] });

    const declared = enemyConfig.stats || {};
    for (const [key, raw] of Object.entries(declared)) {
        // 启动期那道 _validateCombatStatBlocks 已经拦过"不是注册属性/不是数"，
        // 这里只兜运行期可能遇到的脏值：跳过它，而不是让整场战斗 500。
        const value = Number(raw);
        if (Number.isFinite(value)) out[key] = value;
    }
    // 声明了血量就把块里已有的几种叫法对齐，避免"面板 900、结算 100"这种同一次战斗里的两个数
    const hpKey = HP_KEYS.find(key => Object.prototype.hasOwnProperty.call(declared, key));
    if (hpKey) {
        for (const key of HP_KEYS) if (key in out) out[key] = out[hpKey];
    }
    return out;
}

/**
 * 境界基础值 → 一只怪该有什么数值。
 *
 * 以前"按境界给怪配数值"这件事同时存在四份表：RealmService（权威）、历练的
 * computeMonsterStatsByRealm、AIService 降级模板里那张只有 6 个境界的表
 * （筑基后期以上的玩家一律遇到"炼气1层"强度的怪），以及 AI 生成结果那条路。
 * 现在都以 RealmService 为准，各处只保留自己独有的那一层（模板的名字与抖动、
 * 内容里声明的 stats 与 power_multiplier）。
 *
 * @param {string} realmName - 那只怪自己的境界名（不是玩家境界）；查不到时按默认值兜底并告警
 * @param {Object} deps - { expFallback: 经验值, enemyConfig: 内容条目（读 stats/power_multiplier）, warnLabel: 日志前缀 }
 */
function buildRealmMonsterStats(realmName, { expFallback = 10, enemyConfig = {}, warnLabel = 'MonsterStats' } = {}) {
    const RealmService = require('../core/RealmService');
    const exp = Number(expFallback) || 10;
    const fallback = { hp: 100, atk: 10, def: 5, speed: 10, exp_reward: exp };
    let base = fallback;

    if (realmName) {
        let realmConfig = null;
        try {
            realmConfig = RealmService.getRealmByName(realmName);
        } catch (e) {
            // 境界配置整个读不出来（启动早期/热更失败）时按默认值兜底，而不是把遭遇打成 500
            console.warn(`[${warnLabel}] 读取境界配置失败: ${e.message}`);
        }
        if (!realmConfig) {
            console.warn(`[${warnLabel}] 怪物境界配置不存在: ${realmName}，使用默认属性`);
        } else {
            base = {
                hp: Number(realmConfig.base_hp) || fallback.hp,
                atk: Number(realmConfig.base_atk) || fallback.atk,
                def: Number(realmConfig.base_def) || fallback.def,
                speed: Number(realmConfig.base_speed) || fallback.speed,
                exp_reward: exp
            };
        }
    }

    const stats = withDeclaredStats({ ...base, max_hp: base.hp }, enemyConfig);
    stats.max_hp = stats.max_hp ?? stats.hp;
    return stats;
}

/**
 * 只并 `stats`（不乘 power_multiplier），并且**不覆盖基础值**。
 *
 * 给"数值存在实例行里"的敌人用（世界 BOSS、兽潮妖兽）：那些行的 atk/def/speed/hp 是战斗中的
 * 唯一权威（含阶段倍率与 Buff），让内容再声明一遍同一个数就会出现"两个真相"。
 * 所以这里只补基础块里没有的键（暴击/暴伤/吸血/五行抗性…），重复的键交给启动期那道校验去拒绝。
 */
function mergeDeclaredStats(base, stats = {}) {
    const onlyNew = {};
    for (const [key, value] of Object.entries(stats || {})) {
        if (!Object.prototype.hasOwnProperty.call(base, key)) onlyNew[key] = value;
    }
    return withDeclaredStats(base, { stats: onlyNew });
}

/**
 * @param {Object} monsterConfig - map_data 里那只怪（realm/exp/stats/power_multiplier 都来自内容）
 * @param {Object} deps - { playerLevel, combat }：combat 取自 game_balance.combat
 * @returns {Object} 战斗行 monster_data 的形状（既有键向后兼容，新增键原样带上）
 */
function buildMonsterStats(monsterConfig = {}, { playerLevel = 0, combat = {} } = {}) {
    const levelMultiplier = (Number(combat.level_multiplier_base) || 0)
        + (Number(playerLevel) || 0) * (Number(combat.level_multiplier_per_level) || 0);
    const scale = (base) => Math.floor((Number(base) || 0) * levelMultiplier);

    const stats = withDeclaredStats({
        id: monsterConfig.id ?? null,
        name: monsterConfig.name ?? null,
        realm: monsterConfig.realm ?? null,
        max_hp: scale(combat.base_monster_hp),
        hp: scale(combat.base_monster_hp),
        atk: scale(combat.base_monster_atk),
        def: scale(combat.base_monster_def),
        speed: scale(combat.base_monster_speed),
        exp_reward: Number(monsterConfig.exp) || 10
    }, monsterConfig);
    // 结算侧读的是 hp_max（注册表里的血量键），战斗行读的是 max_hp：两边必须同一个数
    if (stats.hp_max === undefined) stats.hp_max = stats.max_hp;
    return stats;
}

/** 结算要的守方/攻方属性块：直接把整份 monster_data 递过去，不再只挑一个字段 */
function monsterCombatStats(monsterData = {}) {
    const stats = { ...monsterData };
    if (stats.hp_max === undefined && stats.max_hp !== undefined) stats.hp_max = stats.max_hp;
    return stats;
}

/**
 * 归一化"外部生成的怪物"（AI 生成的历练遭遇）。
 *
 * 为什么要这道闸：`AIService.generateMonster` 把模型返回的 JSON 原样交给 AdventureEventService，
 * 后者直接写进 active_battles.monster_data 开打 —— 于是模型（或被注入的提示词、或一个
 * 配置错的接口）返回 `hp: 1e15` 就是永远打不过的遭遇，返回 `exp_reward: 1e15` 就是凭空刷屏的
 * 修为与灵石，返回缺字段则 `BigInt(undefined)` 当场 500。这是系统边界，必须按不可信输入处理。
 *
 * 规则与"人写的怪"同一把尺：数值一律以那只怪境界的基础值为参照钳制，
 * 触发属性只认属性注册表里登记过的键（没登记的直接丢掉，而不是让它静默生效）。
 *
 * 奖励另有一把更紧的尺：境界的 exp_cap 是"这个境界要攒满多少修为"，真仙那一档是 1e14，
 * 拿它当经验奖励上限等于没钳。调用方把手绘地图里最高的那条 exp 传进来（expCeiling），
 * 于是规则变成"模型不许比这张图上最肥的怪还肥"——上限来自内容，不需要再发明一个数。
 *
 * @param {Object} raw - 外部返回的怪物对象（任何形状）
 * @param {Object} deps - { realmFallback: 兜底境界名, maxMultiplier: 允许超出境界基础值多少倍，默认 3,
 *                          expCeiling: 这张地图里怪物经验的上限（内容给的），缺省则只按境界钳 }
 * @returns {Object} 可以安全入库/开打的怪物块
 */
function normalizeGeneratedMonster(raw, { realmFallback = '凡人', maxMultiplier = 3, expCeiling = null } = {}) {
    const RealmService = require('../core/RealmService');
    // 用 ensure 而不是直接抓单例：词表没装时 resolveStatKey() 一律返回 undefined，
    // 下面那句 `if (!def) continue` 就会把 AI/探渊生成的整块属性静默丢光
    const statRegistry = require('../stats').ensureStatRegistryLoaded();
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

    const realmName = String(source.realm || realmFallback || '凡人');
    const realm = RealmService.getRealmByName(realmName) || RealmService.getRealmByName(realmFallback) || {};
    const contentCeiling = Number.isFinite(Number(expCeiling)) && Number(expCeiling) > 0
        ? Math.floor(Number(expCeiling)) : null;
    const cap = (base, fallback) => {
        const ceiling = Math.max(1, Math.floor((Number(base) || 0) * maxMultiplier));
        return { ceiling, fallback: Math.max(1, Math.floor(Number(base) || fallback || 1)) };
    };

    const clampField = (key, base, fallback) => {
        let { ceiling, fallback: safeDefault } = cap(base, fallback);
        if (key === 'exp_reward' && contentCeiling !== null) {
            ceiling = Math.min(ceiling, contentCeiling);
            safeDefault = Math.min(safeDefault, ceiling);
        }
        // 经验值有两种叫法（提示词里写的是 exp，战斗里读的是 exp_reward）：都认，别再各写一遍
        const value = Number(source[key] !== undefined ? source[key] : (key === 'exp_reward' ? source.exp : undefined));
        if (!Number.isFinite(value) || value <= 0) return safeDefault;
        return Math.min(ceiling, Math.floor(value));
    };

    const monster = {
        id: String(source.id || `ai_${Date.now()}`).slice(0, 64),
        name: String(source.name || '未知妖兽').slice(0, 32),
        // 境界名以配置为准：模型编一个不存在的境界，读的人（属性/奖励/掉落）全会当成"查不到"
        realm: realm.name || realmFallback,
        hp: clampField('hp', realm.base_hp, 100),
        atk: clampField('atk', realm.base_atk, 10),
        def: clampField('def', realm.base_def, 5),
        speed: clampField('speed', realm.base_speed, 10),
        exp_reward: clampField('exp_reward', realm.exp_cap || 10, 10)
    };
    monster.max_hp = monster.hp;
    monster.hp_max = monster.hp;

    // 描述只留短文本：它会被拼进战斗日志与前端展示，不该成为长文或指令的载体
    if (typeof source.description === 'string') {
        monster.description = source.description.replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    for (const [key, value] of Object.entries(source)) {
        if (Object.prototype.hasOwnProperty.call(monster, key)) continue;
        const def = statRegistry.resolveStatKey(key);
        if (!def) continue;                       // 没登记的属性：丢掉，而不是"写了没反应"
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        monster[def.key] = Math.max(0, Math.min(1000000, numeric));
    }
    return monster;
}

module.exports = {
    buildMonsterStats,
    buildRealmMonsterStats,
    withDeclaredStats,
    mergeDeclaredStats,
    monsterCombatStats,
    normalizeGeneratedMonster
};
