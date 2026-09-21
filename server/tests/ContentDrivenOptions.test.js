/**
 * "选项清单只住在内容里"这一件事的验收测试。
 *
 * 盯的缺陷形状：数据集登记进内容层之后，资料片确实"加得进来"，但如果服务或路由里还抄着一份
 * 主键白名单，新加的那条会在门口被 `dungeon_key 无效` / `切法无效` 挡回来 —— 内容层日志一切正常，
 * 玩法里就是没有。改造前实测有 6 个地方是这种形状（多人副本、钓竿、切法、器灵类型、阵法流派、
 * 元神调度模式），现在都由内容驱动；本文件把"加一条内容就认得它"钉住，
 * 与之配套的静态闸是 tests/ContentIntegrity.test.js 里的"内容主键不许在代码里枚举"。
 */
'use strict';

const { infrastructure, initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');

const loader = infrastructure.ConfigLoader;

/** 只在一次断言里给某个数据集追加内容（不改动真实配置文件，也不影响别的用例） */
function withExtraContent(overrides, run) {
    const original = loader.getConfig;
    loader.getConfig = (name) => {
        const base = original.call(loader, name);
        const extend = overrides[name];
        return base && extend ? extend(base) : base;
    };
    try {
        return run();
    } finally {
        loader.getConfig = original;
    }
}

beforeAll(async () => {
    await initializeModules();
    ensureStatRegistryLoaded();
});

describe('加一条内容 = 玩法立刻认得它', () => {
    test('多人副本：新增一个副本键后，创建/领奖/GM 的校验都放行（以前白名单抄在 4 处）', () => {
        const MultiDungeonService = require('../game/services/MultiDungeonService');
        expect(MultiDungeonService.invalidDungeonKey('probe_new_dungeon')).not.toBeNull();
        const accepted = withExtraContent({
            multi_dungeon_data: (base) => ({
                ...base,
                dungeons: { ...base.dungeons, probe_new_dungeon: { id: 'probe_new_dungeon', name: '试剑副本' } }
            })
        }, () => MultiDungeonService.invalidDungeonKey('probe_new_dungeon'));
        expect(accepted).toBeNull();
        // 提示文案也跟着内容走：新副本的名字出现在给操作者的提示里
        const hint = withExtraContent({
            multi_dungeon_data: (base) => ({
                ...base, dungeons: { probe_new_dungeon: { id: 'probe_new_dungeon', name: '试剑副本' } }
            })
        }, () => MultiDungeonService.invalidDungeonKey('wrong').message);
        expect(hint).toContain('试剑副本');
        expect(hint).not.toContain('yanyue');
    });

    test('钓竿：按内容里的 tier 排序，加一根第五阶的竿就接在最后（以前那份列表抄了 4 遍）', () => {
        const FishingService = require('../game/services/FishingService');
        const previous = FishingService._config;
        try {
            FishingService._config = { rods: { a: { tier: 3 }, b: { tier: 1 }, c: { tier: 2 } } };
            expect(FishingService._rodKeys()).toEqual(['b', 'c', 'a']);
            expect(FishingService._rodKeyForTier(2)).toBe('c');
            expect(FishingService._rodKeyForTier(4)).toBeNull();     // 超出内容里的竿数 = 已经最高
            expect(FishingService._starterRod()).toBe(FishingService._config.rods.b);
        } finally {
            FishingService._config = previous;
        }
    });

    test('赌石：切法与品质档位都取自内容，品质按 tier 排而不是按写死的顺序', () => {
        const GamblingStoneService = require('../game/services/GamblingStoneService');
        const previous = GamblingStoneService._config;
        try {
            GamblingStoneService._config = {
                cut_methods: { rough: {}, fine: {}, divine_sense: {}, array: {} },
                qualities: { dust: { tier: 1 }, spirit_vein: { tier: 4 }, common: { tier: 2 } }
            };
            expect(GamblingStoneService.cutMethodKeys()).toEqual(['rough', 'fine', 'divine_sense', 'array']);
            expect(GamblingStoneService._qualityKeys()).toEqual(['dust', 'common', 'spirit_vein']);
        } finally {
            GamblingStoneService._config = previous;
        }
    });

    test('器灵类型：资料片加一档器灵，路由的校验跟着放行', () => {
        const artifactSpiritService = require('../game/services/ArtifactSpiritService');
        const baseTypes = artifactSpiritService.spiritTypeKeys();
        expect(baseTypes.length).toBeGreaterThanOrEqual(4);
        expect(artifactSpiritService.spiritTypeKeys().includes('probe_soul_type')).toBe(false);
        const got = withExtraContent({
            artifact_spirit_data: (base) => ({
                ...base, spirit_types: { ...base.spirit_types, probe_soul_type: { name: '试剑器灵' } }
            })
        }, () => ({
            keys: artifactSpiritService.spiritTypeKeys(),
            valid: artifactSpiritService._isValidSpiritType('probe_soul_type')
        }));
        expect(got.keys).toContain('probe_soul_type');
        expect(got.valid).toBe(true);
    });

    test('阵法流派：内容里多一档流派（category_display_names）就承认它', () => {
        const FormationService = require('../game/services/FormationService');
        expect(FormationService.formationCategories()).toEqual(
            expect.arrayContaining(['attack', 'defense', 'support', 'special'])
        );
        const got = withExtraContent({
            formation_data: (base) => ({
                ...base,
                global: { ...base.global, category_display_names: { ...base.global.category_display_names, poison: '毒' } }
            })
        }, () => FormationService.formationCategories());
        expect(got).toContain('poison');
    });

    test('第二元神调度：内容里加一种模式就可用（以前路由与服务各写了一份四种模式）', () => {
        const SecondSoulService = require('../game/services/SecondSoulService');
        expect(SecondSoulService.dispatchModeKeys()).toEqual(
            expect.arrayContaining(['combat', 'cultivate', 'scout', 'defend'])
        );
        const got = withExtraContent({
            late_stage_data: (base) => ({
                ...base,
                second_soul: {
                    ...base.second_soul,
                    dispatch_modes: { ...base.second_soul.dispatch_modes, alchemy: { name: '炼丹', duration_hours: 4 } }
                }
            })
        }, () => SecondSoulService.dispatchModeKeys());
        expect(got).toContain('alchemy');
    });

    test('慕兰战线：加一条后勤路线就有键名也有中文名（以前路线清单与中文名各抄了一份在代码里）', () => {
        const BorderMilitaryService = require('../game/services/BorderMilitaryService');
        const baseKeys = BorderMilitaryService.supportRouteKeys();
        expect(baseKeys).toEqual(expect.arrayContaining(['scout', 'lamp_breaker', 'array_guard', 'raid']));
        expect(baseKeys).not.toContain('lamp_supply');
        // support_routes 里的 _comment 是说明键，不能被当成一条路线
        expect(baseKeys).not.toContain('_comment');
        expect(BorderMilitaryService._routeName('scout')).toBe('斥候');

        const extra = (base) => ({
            ...base,
            support_routes: { ...base.support_routes, lamp_supply: { id: 'lamp_supply', name: '灯油转运' } }
        });
        const keys = withExtraContent({ border_military_data: extra }, () => BorderMilitaryService.supportRouteKeys());
        expect(keys).toContain('lamp_supply');
        // 名字取自内容：旧实现那里是一张写死的 {scout:'斥候',...}，新路线在军议里只会显示成裸键名
        expect(withExtraContent({ border_military_data: extra }, () => BorderMilitaryService._routeName('lamp_supply')))
            .toBe('灯油转运');
    });

    test('洞府设施：清单取自内容，去掉一条就没有这条（以前五把键抄在三个文件里）', () => {
        const { resetLogOnce } = require('../utils/logOnce');
        resetLogOnce();
        const CaveService = require('../game/services/CaveService');
        const PlayerCave = require('../models/playerCave');
        CaveService.initialize(loader);
        const declared = Object.keys(loader.getConfig('cave_data').cave.facilities);
        expect(declared.length).toBeGreaterThan(0);
        // 现网这五条都真有 <key>_level 列，所以交集就是全部 —— 这条断言防的是"交集算错成空集"
        expect(CaveService.getFacilityTypes()).toEqual(declared);
        for (const key of declared) {
            expect(Object.keys(PlayerCave.rawAttributes)).toContain(`${key}_level`);
        }

        // 内容里删一条，清单立刻少一条：证明清单真跟着内容走，而不是代码里还藏着一份
        const fewer = (base) => {
            const facilities = { ...base.cave.facilities };
            delete facilities.grand_formation;
            return { ...base, cave: { ...base.cave, facilities } };
        };
        const shrunk = withExtraContent({ cave_data: fewer }, () => CaveService.getFacilityTypes());
        expect(shrunk).not.toContain('grand_formation');
        expect(shrunk).toHaveLength(declared.length - 1);
    });

    test('洞府设施：内容加了但没有等级列时，宁可不显示也要响一句（不摆"看得见点不动"的设施）', () => {
        const { resetLogOnce } = require('../utils/logOnce');
        resetLogOnce();
        const CaveService = require('../game/services/CaveService');
        CaveService.initialize(loader);
        const errors = [];
        const spy = jest.spyOn(console, 'error').mockImplementation(msg => errors.push(String(msg)));
        let types;
        try {
            const extra = (base) => ({
                ...base,
                cave: {
                    ...base.cave,
                    facilities: { ...base.cave.facilities, probe_forge_room: { name: '符箓阁', max_level: 3 } }
                }
            });
            types = withExtraContent({ cave_data: extra }, () => CaveService.getFacilityTypes());
        } finally {
            spy.mockRestore();
        }
        expect(types).not.toContain('probe_forge_room');
        const hits = errors.filter(msg => msg.includes('facility_without_column'));
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('player_caves');
    });
});
