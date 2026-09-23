/**
 * 属性加成来源（Provider）装配
 *
 * 每个来源只做两件事：把该玩法的原始加成取回来、翻译成引擎认识的修饰符。
 * 引擎不认识"装备""灵兽""法宝深线"这些玩法概念，所以：
 *   - 新增一个加成来源（例如宗门大殿祝福、洞府灵脉）= 在这里加一个 provider 并注册，
 *     StatEngine 与所有下游（面板/战斗/战力）都不用改。
 *   - requiresIo 标记该来源是否需要查库；静态解析（副本/宗门战开局快照）会跳过它们，
 *     保持与改造前一致的行为：同步路径 = 境界+灵根+加点+天赋+称号，异步路径 = 再加装备/灵兽/功法/法宝。
 */
'use strict';

const EquipmentService = require('../services/EquipmentService');
const SpiritBeastService = require('../services/SpiritBeastService');
const ArtifactDeepLineService = require('../services/ArtifactDeepLineService');
const { spiritRootBonus } = require('./SpiritRoot');
// 战斗单位属性块 → 属性引擎：只认注册表里登记过的键（血量列名 hp 统一成 hp_max）
const { pickRegisteredStats } = require('../combat/CombatStats');
const { logOnce } = require('../../utils/logOnce');

/** 只保留数值型属性键，剔除 beast_info / skills 这类附带对象 */
function pickNumeric(source) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
}

/**
 * 展开 all_stats_bonus 通配效果。
 * 只作用于"点数型"属性（point），不作用于百分比型（暴击率之类），
 * 否则一件 +5 全属性的装备会白送 5 个百分点暴击。
 */
function expandWildcardEffects(raw, registry) {
    if (!raw || typeof raw !== 'object') return raw;
    const wildcardValue = Number(raw.all_stats_bonus);
    if (!Number.isFinite(wildcardValue) || wildcardValue === 0) return raw;

    const next = { ...raw };
    delete next.all_stats_bonus;
    for (const def of registry.all()) {
        if (def.unit !== 'point') continue;
        next[def.key] = (next[def.key] || 0) + wildcardValue;
    }
    return next;
}

/** 来源可用的原始加成：调用方预计算好时优先用预计算值（替代旧的 player._equipmentBonus 挂脏字段） */
function suppliedOr(ctx, providerId, fetcher) {
    const overrides = ctx.sourceOverrides;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, providerId)) {
        return Promise.resolve(overrides[providerId]);
    }
    return fetcher();
}

function buildProviders(registry, configLoader) {
    const providers = [];

    // 1. 灵根：存储形状有三种（type 英文名 / 'X灵根' 中文键 / 历史标量列），
    //    统一交给 SpiritRoot 按 role_init.spirit_roots 解析；直接读 player.spirit_root
    //    永远取不到（模型里没有这一列），这就是灵根加成此前从不生效的原因。
    providers.push({
        id: 'spirit_root',
        label: '灵根',
        order: 10,
        collect: (ctx) => pickNumeric(spiritRootBonus(
            ctx.player,
            configLoader?.getConfig('role_init')
        )),
    });

    // 2. 玩家加点 + 丹药等永久加成（attributes 里的 *_bonus 存储键，白名单由注册表推导）
    providers.push({
        id: 'allocated',
        label: '加点/丹药',
        order: 20,
        collect: (ctx) => {
            const out = {};
            for (const def of registry.all()) {
                const stored = Number(ctx.attributes?.[def.bonusKey]);
                if (Number.isFinite(stored) && stored !== 0) out[def.key] = stored;
            }
            return out;
        }
    });

    // 3. 天赋（*_pct 现网口径是"百分点"，交给引擎统一按最终值乘算）
    const bonusProviderFromConfig = (registry, configLoader) => ({
        id: 'talent',
        label: '天赋',
        order: 30,
        collect: (ctx) => {
            const talents = configLoader?.getConfig('talents') || [];
            const talent = talents.find(t => t.id === ctx.player.talent_id) || null;
            ctx.talentConfig = talent;
            return pickNumeric(talent?.bonuses || {});
        },
        info: (raw) => raw
    });
    providers.push(bonusProviderFromConfig(registry, configLoader));

    // 4. 称号
    providers.push({
        id: 'title',
        label: '称号',
        order: 40,
        collect: (ctx) => {
            const titles = configLoader?.getConfig('titles') || [];
            const title = titles.find(t => t.id === ctx.player.equipped_title_id) || null;
            ctx.titleConfig = title;
            return pickNumeric(title?.bonuses || {});
        },
        info: (raw) => raw
    });

    // 5. 装备（含祭炼与炼制品质倍率，由 EquipmentService 负责，它本身对属性键是泛化的）
    providers.push({
        id: 'equipment',
        label: '装备',
        order: 50,
        requiresIo: true,
        collect: (ctx) => suppliedOr(ctx, 'equipment', () => EquipmentService.getEquipmentBonus(ctx.player.id))
            .then(raw => expandWildcardEffects(pickNumeric(raw), registry))
    });

    // 6. 出战灵兽
    providers.push({
        id: 'spirit_beast',
        label: '灵兽',
        order: 60,
        requiresIo: true,
        collect: (ctx) => suppliedOr(ctx, 'spirit_beast', () => SpiritBeastService.getActiveBeastBonus(ctx.player.id))
            .then(raw => {
                ctx.beastInfo = raw?.beast_info || null;
                return pickNumeric(raw);
            }),
        info: (_raw, ctx) => ctx.beastInfo || null
    });

    // 7. 法宝深线：absolute 为绝对值、percent 已是小数倍率，effects 是战斗特效不进面板
    providers.push({
        id: 'artifact_deep_line',
        label: '法宝深线',
        order: 70,
        requiresIo: true,
        collect: (ctx) => suppliedOr(ctx, 'artifact_deep_line', () =>
            ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(ctx.player.id)
                .catch((error) => {
                    logOnce('stats.provider.artifact_deep_line',
                        `法宝深线加成读取失败，本轮属性面板按"无加成"兜底: ${error.message}`);
                    return { is_active: false, absolute: {}, percent: {}, effects: {}, breakdown: {} };
                })
        ).then(raw => {
            ctx.artifactDeepLine = raw || null;
            if (!raw || raw.is_active !== true) return {};
            const mods = {};
            for (const [key, value] of Object.entries(pickNumeric(raw.absolute))) mods[key] = { flat: value };
            for (const [key, value] of Object.entries(pickNumeric(raw.percent))) {
                mods[key] = { ...(mods[key] || {}), pct: value };
            }
            return mods;
        }),
        info: (_raw, ctx) => (ctx.artifactDeepLine && ctx.artifactDeepLine.is_active
            ? { effects: ctx.artifactDeepLine.effects || {}, sources: ctx.artifactDeepLine.breakdown || {} }
            : null)
    });

    // 8. 功法：属性为绝对值，cultivate_speed_pct 走百分比，skills 只作为战斗信息透出
    providers.push({
        id: 'technique',
        label: '功法',
        order: 80,
        requiresIo: true,
        collect: (ctx) => suppliedOr(ctx, 'technique', () => {
            // 延迟 require：TechniqueService 反向依赖 AttributeService，顶层 require 会成环
            const TechniqueService = require('../services/TechniqueService');
            return TechniqueService.getTechniqueBonus(ctx.player.id, ctx.player).catch(() => ({}));
        }).then(raw => {
            ctx.techniqueSkills = Array.isArray(raw?.skills) ? raw.skills : [];
            return pickNumeric(raw); // skills 是数组，pickNumeric 自然剔除
        }),
        info: (_raw, ctx) => ctx.techniqueSkills
    });

    // 9. 出战傀儡：按 battle_stat_ratio 折算，傀儡自身的 hp 对应玩家的 hp_max
    providers.push({
        id: 'puppet',
        label: '傀儡',
        order: 90,
        requiresIo: true,
        collect: (ctx) => suppliedOr(ctx, 'puppet', async () => {
            const PuppetService = require('../services/PuppetService');
            return PuppetService.getBattlePuppetBonus(ctx.player.id);
        }).then(raw => {
            if (!raw) return {};
            ctx.puppetInfo = { puppet_name: raw.puppet_name, puppet_id: raw.puppet_id };
            // 整块喂给属性引擎（血量列名 hp 映射成 hp_max）：以前这里手写四个键，
            // 于是傀儡多出来的任何属性都要再回来补一行才会进面板
            return pickRegisteredStats(raw);
        }),
        info: (_raw, ctx) => ctx.puppetInfo || null
    });

    // 10. 夺舍继承：住在 attributes.reincarnation_bonus 里的一份独立加成。
    //     为什么不复用 *_bonus（atk_bonus 那一族）：那些键是**玩家加点与丹药**的存储位，
    //     夺舍去覆盖会把玩家自己点的点清掉，去累加则每夺一次舍就永久叠一层（可刷分）。
    //     单独一个来源还有两个好处：面板能指名"这部分来自夺舍"，撤档/回滚时能整块清掉。
    //     只读玩家行上那份 blob，不查库，所以同步快照路径（副本/宗门战开局）同样吃得到。
    //     必须走 suppliedOr：夺舍服务要"把这一档清零后重算一遍"才知道这次该补多少差值，
    //     第一版这里直接读 blob、不认 override，于是第二次夺舍把上一次的账当成"已经有的"，
    //     算出补 0、落库却把旧账整块换掉 —— 玩家凭空掉一大截属性，而回执记的是掉完的数。
    providers.push({
        id: 'reincarnation',
        label: '夺舍继承',
        order: 100,
        collect: async (ctx) => pickNumeric(await suppliedOr(ctx, 'reincarnation', () => {
            // 延迟 require：ReincarnationService 顶层要解析玩家属性（CombatResolver→AttributeService→本文件），顶层 require 会成环
            const ReincarnationService = require('../services/ReincarnationService');
            return ReincarnationService.getInheritanceBonus(ctx.player);
        }))
    });

    return providers;
}

module.exports = { buildProviders, pickNumeric, expandWildcardEffects };
