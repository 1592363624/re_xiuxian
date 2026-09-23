/**
 * 法宝深线「加成字段 → 属性」的口径闸（2026-09-21）
 *
 * 这一份管的是业主那条要求的最后一块短板：**"我给一把刀加一档新属性，所有用到它的地方要直接算"**。
 * 幻世轮的相位加成早就是泛化生成的（`_calculatePhaseBonus` 遍历相位配置里每个数值字段 × 阶数倍率），
 * 也就是内容侧本来就能写 `blood_power_bonus_rate`；但汇总口 `getAllArtifactDeepLineCombatBonuses`
 * 以前手写 `percent.atk += cb.atk_bonus_rate` 那几行 —— 内容加了、代码没点名，就静默丢掉。
 *
 * 所以这里两头都钉：
 *   1. **一字不变**：三条深线现网点名的字段照旧进原来的桶（口径表优先，防止泛化规则把
 *      `atk_bonus`（倍率前值）双算、把 `crit_rate_bonus`（效果口径 0.12=+12 点）当成 +0.12 点绝对值）；
 *   2. **零代码生效**：没点名的 `<注册属性>_bonus` / `<注册属性>_bonus_rate` 由属性注册表判定，
 *      一路算进 final 面板（第 3 组用真实资料片属性 blood_power 端到端实测）。
 *   3. 两条都不认的字段必须**报出来**并被户口册逐条定性（第 4、5 组）——
 *      现网量出来 6 个相位字段完全没有归宿、effects 整桶没有任何战斗读取方，
 *      这两笔是"面板承诺、战斗不给"的存量缺陷，等业主拍板是否接上（接上=改平衡）。
 *
 * 第 6 组顺手抓同类的**孤儿聚合器**（2026-09-23 起器灵已接线为 artifact_spirit provider）：
 * 实际属性引擎的 provider 名单里没有它 —— 器灵的全部战斗加成从未生效。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry, ensureStatRegistryLoaded } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');
const { buildProviders } = require('../game/stats/providers');
const { serverRoot, loadRealContent, makeRealConfigLoader, emptySources } = require('./helpers/realContent');

const NEW_STAT = 'blood_power';      // 只存在于资料片「魔道血修遗篇」里的那档属性
const DEEP_LINE_CFG = path.join(serverRoot, 'config', 'artifact_deep_lines.json');

let content;

beforeAll(async () => {
    const { initializeModules } = require('../modules');
    await initializeModules();
    content = loadRealContent(statRegistry);
});

beforeEach(() => {
    ensureStatRegistryLoaded();
    AttributeService._engine = null;
});

/** 造一个与被测方法内部 acc 同形的累加器 */
const newAcc = () => ({
    absolute: { atk: 0, def: 0, hp_max: 0, speed: 0, mp_max: 0, sense: 0, luck: 0, wisdom: 0 },
    percent: { atk: 0, def: 0, hp_max: 0, speed: 0 },
    effects: {
        crit_rate_bonus: 0, crit_damage_bonus: 0, hp_steal_bonus_rate: 0,
        damage_reduction_rate: 0, hp_regen_bonus_rate: 0,
        backlash_rate_per_round: 0, backlash_target: 'none',
        wheel_spin_enabled: false, active_sources: []
    },
    unconsumed: []
});
const route = (source, bonuses) => {
    const acc = newAcc();
    ArtifactDeepLineService._routeBonusFields(source, bonuses, acc);
    return acc;
};

describe('1. 现网点名的字段：分发口径一字不变', () => {
    test('血魔剑：攻击/防御走百分比，暴击·暴伤·吸血折进真实属性百分点，反噬留 effects', () => {
        const acc = route('blood_sword', {
            atk_bonus_rate: 0.05, def_bonus_rate: 0.02,
            crit_rate_bonus: 0.10, crit_damage_bonus: 0.20,
            hp_steal_bonus_rate: 0.05, blood_backlash_hp_rate_per_round: 0.01,
            is_active: true, imprint_type: 'blood'
        });
        expect(acc.percent.atk).toBeCloseTo(0.05, 10);
        expect(acc.percent.def).toBeCloseTo(0.02, 10);
        // 2026-09-23：吸血/暴击/暴伤折进注册表属性（scale=100：0.10 → 10 点）
        expect(acc.absolute.crit_rate).toBeCloseTo(10, 10);
        expect(acc.absolute.crit_damage).toBeCloseTo(20, 10);
        expect(acc.absolute.lifesteal).toBeCloseTo(5, 10);
        expect(acc.effects.backlash_rate_per_round).toBeCloseTo(0.01, 10);
        // 不再写进 effects（newAcc 预置 0）
        expect(acc.effects.crit_rate_bonus).toBe(0);
        expect(acc.absolute.atk).toBe(0);
        expect(acc.unconsumed).toEqual([]);
    });

    test('虚天鼎：atk_bonus 是倍率前值，只有 final_atk_bonus 进账（防止双算）', () => {
        const acc = route('xutian_cauldron', {
            is_active: true,
            def_bonus: 100, atk_bonus: 40, atk_multiplier: 1.5,
            final_atk_bonus: 60, backlash_rate_per_round: 0.02, backlash_target: 'self'
        });
        expect(acc.absolute.def).toBe(100);
        expect(acc.absolute.atk).toBe(60);
        expect(acc.effects.backlash_rate_per_round).toBeCloseTo(0.02, 10);
        expect(acc.unconsumed).toEqual([]);
    });

    test('幻世轮：四个 *_bonus_rate 进百分比、四个效果键进 effects，字符串/布尔字段忽略', () => {
        const acc = route('five_element_wheel', {
            atk_bonus_rate: 0.08, def_bonus_rate: 0.04, hp_bonus_rate: 0.06, speed_bonus_rate: 0.02,
            crit_rate_bonus: 0.03, crit_damage_bonus: 0.15,
            damage_reduction_rate: 0.05, hp_regen_bonus_rate: 0.01,
            phase: 'water', wheel_spin_enabled: true
        });
        expect(acc.percent).toMatchObject({ atk: 0.08, def: 0.04, hp_max: 0.06, speed: 0.02 });
        // 暴击/暴伤折进属性百分点；减免/回血仍走 effects（战斗侧已接）
        expect(acc.absolute.crit_rate).toBeCloseTo(3, 10);
        expect(acc.absolute.crit_damage).toBeCloseTo(15, 10);
        expect(acc.effects.damage_reduction_rate).toBeCloseTo(0.05, 10);
        expect(acc.effects.hp_regen_bonus_rate).toBeCloseTo(0.01, 10);
        expect(acc.unconsumed).toEqual([]);
    });

    test('数值为 0 的占位键不算漏分发（配置里成批存在）', () => {
        expect(route('five_element_wheel', { atk_bonus_rate: 0, shield_bonus_rate: 0 }).unconsumed).toEqual([]);
    });
});

describe('2. 没点名的字段：按属性注册表自动分发（资料片零代码的那条路）', () => {
    beforeAll(() => {
        expect(statRegistry.has(NEW_STAT)).toBe(true);   // 前置：这一档只由资料片声明
    });

    test('<属性>_bonus_rate → percent、<属性>_bonus → absolute，两条都无需改代码', () => {
        const acc = route('five_element_wheel', {
            atk_bonus_rate: 0.08, [`${NEW_STAT}_bonus_rate`]: 0.12, mdef_bonus: 40
        });
        expect(acc.percent.atk).toBeCloseTo(0.08, 10);
        expect(acc.percent[NEW_STAT]).toBeCloseTo(0.12, 10);
        expect(acc.absolute.mdef).toBe(40);
        expect(acc.unconsumed).toEqual([]);
    });

    test('去后缀不是注册属性的键不会被误当真：它进 unconsumed 而不是属性块', () => {
        const acc = route('five_element_wheel', { shield_bonus_rate: 0.05 });
        expect(acc.percent.shield).toBeUndefined();
        expect(acc.absolute.shield).toBeUndefined();
        expect(acc.unconsumed).toEqual(['five_element_wheel.shield_bonus_rate=0.05']);
    });

    test('控制跑：口径表优先级高于泛化规则（从表里摘掉一条，语义立刻改变）', () => {
        const routes = ArtifactDeepLineService.BONUS_ROUTES;
        const original = routes.five_element_wheel.crit_rate_bonus;
        delete routes.five_element_wheel.crit_rate_bonus;
        try {
            // 摘掉表项 → 泛化规则把 crit_rate_bonus 认成"绝对值 crit_rate"且不带 scale（0.03 点而非 3 点）
            expect(route('five_element_wheel', { crit_rate_bonus: 0.03 }).absolute.crit_rate).toBeCloseTo(0.03, 10);
        } finally {
            routes.five_element_wheel.crit_rate_bonus = original;
        }
        const restored = route('five_element_wheel', { crit_rate_bonus: 0.03 });
        // 表项带 scale=100：0.03 效果口径 → 3 个属性百分点
        expect(restored.absolute.crit_rate).toBeCloseTo(3, 10);
        expect(restored.effects.crit_rate_bonus).toBe(0);
    });

    test('整条链：相位配置里一个新属性键 → ×阶数倍率 → 分发 → percent（不改一行消费端）', () => {
        // 用真实配置的结构造一份 fixture：只在 water 相位多声明一档资料片属性，并给一个 2 阶倍率
        const cfg = JSON.parse(fs.readFileSync(DEEP_LINE_CFG, 'utf8')).settings.five_element_wheel;
        const stage = (cfg.stages || []).find(s => (s.phase_multiplier || 1) !== 1) || { stage: 1, phase_multiplier: 1.5 };
        const patched = {
            ...cfg,
            phases: { ...cfg.phases, water: { ...cfg.phases.water, [`${NEW_STAT}_bonus_rate`]: 0.1 } },
            stages: [{ stage: stage.stage, phase_multiplier: stage.phase_multiplier }]
        };
        const { multiplier, bonus } = ArtifactDeepLineService._calculatePhaseBonus(
            { current_phase: 'water', insight_stage: stage.stage }, patched);
        // 上游本来就是泛化的：它不认识属性，只是把每个数值字段乘倍率
        expect(bonus[`${NEW_STAT}_bonus_rate`]).toBeCloseTo(0.1 * multiplier, 6);
        // 下游现在也不点名了：注册表认得的键自动进 percent
        const acc = route('five_element_wheel', bonus);
        expect(acc.percent[NEW_STAT]).toBeCloseTo(0.1 * multiplier, 6);
        expect(acc.percent.atk).toBeCloseTo((patched.phases.water.atk_bonus_rate || 0) * multiplier, 6);
    });
});

describe('3. 端到端：深线分发出来的新属性真的算进 final 面板', () => {
    const makePlayer = (over = {}) => ({
        id: 202, realm: '炼气期1层', spirit_root: '金', talent_id: null,
        equipped_title_id: null, attribute_points: 0, attributes: {}, ...over
    });
    const withDeepLine = async (extra) => {
        AttributeService.initialize(makeRealConfigLoader(content));
        const { final } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: emptySources(extra ? { artifact_deep_line: extra } : {})
        });
        return final[NEW_STAT] || 0;
    };

    test('absolute 给 40 → final 多 40；再按 flat_then_pct 叠 12%', async () => {
        const base = await withDeepLine(null);
        const flat = await withDeepLine({
            is_active: true, absolute: { [NEW_STAT]: 40 }, percent: {}, effects: {}, breakdown: {}
        });
        expect(flat).toBe(base + 40);

        AttributeService.initialize(makeRealConfigLoader(content));
        const { final } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: emptySources({
                equipment: { [NEW_STAT]: 100 },
                artifact_deep_line: {
                    is_active: true, absolute: { [NEW_STAT]: 40 },
                    percent: { [NEW_STAT]: 0.12 }, effects: {}, breakdown: {}
                }
            })
        });
        expect(final[NEW_STAT]).toBe(Math.floor((base + 140) * 1.12));
    });

    test('新属性出现在 breakdown 的法宝深线一组里（玩家/后台能看到它来自哪里）', async () => {
        AttributeService.initialize(makeRealConfigLoader(content));
        const { breakdown } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: emptySources({
                artifact_deep_line: {
                    is_active: true, absolute: { [NEW_STAT]: 40 },
                    percent: {}, effects: {}, breakdown: { blood_sword: { atk_bonus_rate: 0 } }
                }
            })
        });
        expect(breakdown.artifact_deep_line).toMatchObject({ absolute: { [NEW_STAT]: 40 } });
    });
});

describe('4. 户口册：现网相位配置里没有归宿的字段（逐条要结论）', () => {
    /**
     * 量法与结论。这些键在 `config/artifact_deep_lines.json → settings.five_element_wheel.phases.*`
     * 里由内容声明，`_calculatePhaseBonus` 会照算，但属性注册表里没有同名属性、口径表也没点名 ——
     * 结果就是"给这只法宝配了、玩家永远拿不到"。
     *
     * verdict 只有两种能用：
     *   dead_content_pending_owner_decision —— 接上要改战斗平衡，等业主拍板（本轮不擅自接）
     *   not_a_stat                          —— 语义上就不是属性加成，代码应当不再产出这个键
     */
    const UNROUTED_LEDGER = {
        armor_penetration_rate: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '战斗侧的破防口径是 skillEffects 的 defense_pierce_rate（有生效实现），'
                + '深线却自造了 armor_penetration_rate 这个名字，两边不认识。接法应是把相位键改名词表化，属于平衡改动'
        },
        mp_regen_bonus_rate: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '属性注册表里没有 mp_regen 这一档，法力回复在战斗里也没有结算点（现在只有 hp 回合结算）'
        },
        slow_chance: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '战斗没有"减速"机制（速度只进先手序，不存在跨回合 debuff），要接得先加机制'
        },
        heal_bonus_rate: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '与 hp_regen_bonus_rate 同族：回合外治疗量倍率无结算点'
        },
        burn_damage_per_round_rate: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '持续伤害（DOT）在 CombatResolver 的战斗结算里没有对应通道（灼烧只作为技能即时伤害结算）'
        },
        shield_bonus_rate: {
            verdict: 'dead_content_pending_owner_decision',
            reason: '护盾与格挡（block_chance）不是一回事，战斗没有可吸收伤害的池子'
        }
    };

    /** 从真实配置里现量一份（抄台账就测不到"内容加了新键"） */
    function deadKeysFromConfig() {
        const cfg = JSON.parse(fs.readFileSync(DEEP_LINE_CFG, 'utf8')).settings;
        const dead = new Set();
        for (const [source, lineCfg] of Object.entries(cfg)) {
            for (const [, phase] of Object.entries(lineCfg?.phases || {})) {
                const bonuses = {};
                for (const [k, v] of Object.entries(phase)) if (typeof v === 'number') bonuses[k] = v;
                for (const item of route(source, bonuses).unconsumed) {
                    dead.add(item.split('.')[1].split('=')[0]);
                }
            }
        }
        return dead;
    }

    test('量出来的无归宿字段与台账完全一致（内容多一个键就红，台账少一条结论也红）', () => {
        expect([...deadKeysFromConfig()].sort()).toEqual(Object.keys(UNROUTED_LEDGER).sort());
    });

    test('每条结论都要写明是哪个机制缺位，不能只写"以后再说"', () => {
        const cfgText = fs.readFileSync(DEEP_LINE_CFG, 'utf8');
        for (const [key, entry] of Object.entries(UNROUTED_LEDGER)) {
            expect(['dead_content_pending_owner_decision', 'not_a_stat']).toContain(entry.verdict);
            expect(entry.reason.length).toBeGreaterThan(20);
            expect(entry.reason).toMatch(/战斗|结算|注册表|机制|词表|属性/);
            expect(cfgText).toContain(key);            // 结论不能与内容现状脱节
        }
    });

    test('控制跑：往相位块里塞一个新死键，上一条当场红（证明它读的是配置）', () => {
        const acc = route('five_element_wheel', { zz_unrouted_bonus_rate: 0.5 });
        expect(acc.unconsumed).toEqual(['five_element_wheel.zz_unrouted_bonus_rate=0.5']);
        expect(acc.unconsumed.length).toBe(1);
        // 若这个键进了相位配置，deadKeysFromConfig 就会多一条 → 与台账的相等断言失败
        expect(deadKeysFromConfig().size).toBe(Object.keys(UNROUTED_LEDGER).length);
    });
});

describe('5. effects 桶：面板印给玩家、战斗没人读（存量缺陷，等拍板）', () => {
    /**
     * 引用法宝深线的文件户口册。verdict=producer/display/validator 的都不结算战斗效果，
     * game/combat 下应当一条都没有 —— 有就意味着 effects 桶已经进战斗，本组结论要重写。
     */
    const DEEP_LINE_REFERENCES = {
        'game/services/ArtifactDeepLineService.js': { verdict: 'producer' },
        'game/stats/providers.js': {
            verdict: 'display_and_stats',
            reason: '只把 absolute/percent 折进属性块，effects 作为 info 透出给战斗侧 __effects'
        },
        'game/core/AttributeService.js': {
            verdict: 'display_only',
            reason: '把 effects 原样放进 breakdown.artifact_deep_line 给前端/后台看'
        },
        'game/combat/CombatResolver.js': {
            verdict: 'consumer',
            reason: '2026-09-23 接线：resolveCombatStats 把 effects 挂到 stats.__effects，'
                + 'computeDamage 经 skillEffects.mergeDeepLineEffects 并进 defenderProcs/attackerProcs'
        },
        'game/combat/skillEffects.js': {
            verdict: 'consumer',
            reason: 'mergeDeepLineEffects 把深线 effects 折进战斗特效表（减免/回血/反噬），与神通特效同一套 cap/mode'
        },
        'game/content/ContentRegistry.js': {
            verdict: 'validator',
            reason: '登记数据集与相位校验，不消费任何加成分量'
        },
        'game/content/sourceLedgers.js': {
            verdict: 'validator',
            reason: '内容路径账（来源/去路的正则表）里出现 artifact_deep_lines 只是"血祭材料是去路"这一条路径写法，不读也不结算任何加成'
        },
        'game/index.js': {
            verdict: 'boot_validator',
            reason: '启动期跑 assertBonusLabelCoverage()：只检查"要给玩家看的字段有没有中文名"，不消费加成分量。'
                + '它算一份引用是有意的 —— 户口册要能看见"谁在碰这条链"，新增一个引用点就得在这里给结论'
        }
    };

    function referencingFiles() {
        const root = path.join(serverRoot, 'game');
        const hits = [];
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                if (fs.statSync(full).isDirectory()) { walk(full); continue; }
                if (!name.endsWith('.js')) continue;
                const text = fs.readFileSync(full, 'utf8');
                if (/artifact_deep_line|artifactDeepLine|getAllArtifactDeepLineCombatBonuses|mergeDeepLineEffects|__effects/.test(text)) {
                    hits.push(path.relative(serverRoot, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(root);
        return hits.sort();
    }

    test('引用法宝深线的文件逐条要有结论（含战斗侧 consumer）', () => {
        const hits = referencingFiles();
        expect(hits).toEqual(Object.keys(DEEP_LINE_REFERENCES).sort());
        expect(hits.filter(h => h.startsWith('game/combat/'))).toEqual([
            'game/combat/CombatResolver.js',
            'game/combat/skillEffects.js'
        ]);
    });

    test('控制跑：扫描器在别的文件里点名法宝深线时看得见（否则本组是空转）', () => {
        const providers = fs.readFileSync(path.join(serverRoot, 'game/stats/providers.js'), 'utf8');
        expect(providers).toMatch(/getAllArtifactDeepLineCombatBonuses/);
        expect(providers).toMatch(/raw\.absolute/);
        expect(providers).toMatch(/raw\.percent/);
        // effects 在 provider 里只出现在 info 一侧，不在 mods 一侧
        const infoBlock = providers.slice(providers.indexOf('info: (_raw, ctx) => (ctx.artifactDeepLine'));
        expect(infoBlock.slice(0, 260)).toMatch(/effects/);
        const collectBlock = providers.slice(providers.indexOf('collect: (ctx) => suppliedOr(ctx, \'artifact_deep_line\''),
            providers.indexOf('info: (_raw, ctx) => (ctx.artifactDeepLine'));
        expect(collectBlock).not.toMatch(/mods\..*effects|effects.*=>.*mods/);
    });

    /**
     * 2026-09-22 更新过结论：面板不再自己写死那三个字段名（清单改由服务端按 BONUS_ROUTES 下发，
     * 见 tests/DeepLineBonusDisplay.test.js）。这一组原来判的"面板把它们当承诺印给玩家"现在分成两半：
     *   · 仍然成立的那半 —— 这三档**确实印给了玩家**（名字出自内容 bonus_field_labels），所以"给了没有"
     *     仍是缺陷而不是"根本没写"；战斗侧依旧一条引用都没有（下面的 game/combat 判据）。
     *   · 已经被改掉的那半 —— 印出去的同时必须说清"这档今天不进战斗"（applied=false → 界面灰字 + 未生效），
     *     所以旧版那种"涂成绿色 +X%"的谎已经没有了。这条测试同时钉住这两半，别让它退回任意一边。
     */
    test('吸血/暴击/暴伤已折进属性档（applied=true），反噬仍走 effects 且已接战斗', () => {
        const { infrastructure } = require('../modules');
        const Svc = require('../game/services/ArtifactDeepLineService');
        const labels = infrastructure.ConfigLoader.getConfig('artifact_deep_lines').bonus_field_labels;
        for (const field of ['hp_steal_bonus_rate', 'crit_rate_bonus', 'crit_damage_bonus']) {
            expect(String(labels[field] || '')).toMatch(/./);          // 玩家看得见这一档
            const row = Svc.combatBonusDisplay('blood_sword', { [field]: 0.05 })
                .find(r => r.key === field);
            expect(row.bucket).toBe('absolute');
            expect(row.applied).toBe(true);
        }
        // 反噬仍在 effects 桶，但已接进战斗特效表
        const backlash = Svc.combatBonusDisplay('blood_sword', { blood_backlash_hp_rate_per_round: 0.05 })
            .find(r => r.key === 'blood_backlash_hp_rate_per_round');
        expect(backlash.bucket).toBe('effects');
        expect(backlash.applied).toBe(true);
        const panel = fs.readFileSync(path.join(serverRoot, '..',
            'client/src/components/panels/BloodSwordPanel.vue'), 'utf8');
        expect(panel).toMatch(/b\.applied/);
        // 面板退回自己点名字段 = 那次谎的成因又回来了
        expect(panel).not.toMatch(/hp_steal_bonus_rate|crit_rate_bonus|crit_damage_bonus/);
    });
});

describe('6. 同类形状：自称"供属性引擎调用"的聚合器必须真挂在引擎上', () => {
    /** 聚合器 → 归宿；provider 为 null 的逐条说明为什么还没接 */
    const COMBAT_BONUS_AGGREGATORS = {
        'ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses': { provider: 'artifact_deep_line' },
        'ArtifactSpiritService.getCombatBonus': {
            provider: 'artifact_spirit',
            reason: '2026-09-23 接线：providers.js artifact_spirit 来源。出参对齐注册表 —— '
                + 'atk/def 走 percent 小数倍率，crit_rate/dodge_rate 走 absolute 百分点（flat_only）'
        }
    };

    test('控制跑：扫描器确实认识这两个聚合器的形状（空扫描就是假绿）', () => {
        const spirit = fs.readFileSync(path.join(serverRoot, 'game/services/ArtifactSpiritService.js'), 'utf8');
        expect(spirit).toMatch(/async\s+getCombatBonus\s*\(/);
        expect(spirit).toMatch(/供 providers\.js 的 artifact_spirit 来源调用/);
        // 键名必须对齐注册表，不能再写 percent.crit / percent.dodge
        expect(spirit).toMatch(/absolute:\s*\{[^}]*crit_rate:/);
        expect(spirit).toMatch(/percent:\s*\{[^}]*atk:/);
        expect(spirit).not.toMatch(/percent:\s*\{[^}]*crit:/);
        expect(spirit).not.toMatch(/percent:\s*\{[^}]*dodge:/);
        const deep = fs.readFileSync(path.join(serverRoot, 'game/services/ArtifactDeepLineService.js'), 'utf8');
        expect(deep).toMatch(/static\s+async\s+getAllArtifactDeepLineCombatBonuses\s*\(/);
    });

    test('每个聚合器的归宿都登记在案，登记的 provider 必须真在属性引擎里', () => {
        const ids = new Set(buildProviders(statRegistry, makeRealConfigLoader(content)).map(p => p.id));
        expect(ids.size).toBeGreaterThanOrEqual(11);
        for (const [name, entry] of Object.entries(COMBAT_BONUS_AGGREGATORS)) {
            if (!entry.provider) {
                expect(entry.verdict).toBe('orphan_pending_owner_decision');
                expect(entry.reason.length).toBeGreaterThan(60);
                continue;
            }
            expect(ids.has(entry.provider)).toBe(true);
            const providersSrc = fs.readFileSync(path.join(serverRoot, 'game/stats/providers.js'), 'utf8');
            expect(providersSrc).toContain(name.split('.')[1]);
        }
    });
});

/**
 * 第 7 组：来源清单本身搬进内容（2026-09-22）
 *
 * 第 1~2 组已经把"字段该进哪个桶"做成表了，但**有哪几条法宝线参与聚合**还写死在聚合器里
 * （`Promise.all([getBloodSword..., getXutian..., getFiveElementWheel...])` + 三段 if）。
 * 那意味着业主加第四条深线（或资料片加）时，仍然要回来改这个聚合器 —— 正是"一个物品加了东西、
 * 很多位置都要改"的形状。现在清单住在 `artifact_deep_lines.combat_bonus_sources`（登记成集合，
 * 按 key 追加），聚合器只按表逐条取数。
 *
 * 零数值漂移不靠"看起来一样"：把**改造前那段代码原样抄进测试**当参照实现，
 * 对同一批 stub 返回值逐场景比对，两边必须一模一样。
 */
describe('7. 来源清单在内容里：聚合器不再点名具体法宝', () => {
    const Service = ArtifactDeepLineService;

    /** 改造前的实现（逐行抄自 git 里的那一版），只用来当参照 */
    async function oldAggregate(stubs) {
        const wrap = (fn, fallback) => Promise.resolve().then(() => fn()).catch(() => fallback);
        const [bloodSwordBonus, xutianCauldronBonus, wheelBonus] = await Promise.all([
            wrap(stubs.getBloodSwordCombatBonus, { is_active: false }),
            wrap(stubs.getXutianCauldronCombatBonus, { is_active: false }),
            wrap(stubs.getFiveElementWheelCombatBonus, { has_wheel: false, combat_bonus: {} })
        ]);
        const absolute = { atk: 0, def: 0, hp_max: 0, speed: 0, mp_max: 0, sense: 0, luck: 0, wisdom: 0 };
        const percent = { atk: 0, def: 0, hp_max: 0, speed: 0 };
        const effects = {
            crit_rate_bonus: 0, crit_damage_bonus: 0, hp_steal_bonus_rate: 0, damage_reduction_rate: 0,
            hp_regen_bonus_rate: 0, backlash_rate_per_round: 0, backlash_target: 'none',
            wheel_spin_enabled: false, active_sources: []
        };
        const breakdown = {};
        const acc = { absolute, percent, effects, unconsumed: [] };
        if (bloodSwordBonus.is_active) {
            breakdown.blood_sword = bloodSwordBonus;
            effects.active_sources.push('blood_sword');
            Service._routeBonusFields('blood_sword', bloodSwordBonus, acc);
            if (bloodSwordBonus.blood_backlash_hp_rate_per_round > 0) effects.backlash_target = 'self';
        }
        if (xutianCauldronBonus.is_active) {
            breakdown.xutian_cauldron = xutianCauldronBonus;
            effects.active_sources.push('xutian_cauldron');
            Service._routeBonusFields('xutian_cauldron', xutianCauldronBonus, acc);
            if (xutianCauldronBonus.backlash_rate_per_round > 0) {
                effects.backlash_target = xutianCauldronBonus.backlash_target || 'self';
            }
        }
        if (wheelBonus.has_wheel) {
            breakdown.five_element_wheel = wheelBonus;
            effects.active_sources.push('five_element_wheel');
            effects.wheel_spin_enabled = !!wheelBonus.wheel_spin_enabled;
            Service._routeBonusFields('five_element_wheel', wheelBonus.combat_bonus || {}, acc);
        }
        return {
            is_active: effects.active_sources.length > 0, absolute, percent, effects, breakdown,
            unconsumed: acc.unconsumed
        };
    }

    const BLOOD = {
        atk_bonus_rate: 0.08, hp_steal_bonus_rate: 0.03, def_bonus_rate: 0.05,
        crit_rate_bonus: 1.5, crit_damage_bonus: 6, blood_backlash_hp_rate_per_round: 0.4, is_active: true
    };
    const CAULDRON = {
        is_active: true, def_bonus: 120, atk_bonus: 80, final_atk_bonus: 96,
        backlash_rate_per_round: 1.2, backlash_target: 'enemy'
    };
    const WHEEL = {
        has_wheel: true, wheel_spin_enabled: true,
        combat_bonus: {
            atk_bonus_rate: 0.07, def_bonus_rate: 0.05, hp_max_bonus_rate: 0.04, speed_bonus_rate: 0.03,
            crit_rate_bonus: 1, crit_damage_bonus: 2, hp_regen_bonus_rate: 1, damage_reduction_rate: 2,
            [`${NEW_STAT}_bonus`]: 40
        }
    };
    const OFF = { is_active: false };
    const NO_WHEEL = { has_wheel: false };

    /** 把三个 getter 换成 stub，跑新实现 */
    async function newAggregate(stubs) {
        const real = {};
        for (const name of ['getBloodSwordCombatBonus', 'getXutianCauldronCombatBonus', 'getFiveElementWheelCombatBonus']) {
            real[name] = Service[name];
            Service[name] = async () => {
                const value = stubs[name]();
                if (value instanceof Promise) return value;
                return value;
            };
        }
        try {
            const out = await Service.getAllArtifactDeepLineCombatBonuses(1);
            delete out.source_problems;                       // 参照实现没有这个新字段，比对时剔掉
            return out;
        } finally {
            Object.assign(Service, real);
        }
    }

    const scenarios = {
        '三条全开': { getBloodSwordCombatBonus: () => BLOOD, getXutianCauldronCombatBonus: () => CAULDRON, getFiveElementWheelCombatBonus: () => WHEEL },
        '只血魔剑': { getBloodSwordCombatBonus: () => BLOOD, getXutianCauldronCombatBonus: () => OFF, getFiveElementWheelCombatBonus: () => NO_WHEEL },
        '只虚天鼎（反噬目标=none）': {
            getBloodSwordCombatBonus: () => OFF,
            getXutianCauldronCombatBonus: () => ({ ...CAULDRON, backlash_target: 'none' }),
            getFiveElementWheelCombatBonus: () => NO_WHEEL
        },
        '只幻世轮（没 combat_bonus 键）': {
            getBloodSwordCombatBonus: () => OFF, getXutianCauldronCombatBonus: () => OFF,
            getFiveElementWheelCombatBonus: () => ({ has_wheel: true, wheel_spin_enabled: true })
        },
        '全不生效': { getBloodSwordCombatBonus: () => OFF, getXutianCauldronCombatBonus: () => OFF, getFiveElementWheelCombatBonus: () => NO_WHEEL },
        '血魔剑炸了': {
            getBloodSwordCombatBonus: () => Promise.reject(new Error('背包读不到')),
            getXutianCauldronCombatBonus: () => CAULDRON, getFiveElementWheelCombatBonus: () => WHEEL
        },
        '零值占位键': {
            getBloodSwordCombatBonus: () => ({ ...BLOOD, atk_bonus_rate: 0, crit_rate_bonus: 0, blood_backlash_hp_rate_per_round: 0 }),
            getXutianCauldronCombatBonus: () => ({ ...CAULDRON, backlash_rate_per_round: 0 }),
            getFiveElementWheelCombatBonus: () => ({ ...WHEEL, combat_bonus: { ...WHEEL.combat_bonus, speed_bonus_rate: 0 } })
        }
    };

    for (const [label, stubs] of Object.entries(scenarios)) {
        test(`零数值漂移：${label} —— 新实现与改造前那段代码逐字段相同`, async () => {
            expect(await newAggregate(stubs)).toEqual(await oldAggregate(stubs));
        });
    }

    test('清单来自内容：三条都在，且每条点名的方法在服务上真的存在', () => {
        const { sources, problem } = Service.getCombatBonusSourceRegistry();
        expect(problem).toBeNull();
        expect(sources.map(s => s.key)).toEqual(['blood_sword', 'xutian_cauldron', 'five_element_wheel']);
        for (const src of sources) {
            expect(typeof Service[src.method]).toBe('function');
            expect(typeof src.active_field).toBe('string');
        }
    });

    test('控制跑：清单里写一个不存在的方法，必须点名并让那条线不进账（不是静默少一条）', async () => {
        const real = Service.getCombatBonusSourceRegistry;
        Service.getCombatBonusSourceRegistry = () => ({
            problem: null,
            sources: [{ key: 'probe_line', method: 'noSuchGetter', active_field: 'is_active' }]
        });
        try {
            const out = await Service.getAllArtifactDeepLineCombatBonuses(1);
            expect(out.is_active).toBe(false);
            expect(out.active_sources || out.effects.active_sources).toEqual([]);
            expect(out.source_problems.join(' ')).toMatch(/probe_line.*noSuchGetter/);
        } finally {
            Service.getCombatBonusSourceRegistry = real;
        }
    });

    test('资料片可以只加一条内容就多一条来源（集合登记成按 key 追加，不覆盖前三条）', () => {
        const os = require('os');
        const fixture = path.join(os.tmpdir(), 'xx_deepline_source_fixture');
        fs.rmSync(fixture, { recursive: true, force: true });
        fs.mkdirSync(path.join(fixture, 'fixture_line'), { recursive: true });
        fs.writeFileSync(path.join(fixture, 'fixture_line/pack.json'), JSON.stringify({
            id: 'fixture_line', name: '夹具·新增一条法宝深线', version: '0.0.1', priority: 900, enabled: true, depends: []
        }));
        fs.writeFileSync(path.join(fixture, 'fixture_line/artifact_deep_lines__combat_bonus_sources.json'), JSON.stringify({
            dataset: 'artifact_deep_lines', into: 'combat_bonus_sources',
            add: [{ key: 'bing_po_gu', comment: '冰魄骨：纯数值线', method: 'getProbeLineBonus', active_field: 'is_active', bonus_field: 'bonuses' }]
        }));
        try {
            const { ContentRegistry } = require('../game/content/ContentRegistry');
            const merged = new ContentRegistry({
                configPath: path.join(serverRoot, 'config'), packDir: fixture, statRegistry
            });
            merged.load();
            const list = merged.dataset('artifact_deep_lines').combat_bonus_sources;
            expect(list.map(s => s.key)).toEqual(
                expect.arrayContaining(['blood_sword', 'xutian_cauldron', 'five_element_wheel', 'bing_po_gu'])
            );
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
        }
    });

    test('新来源进账不用改聚合器：stub 一条第四线，它的数值直接进 percent/absolute', async () => {
        const realRegistry = Service.getCombatBonusSourceRegistry;
        const realGetter = Service.getProbeLineBonus;
        Service.getCombatBonusSourceRegistry = () => ({
            problem: null,
            sources: [{
                key: 'bing_po_gu', method: 'getProbeLineBonus', active_field: 'is_active', bonus_field: 'bonuses',
                copy_effects: ['probe_enabled'],
                backlash: { when: 'probe_backlash', value: 'self' }
            }]
        });
        Service.getProbeLineBonus = async () => ({
            is_active: true, probe_enabled: true, probe_backlash: 1,
            // 用一档基础属性验证"新来源的数值直接进账"；资料片新属性那条路第 2、3 组已经端到端钉过
            bonuses: { atk_bonus_rate: 0.05, luck_bonus: 30 }
        });
        try {
            const out = await Service.getAllArtifactDeepLineCombatBonuses(1);
            expect(out.effects.active_sources).toEqual(['bing_po_gu']);
            expect(out.percent.atk).toBeCloseTo(0.05, 10);
            expect(out.absolute.luck).toBe(30);
            expect(out.effects.wheel_spin_enabled).toBe(false);   // 没声明的开关不该被别的线带进来
            expect(out.unconsumed).toEqual([]);
            // copy_effects 与 backlash 两条声明都真的生效（这才叫"新线只写内容"）
            const real2 = Service.getProbeLineBonus;
            Service.getProbeLineBonus = async () => ({ is_active: true, probe_enabled: true, probe_backlash: 2, bonuses: {} });
            const second = await Service.getAllArtifactDeepLineCombatBonuses(1);
            expect(second.effects.wheel_spin_enabled).toBe(false);
            expect(second.effects.backlash_target).toBe('self');
            Service.getProbeLineBonus = real2;
        } finally {
            Service.getCombatBonusSourceRegistry = realRegistry;
            Service.getProbeLineBonus = realGetter;
        }
    });
});
