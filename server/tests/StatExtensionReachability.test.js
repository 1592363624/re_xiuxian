/**
 * "给一把刀加一个新属性"这条路的端到端验收（objective 里的原话场景）。
 *
 * 断言的形状：一个资料片只写内容 —— 新属性定义 + 带该属性的武器 + 用该属性当攻击项的战斗档位 ——
 * 不改任何代码，就要能：词表认得它、属性引擎算得出它、面板 schema 列得出它、战斗公式打得动它。
 * 以前这些环节里只要有一处写着"认识的属性名清单"，新属性就会静默变成 0（面板不显示、战斗不生效）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');
const { StatEngine } = require('../game/stats/StatEngine');
const { infrastructure } = require('../modules');

const loader = infrastructure.ConfigLoader;
const REAL_CONFIG = path.join(__dirname, '..', 'config');

const PACK = {
    'pack.json': { id: 'stat_probe', name: '属性探针', version: '1.0.0' },
    'stat_definitions__stats.json': {
        add: [{
            key: 'probe_pierce', label: '破阵', group: 'offense', unit: 'point',
            agg: 'flat_then_pct', base: { default: 0 },
            panel: { visible: true, order: 990 }, powerWeight: 0.2,
            battleRoles: ['attack_probe'], description: '探针属性'
        }]
    },
    'item_data__items.json': {
        add: [{ id: 'probe_blade', name: '试剑刀', type: 'equipment', subtype: 'weapon', effect: { probe_pierce: 77, atk: 10 }, price: 100 }]
    },
    'combat_formulas__profiles.json': {
        add: [{
            id: 'probe_duel', label: '探针档位', attack_stat: 'probe_pierce', mitigate_stat: 'def',
            skill_multiplier: 1, defense_coef: 1, min_damage: 1
        }]
    }
};

function buildProbeContent() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-stat-'));
    const packDir = path.join(root, 'packs');
    const packRoot = path.join(packDir, 'stat_probe');
    fs.mkdirSync(packRoot, { recursive: true });
    for (const [name, data] of Object.entries(PACK)) {
        fs.writeFileSync(path.join(packRoot, name), JSON.stringify(data));
    }
    const statRegistry = new StatRegistry();
    const content = new ContentRegistry({ configPath: REAL_CONFIG, packDir, statRegistry });
    content.load();
    if (!content.packs.length) throw new Error('探针资料片没被发现，这条验收会是空测');
    return { content, statRegistry, root };
}

/** 只在一次断言里让某个数据集读到探针合并视图 */
function withDataset(name, value, run) {
    const original = loader.getConfig;
    loader.getConfig = (n) => (n === name ? value : original.call(loader, n));
    try {
        return run();
    } finally {
        loader.getConfig = original;
    }
}

describe('新属性只要写在内容里，整条链就该认识它', () => {
    test('资料片加一个属性 + 一把带该属性的武器：启动期校验全过（效果词表跟着属性走）', () => {
        const { content } = buildProbeContent();
        expect(content.dataset('item_data').items.find(i => i.id === 'probe_blade')).toBeTruthy();
        // 反证：属性没声明时，同一件武器的 effect 键就是非法的（见下一个用例）
    });

    test('没声明的属性名当效果 → 启动期就抛（证明上一条不是空测）', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-badstat-'));
        const packDir = path.join(root, 'packs');
        const packRoot = path.join(packDir, 'bad_stat');
        fs.mkdirSync(packRoot, { recursive: true });
        fs.writeFileSync(path.join(packRoot, 'pack.json'), JSON.stringify({ id: 'bad_stat', name: '坏探针', version: '1.0.0' }));
        fs.writeFileSync(path.join(packRoot, 'item_data__items.json'), JSON.stringify({
            add: [{ id: 'ghost_blade', name: '幽灵刀', type: 'equipment', subtype: 'weapon', effect: { totally_unknown_stat: 5 }, price: 1 }]
        }));
        const content = new ContentRegistry({ configPath: REAL_CONFIG, packDir, statRegistry: new StatRegistry() });
        expect(() => content.load()).toThrow(/totally_unknown_stat/);
    });

    test('属性词表：新属性能被解析，标签取自内容', () => {
        const { statRegistry } = buildProbeContent();
        expect(statRegistry.has('probe_pierce')).toBe(true);
        const def = statRegistry.get('probe_pierce');
        expect(def.label).toBe('破阵');
        expect(statRegistry.all().map(d => d.key)).toContain('probe_pierce');
    });

    test('属性引擎：一个只存在于内容的属性算得出来（provider 给 77，最终就是 77）', () => {
        const { statRegistry } = buildProbeContent();
        const engine = new StatEngine(statRegistry);
        engine.registerProvider({
            id: 'probe_equipment', label: '探针装备', order: 5,
            collect: () => ({ probe_pierce: { flat: 77 }, atk: { flat: 10 } })
        });
        const ctx = { player: { realm: '炼气初期', realm_rank: 1, attributes: {} }, configLoader: loader };
        const resolved = engine.resolveStatic(ctx);
        expect(resolved.final.probe_pierce).toBe(77);
        expect(resolved.breakdown.probe_pierce.sources).toEqual(
            expect.arrayContaining([expect.objectContaining({ from: 'probe_equipment', flat: 77 })])
        );
        expect(resolved.meta.unknown_stat_keys).not.toContain('probe_pierce');
        // 面板 schema：新属性按内容自己的 panel.visible 出现在可见清单里，客户端不用改代码
        expect(engine.registry.panelStats().map(d => d.key)).toContain('probe_pierce');
    });

    test('战斗公式：把新属性当攻击项的档位能结算，且与"换个属性名的同形状档位"数值一致', () => {
        const { content } = buildProbeContent();
        const CombatResolver = require('../game/combat/CombatResolver');
        CombatResolver.initialize(loader);        // 不装就用不到 configLoader，会退回兜底常量表
        const formulas = content.dataset('combat_formulas');
        const probe = pickProfile(content, 'probe_duel');
        expect(probe).toBeTruthy();
        // 同一条公式，只把攻击项换成代码里早就认识的 atk：结果必须一模一样，
        // 否则说明公式里存在"按属性名分支"的代码，新属性会被算成 0。
        const alias = { ...probe, attack_stat: 'atk' };
        const patched = { ...formulas, profiles: { ...formulas.profiles, probe_duel_alias: alias } };

        const withProbe = withDataset('combat_formulas', formulas, () =>
            CombatResolver.computeDamage('probe_duel', {
                attackerStats: { probe_pierce: 77 }, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
            }));
        const withAlias = withDataset('combat_formulas', patched, () =>
            CombatResolver.computeDamage('probe_duel_alias', {
                attackerStats: { atk: 77 }, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
            }));

        expect(withProbe.profile).toBe('probe_duel');
        expect(withProbe.attack).toBe(77);
        expect(withProbe.damage).toBeGreaterThan(0);
        expect(withProbe.damage).toBe(withAlias.damage);
    });
});

/** profiles 合并后是对象映射；取一条档位用于对照 */
function pickProfile(content, key) {
    const profiles = content.dataset('combat_formulas').profiles;
    return Array.isArray(profiles) ? profiles.find(p => p.id === key) : profiles[key];
}
