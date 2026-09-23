/**
 * 神通效果词表（唯一权威）。
 *
 * 为什么单独一个叶子模块：神通的 effects 此前是"配了但没人读"的状态——
 * 8 门基础神通各写着 extra_damage_rate / block_chance / crit_rate_bonus，
 * 战斗侧一个都没消费，属性侧也没折叠，等于纯文案。
 * 现在三类信息写在一起，三个消费方（战斗结算 / 功法属性来源 / 启动期校验）共用同一张表，
 * 资料片加一门带新特效的神通，只要键名在这张表里就自动生效，键名拼错就启动失败。
 *
 * 单位口径（现网 technique_data.skills[].effects 全部按小数写）：
 *   0.15 == 15%。折叠进属性时要换算成面板口径的"百分点"（crit_rate: 15），
 *   或写成 *_pct 后缀交给 StatEngine 按 percent_number 口径除以 100。
 */
'use strict';

/** 概率门：一门神通若声明了 trigger_chance，本回合先掷一次，没中就这条神通的特效全不参与 */
const TRIGGER_KEY = 'trigger_chance';

/**
 * 属性类特效：折叠进功法的属性产出，于是面板 / 战力 / 战斗 / 突破全部自动看到它。
 *   stat   目标属性键（必须是 stat_definitions 注册过的）
 *   scale  小数 → 面板口径的乘数
 *   mode   'flat' 直接加数值；'pct' 走 *_pct 后缀（引擎按百分比处理）
 */
const SKILL_STAT_EFFECTS = {
    crit_rate_bonus: { stat: 'crit_rate', scale: 100, mode: 'flat', label: '暴击率' },
    crit_damage_bonus: { stat: 'crit_damage', scale: 100, mode: 'flat', label: '暴击伤害' },
    lifesteal_rate: { stat: 'lifesteal', scale: 100, mode: 'flat', label: '吸血' },
    def_bonus_pct: { stat: 'def', scale: 100, mode: 'pct', label: '防御' },
    cultivate_speed_pct: { stat: 'cultivate_speed', scale: 1, mode: 'pct', label: '修炼速度' },
    breakthrough_rate_bonus: { stat: 'breakthrough_bonus', scale: 100, mode: 'flat', label: '突破成功率' }
};

/**
 * 战斗特效：在 CombatResolver 结算每一次出手时应用，不进面板。
 *   side   'attacker' 随出手方生效；'defender' 随承受方生效
 *   mode   'sum' 多门神通叠加；'max' 取最高的一档（减伤/格挡叠满会失控）
 *   cap    上限（小数），防止资料片写出 1.5 的穿透把防御直接清零
 */
const SKILL_PROC_EFFECTS = {
    extra_damage_rate: { side: 'attacker', mode: 'sum', cap: 5, label: '额外伤害' },
    defense_pierce_rate: { side: 'attacker', mode: 'max', cap: 0.9, label: '破防' },
    damage_reduction: { side: 'defender', mode: 'max', cap: 0.8, label: '伤害减免' },
    block_chance: { side: 'defender', mode: 'max', cap: 0.5, label: '格挡' },
    // 法宝深线 effects 桶（2026-09-23 接线）：每回合结算，不进面板
    hp_regen_bonus_rate: { side: 'self', mode: 'sum', cap: 0.5, label: '每回合回复' },
    backlash_rate_per_round: { side: 'self', mode: 'sum', cap: 0.5, label: '血祭反噬' },
    damage_reduction_rate: { side: 'defender', mode: 'max', cap: 0.8, label: '伤害减免' }
};

/**
 * 把法宝深线 effects 桶折进战斗特效（与神通特效同一张表、同一套 cap/mode）。
 * 键名：深线用 damage_reduction_rate，神通用 damage_reduction —— 都归一到 damage_reduction。
 */
function mergeDeepLineEffects(procs, effects) {
    const out = procs || {};
    if (!isPlainObject(effects)) return out;
    const alias = { damage_reduction_rate: 'damage_reduction' };
    for (const [rawKey, rawValue] of Object.entries(effects)) {
        const key = alias[rawKey] || rawKey;
        const spec = SKILL_PROC_EFFECTS[key];
        if (!spec) continue;
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value <= 0) continue;
        const clamped = Math.min(value, spec.cap);
        out[key] = spec.mode === 'max' ? Math.max(out[key] || 0, clamped) : (out[key] || 0) + clamped;
    }
    return out;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 这个特效键是否被认识（启动期校验用；拼错的键过去只会静默不生效） */
function isKnownSkillEffectKey(key) {
    return key === TRIGGER_KEY
        || Object.prototype.hasOwnProperty.call(SKILL_STAT_EFFECTS, key)
        || Object.prototype.hasOwnProperty.call(SKILL_PROC_EFFECTS, key);
}

/** 全部可识别的特效键，供校验失败时把"能写什么"一并告诉策划 */
function skillEffectVocabulary() {
    return {
        trigger: TRIGGER_KEY,
        stats: Object.keys(SKILL_STAT_EFFECTS),
        procs: Object.keys(SKILL_PROC_EFFECTS)
    };
}

/** 这门神通本回合是否发动（没有 trigger_chance 的按常驻处理） */
function triggers(effect, roll) {
    const chance = Number(effect[TRIGGER_KEY]);
    if (!Number.isFinite(chance) || chance <= 0) return true;
    if (chance >= 1) return true;
    return roll() < chance;
}

/**
 * 汇总一方向的战斗特效。
 * @param {Array<{effects?: Object}>} skills 已领悟神通（TechniqueService 的 info.technique_skills）
 * @param {() => number} roll 随机源，测试可注入
 */
function collectSkillProcs(skills, roll = Math.random) {
    const out = {};
    for (const [key, spec] of Object.entries(SKILL_PROC_EFFECTS)) out[key] = 0;
    out.fired = [];
    if (!Array.isArray(skills)) return out;

    for (const skill of skills) {
        const effect = skill && skill.effects;
        if (!isPlainObject(effect) || !triggers(effect, roll)) continue;
        for (const [key, spec] of Object.entries(SKILL_PROC_EFFECTS)) {
            const value = Number(effect[key]);
            if (!Number.isFinite(value) || value <= 0) continue;
            const clamped = Math.min(value, spec.cap);
            out[key] = spec.mode === 'max' ? Math.max(out[key], clamped) : out[key] + clamped;
        }
        if (Object.keys(SKILL_PROC_EFFECTS).some(key => Number(effect[key]) > 0)) {
            out.fired.push(skill.id || skill.name || null);
        }
    }
    return out;
}

/**
 * 把属性类特效折叠进功法加成产出（就地累加）。
 * 写成 *_pct 后缀时键名用 `<属性>_pct`，StatEngine 的 normalizeModifiers 会认。
 */
function foldSkillStats(skills, target) {
    for (const skill of skills || []) {
        const effect = skill && skill.effects;
        if (!isPlainObject(effect)) continue;
        for (const [key, spec] of Object.entries(SKILL_STAT_EFFECTS)) {
            const value = Number(effect[key]);
            if (!Number.isFinite(value) || value === 0) continue;
            const written = spec.mode === 'pct' ? `${spec.stat}_pct` : spec.stat;
            target[written] = (target[written] || 0) + value * spec.scale;
        }
    }
    return target;
}

module.exports = {
    TRIGGER_KEY,
    SKILL_STAT_EFFECTS,
    SKILL_PROC_EFFECTS,
    isKnownSkillEffectKey,
    skillEffectVocabulary,
    collectSkillProcs,
    foldSkillStats,
    mergeDeepLineEffects
};
