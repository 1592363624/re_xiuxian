/**
 * 慕兰战线 / 宗门战领地 / 天时 登记进内容层之后的验收
 *
 * 登记（DATASET_SPECS）只是让资料片"加得进来"；这一轮真正推动登记的是它在启动期顺带接管了
 * 一条以前没人管的引用形状：战线配置把物品引用写成 `items[].key` / `item_drops[].key`
 * （字段名就叫 key，因为它是条目的主键），而 `_validateItemKeysDeep` 原来只按字段名匹配
 * `item_key|item_id|material_key|*_item_key|*_item_id` —— 于是这批引用完全在闸外：
 * 实测 14 个被引用的物品 id 里有 9 个根本不存在（军功商店 4 件、里程碑 3 档、残图匣整套 5 件），
 * 玩家的表现是"兑换收一句物品发放失败"、"里程碑领了但没东西"、"残图匣永远显示残片不足"。
 *
 * 所以这里钉三件事：登记还在（别被回滚）、资料片确实能往这些集合里加内容、
 * 加进来的引用指向不存在的物品时**启动期就炸**。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');

const REAL_CONFIG = path.join(__dirname, '..', 'config');

function makeTempContent(datasetFiles = {}, packFiles = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-border-'));
    const configDir = path.join(root, 'config');
    const packDir = path.join(root, 'content', 'packs');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(packDir, { recursive: true });
    fs.copyFileSync(path.join(REAL_CONFIG, 'stat_definitions.json'), path.join(configDir, 'stat_definitions.json'));

    for (const [name, data] of Object.entries(datasetFiles)) {
        fs.writeFileSync(path.join(configDir, `${name}.json`), JSON.stringify(data));
    }
    for (const [packId, files] of Object.entries(packFiles)) {
        const dir = path.join(packDir, packId);
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, data] of Object.entries(files)) {
            const fileName = name.endsWith('.json') ? name : `${name}.json`;
            fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data));
        }
    }
    return { root, configPath: configDir, packDir };
}

function build(options) {
    const content = new ContentRegistry({ ...options, statRegistry: new StatRegistry() });
    content.load();
    return content;
}

const BASE_ITEMS = {
    items: [
        { id: 'huanglong_merit_token', name: '黄龙军功牌', type: 'material', subtype: 'token', price: 400 }
    ]
};

const BASE_BORDER = {
    settings: { min_realm_rank: 15 },
    support_routes: {
        _comment: '路线清单住在内容里',
        scout: { name: '斥候', item_drops: [{ key: 'huanglong_merit_token', drop_rate: 0.1, quantity_range: [1, 1] }] }
    },
    beast_patrol: { routes: { patrol_a: { name: '巡边', item_drops: [{ key: 'huanglong_merit_token', drop_rate: 0.1 }] } } },
    war_imprint: { imprint_types: { scout_stealth: { name: '斥候匿踪' } } },
    military_shop: { items: [{ key: 'huanglong_merit_token', name: '黄龙军功牌', cost_merit: 10, daily_limit: 1 }] },
    milestones: { thresholds: [{ merit: 7, title: '初阵立功', rewards: { spirit_stones: 500, items: [{ key: 'huanglong_merit_token', quantity: 1 }] } }] }
};

const BASE_SECT_WAR = {
    meta: { season_days: 30 },
    territories: [{ territory_key: 'mulan_gate', territory_name: '慕兰门户', base_daily_production: 20 }]
};

const BASE_TIME = {
    heavenly_events: [{ key: 'lei_yun', name: '雷云', interval_years: 3 }],
    mortal_activities: { cultivation: { name: '修行', default_years: 1 } }
};

const MANIFEST = { id: 'test_pack', name: '测试资料片', version: '1.0.0' };
const op = (dataset, into, add) => ({ dataset, into, comment: '测试', add });

describe('战线/领地/天时进入内容层：能扩，且引用受闸', () => {
    test('三份数据集与它们的集合都已登记（回滚掉任何一条，资料片就又碰不到这些玩法）', () => {
        expect(DATASET_SPECS.border_military_data.collections).toEqual(expect.objectContaining({
            support_routes: { map: true },
            'beast_patrol.routes': { map: true },
            'war_imprint.imprint_types': { map: true },
            'military_shop.items': { key: 'key' },
            'milestones.thresholds': { key: 'merit' }
        }));
        expect(DATASET_SPECS.sect_war_data.collections.territories).toEqual({ key: 'territory_key' });
        expect(DATASET_SPECS.time_system.collections).toEqual(expect.objectContaining({
            heavenly_events: { key: 'key' },
            mortal_activities: { map: true }
        }));
    });

    test('现网这三份配置能通过启动期校验（补上 9 件缺失物品之后）', () => {
        expect(() => build({ configPath: REAL_CONFIG, packDir: path.join(__dirname, 'fixtures-no-such-packs') })).not.toThrow();
    });

    test('资料片能新增后勤路线、领地、天时事件，合并视图与引用校验都认', () => {
        const content = build(makeTempContent(
            { item_data: BASE_ITEMS, border_military_data: BASE_BORDER, sect_war_data: BASE_SECT_WAR, time_system: BASE_TIME },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    // map 集合的 add 也是数组，条目用 id 当对象键（见 ContentRegistry.keyOf）
                    'border_military_data__support_routes.json': op('border_military_data', 'support_routes', [
                        { id: 'lamp_supply', name: '灯油转运', item_drops: [{ key: 'huanglong_merit_token', drop_rate: 0.2 }] }
                    ]),
                    'sect_war_data__territories.json': op('sect_war_data', 'territories', [
                        { territory_key: 'cangkun_ruins', territory_name: '苍坤遗迹', base_daily_production: 35 }
                    ]),
                    'time_system__heavenly_events.json': op('time_system', 'heavenly_events', [
                        { key: 'mulan_tide', name: '慕兰潮', interval_years: 5 }
                    ])
                }
            }
        ));

        const border = content.dataset('border_military_data');
        expect(Object.keys(border.support_routes)).toEqual(expect.arrayContaining(['scout', 'lamp_supply']));
        const territories = content.dataset('sect_war_data').territories;
        expect(territories.map(t => t.territory_key)).toEqual(expect.arrayContaining(['mulan_gate', 'cangkun_ruins']));
        expect(content.dataset('time_system').heavenly_events.map(e => e.key)).toContain('mulan_tide');
    });

    test('资料片往商店/掉落/里程碑里引用不存在的物品 → 启动期就抛，而不是玩家在兑换时撞', () => {
        // 三种形状都要管：商店条目（key 即主键）、路线掉落（item_drops[].key）、里程碑奖励（rewards.items[].key）
        const cases = {
            shop: { 'border_military_data__military_shop__items.json': op('border_military_data', 'military_shop.items', [{ key: 'ghost_medal', name: '幽灵勋章', cost_merit: 1, daily_limit: 1 }]) },
            drop: { 'border_military_data__support_routes.json': op('border_military_data', 'support_routes', [{ id: 'raid_b', name: '奇袭', item_drops: [{ key: 'ghost_medal', drop_rate: 0.5 }] }]) },
            milestone: { 'border_military_data__milestones__thresholds.json': op('border_military_data', 'milestones.thresholds', [{ merit: 999, title: '测试档', rewards: { items: [{ key: 'ghost_medal', quantity: 1 }] } }]) }
        };
        for (const [label, files] of Object.entries(cases)) {
            expect(() => build(makeTempContent(
                { item_data: BASE_ITEMS, border_military_data: BASE_BORDER },
                { test_pack: { 'pack.json': MANIFEST, ...files } }
            ))).toThrow(/ghost_medal/);
        }
    });
});
