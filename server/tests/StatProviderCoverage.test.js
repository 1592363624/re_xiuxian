/**
 * 属性来源覆盖率门禁：任何一个 provider 都不允许"配了但永远不产出"
 *
 * 起因：spirit_root provider 读的是 player.spirit_root，而模型里根本没有这一列，
 * 于是 role_init.spiritRootBonuses 整张表对所有真实玩家静默返回空 —— 373 个测试全绿。
 * 那一类缺陷的共同特征是：字段名/形状对不上时不报错，只是加成永远是 0。
 *
 * 所以这里给每个来源都钉一个"喂给它本该认识的数据，就必须真的改变最终属性"的用例。
 * 新增来源时在这里加一行，否则它和没接一样。
 */
'use strict';

const path = require('path');

const { statRegistry } = require('../game/stats');
const { buildProviders } = require('../game/stats/providers');
const AttributeService = require('../game/core/AttributeService');
const { loadRealContent, makeRealConfigLoader, emptySources } = require('./helpers/realContent');

const content = loadRealContent(statRegistry);
const roleInit = require(path.join(__dirname, '..', 'config', 'role_init.json'));
const talents = content.dataset('talents');
const titles = content.dataset('titles');

beforeAll(() => {
    AttributeService.initialize(makeRealConfigLoader(content));
});

afterEach(() => {
    AttributeService._engine = null;
});

const basePlayer = (over = {}) => ({
    id: 4242,
    realm: '元婴初期',
    realm_rank: 21,
    talent_id: null,
    equipped_title_id: null,
    spirit_roots: {},
    attributes: {},
    ...over
});

async function resolve(player, overrides = {}) {
    return AttributeService.calculateFullAttributesAsync(
        player, { sourceOverrides: emptySources(overrides) }
    );
}

/**
 * 每个用例：给某一个来源喂一份它应当认得的输入，然后要求
 *   1. 该来源的 breakdown 分组里出现非零贡献
 *   2. 最终属性相对"该来源为空"的基线确实变了
 */
const CASES = [
    {
        id: 'spirit_root', group: 'spirit_root', stat: 'atk',
        player: basePlayer({ spirit_roots: { type: 'fire' } })
    },
    {
        id: 'allocated', group: 'allocated', stat: 'def',
        player: basePlayer({ attributes: { def_bonus: 21 } })
    },
    {
        id: 'talent', group: 'talent', stat: 'cultivate_speed',
        player: basePlayer({ talent_id: (talents.find(t => t.bonuses?.cultivate_speed_pct) || {}).id })
    },
    {
        id: 'title', group: 'title', stat: 'sense',
        player: basePlayer({ equipped_title_id: (titles.find(t => t.bonuses?.sense) || {}).id })
    },
    {
        id: 'equipment', group: 'equipment', stat: 'atk',
        player: basePlayer(), overrides: { equipment: { atk: 13 } }
    },
    {
        id: 'spirit_beast', group: 'spirit_beast', stat: 'hp_max',
        player: basePlayer(), overrides: { spirit_beast: { hp_max: 250 } }
    },
    {
        // 这一组的 legacy 契约是 { is_active, absolute, percent, effects, sources }，不是按属性平铺，
        // 所以贡献值要从 absolute 里取——这是法宝深线自己的历史形状，改造时刻意保持了兼容。
        id: 'artifact_deep_line', group: 'artifact_deep_line', stat: 'speed',
        read: g => g?.absolute?.speed,
        player: basePlayer(),
        overrides: {
            artifact_deep_line: {
                is_active: true, absolute: { speed: 7 }, percent: {}, effects: {}, breakdown: {}
            }
        }
    },
    {
        id: 'technique', group: 'cultivation', stat: 'mp_max',
        player: basePlayer(), overrides: { technique: { mp_max: 60 } }
    },
    {
        id: 'puppet', group: 'puppet', stat: 'atk',
        player: basePlayer(), overrides: { puppet: { atk: 9, def: 0, hp: 0, speed: 0 } }
    },
    {
        // 夺舍继承：住在 attributes.reincarnation_bonus 里的一份独立账（不占玩家加点的 *_bonus 存储位）。
        id: 'reincarnation', group: 'reincarnation', stat: 'atk',
        player: basePlayer({ attributes: { reincarnation_bonus: { atk: 17 } } })
    }
];

describe('每个属性来源都必须真的产出加成', () => {
    test('来源清单齐全（清单取自 providers.js 真实构建结果，新增 provider 必须在这里加一行）', () => {
        // 这条断言以前比的是**另一份手抄的字符串数组**，于是"加了 provider 忘了加用例"
        // 正好落在两份清单之间：测试绿、来源空转（spirit_root 那个原始缺陷就是这么溜过去的）。
        // 现在直接数引擎真正装配出来的 provider，谁都别想悄悄少测一个。
        const built = buildProviders(statRegistry, makeRealConfigLoader(content));
        const realIds = built.map(p => p.id).sort();
        expect(realIds.length).toBeGreaterThanOrEqual(10);       // 防空跑：装配不出来时别让断言退化成"两边都空"
        expect(CASES.map(c => c.id).sort()).toEqual(realIds);
        for (const p of built) {
            expect(typeof p.id).toBe('string');
            expect(typeof p.label).toBe('string');               // 没有 label 的来源在"加成来自哪里"列表里是隐形的
        }
    });

    /**
     * 存在意义：ReincarnationService 要用"把夺舍这一档清零后重算一遍"才知道本次该补多少差值。
     * 第一版的 reincarnation provider 直接读 blob、不认 sourceOverrides，那条路是假的：
     * 第二次夺舍把上一次的账算成"已经有的"，于是补 0、又把旧账整块换掉，玩家凭空掉一截属性。
     */
    test('blob 类来源必须能被 sourceOverrides 清零（夺舍服务靠这个"排除自己这一档"重算）', async () => {
        const fed = basePlayer({ attributes: { reincarnation_bonus: { atk: 17 } } });
        const baseline = await resolve(basePlayer({ attributes: {} }), {});
        const withSource = await resolve(fed, {});
        const zeroed = await resolve(fed, { reincarnation: {} });
        expect(withSource.final.atk).toBeGreaterThan(baseline.final.atk);
        expect(zeroed.final.atk).toBe(baseline.final.atk);
    });

    for (const testCase of CASES) {        test(`${testCase.id} → 进入 breakdown.${testCase.group} 并改变 final.${testCase.stat}`, async () => {
            expect(testCase.player[testCase.id === 'allocated' ? 'attributes' : 'id']).toBeTruthy();

            const withSource = await resolve(testCase.player, testCase.overrides || {});
            const baselinePlayer = { ...testCase.player };
            if (testCase.id === 'spirit_root') baselinePlayer.spirit_roots = {};
            // 这两个来源都从 attributes blob 里取数，基线要把整块 blob 清空，
            // 否则"基线"里还带着被测来源，差值永远是 0（这条测试就退化成空跑）。
            if (testCase.id === 'allocated' || testCase.id === 'reincarnation') baselinePlayer.attributes = {};
            if (testCase.id === 'talent') baselinePlayer.talent_id = null;
            if (testCase.id === 'title') baselinePlayer.equipped_title_id = null;
            // 基线必须把所有来源都置空，否则"基线"里也带着被测来源，差值永远是 0
            const baseline = await resolve(baselinePlayer, {});

            const group = withSource.breakdown[testCase.group];
            const contribution = testCase.read ? testCase.read(group) : group?.[testCase.stat];
            expect(contribution).toBeTruthy();
            expect(withSource.final[testCase.stat]).toBeGreaterThan(baseline.final[testCase.stat]);
        });
    }
});

describe('内容里的加成键必须都能被解析（拼错的键等于没配）', () => {
    test('天赋与称号的每个 bonus 键都是注册过的属性或其 _pct 形式', () => {
        const offenders = [];
        for (const [kind, list] of [['talents', talents], ['titles', titles]]) {
            for (const entry of list) {
                for (const key of Object.keys(entry.bonuses || {})) {
                    const statKey = key.endsWith('_pct') ? key.slice(0, -4) : key;
                    if (!statRegistry.resolveStatKey(statKey)) {
                        offenders.push(`${kind}.${entry.id} → ${key}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('灵根加成表覆盖 role_init 里登记的每一种灵根', () => {
        const missing = roleInit.spirit_roots
            .map(r => r.name)
            .filter(name => !roleInit.spiritRootBonuses[name]);
        expect(missing).toEqual([]);
    });
});
