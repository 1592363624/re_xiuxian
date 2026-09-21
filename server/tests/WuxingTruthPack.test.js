/**
 * 资料片「五行真解」端到端验收：两个资料片互相组合，代码零改动
 *
 * 这个文件专门盯"扩展已有内容"这一半承诺：
 *   - 新属性来自 wuxing_truth，新伤害公式的防御端 element_resist 来自 fanren_legacy，
 *     一条公式横跨两个资料片还能算，说明词表是真的合并成了一份，而不是各读各的。
 *   - 天火剑是基础配置里"只有攻击和速度"的旧武器，资料片只写一条 override 就多了五行之力，
 *     并且原有的 atk/speed 不能被抹掉（一层深合并）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const CombatResolver = require('../game/combat/CombatResolver');
const { serverRoot, loadRealContent, makeRealConfigLoader, emptySources } = require('./helpers/realContent');

let content;

beforeAll(() => {
    content = loadRealContent(statRegistry);
});

beforeEach(() => {
    AttributeService.initialize(makeRealConfigLoader(content));
    CombatResolver.initialize(makeRealConfigLoader(content));
    AttributeService._engine = null;
});

const player = (over = {}) => ({
    id: 9,
    realm: '元婴初期',
    realm_rank: 21,
    spirit_root: '金',
    talent_id: null,
    equipped_title_id: null,
    attributes: {},
    ...over
});

describe('两个资料片并存', () => {
    test('目录扫描同时发现两份资料片，依赖声明被读出来', () => {
        const packs = content.status().packs;
        const fanren = packs.find(p => p.id === 'fanren_legacy');
        const wuxing = packs.find(p => p.id === 'wuxing_truth');
        expect(fanren.enabled).toBe(true);
        expect(wuxing.enabled).toBe(true);
        expect(wuxing.depends).toEqual(['fanren_legacy']);
        expect(wuxing.datasets).toEqual(
            expect.arrayContaining(['combat_formulas', 'crafting_data', 'item_data', 'stat_definitions', 'technique_data'])
        );
    });

    test('新属性进入注册表：面板/加点/丹药/祭炼/战力/战斗角色一次全有', () => {
        expect(statRegistry.has('five_element_power')).toBe(true);
        expect(statRegistry.panelStats().find(s => s.key === 'five_element_power'))
            .toMatchObject({ label: '五行之力', spot: 'detail' });
        expect(statRegistry.allocatableMap().five_element_power).toBe('five_element_power_bonus');
        expect(statRegistry.pillEffectMap().five_element_power).toBe('five_element_power_bonus');
        expect(statRegistry.refineRateMap().five_element_power).toBe(0.04);
        expect(statRegistry.battleRoleIndex().damage_element).toEqual(['five_element_power']);
    });
});

describe('战斗公式也可以被资料片扩展', () => {
    test('合并视图保留基础档位与非集合字段', () => {
        const formulas = content.dataset('combat_formulas');
        expect(Object.keys(formulas.profiles)).toEqual(
            expect.arrayContaining(['player_basic', 'player_skill', 'player_sword_intent', 'player_five_element'])
        );
        // random / formula / power 这些不是集合的顶层字段不能被合并流程吃掉
        expect(formulas.random.player_damage_random_range).toBe(15);
        expect(typeof formulas.formula).toBe('string');
        expect(formulas.power.realm_rank_weight).toBe(100);
    });

    test('新档位攻取本资料片属性、防取另一资料片属性，伤害照样算', () => {
        const strike = CombatResolver.computeDamage('player_five_element', {
            attackerStats: { five_element_power: 90 },
            defenderStats: { element_resist: 12 },
            random: 0.5
        });
        expect(strike.attack).toBe(90);
        // 90 * 1.4 - 12 * 0.6 + floor(0.5 * 15) - 7 = 126 - 7.2 + 0 → floor = 118
        expect(strike.damage).toBe(118);
    });

    test('五行之力计入战力（powerWeight 驱动，不是又一份硬编码权重表）', () => {
        const base = CombatResolver.computePower({ atk: 100 }, 5);
        const withWuxing = CombatResolver.computePower({ atk: 100, five_element_power: 50 }, 5);
        expect(withWuxing).toBeGreaterThan(base);
    });
});

describe('已有内容被扩展而不是被替换', () => {
    test('天火剑加上五行之力，原有攻击/速度仍在（一层深合并）', () => {
        const sword = content.dataset('item_data').items.find(i => i.id === 'skyfire_sword');
        expect(sword.effect).toMatchObject({ atk: 60, speed: 8, five_element_power: 18 });
    });

    test('新物品/新功法/新丹方都进了合并视图', () => {
        const items = content.dataset('item_data').items;
        expect(items.find(i => i.id === 'wuxing_banner').effect)
            .toMatchObject({ five_element_power: 90, element_resist: 12 });

        const tech = content.dataset('technique_data').techniques.wuxing_five_qi;
        expect(tech.bonuses).toMatchObject({ five_element_power: 14, element_resist: 3 });

        const recipe = content.dataset('crafting_data').alchemy_recipes.find(r => r.id === 'craft_five_qi_pill');
        expect(recipe.product.item_key).toBe('five_qi_pill');
        // 丹方产物必须是真实存在的物品，否则引用完整性检查早就在 load() 里抛过了
        expect(items.find(i => i.id === 'five_qi_pill')).toBeTruthy();
    });

    test('修成五气朝元功即获得新属性：功法→属性→面板全程无新增代码', async () => {
        const tech = content.dataset('technique_data').techniques.wuxing_five_qi;
        const resolve = extra => AttributeService.calculateFullAttributesAsync(
            player(), { sourceOverrides: emptySources(extra) }
        );

        const before = (await resolve()).final;
        const after = (await resolve({ technique: tech.bonuses })).final;

        expect(before.five_element_power || 0).toBe(0);
        expect(after.five_element_power).toBeGreaterThanOrEqual(14);
    });
});

describe('资料片文件可解析', () => {
    test('wuxing_truth 下每个 json 都是合法 JSON', () => {
        const dir = path.join(serverRoot, 'content', 'packs', 'wuxing_truth');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        expect(files.length).toBeGreaterThanOrEqual(5);
        for (const file of files) {
            expect(() => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))).not.toThrow();
        }
    });
});
