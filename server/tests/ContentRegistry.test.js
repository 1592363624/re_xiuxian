/**
 * 内容注册中心（DLC）单元测试
 *
 * 最关键的一条是"零资料片时必须与现网配置完全一致"：
 * 合并层如果悄悄改动了任何既有数据集，就是给线上内容引入回归。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, ContentError, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');

function makeTempContent(datasetFiles = {}, packFiles = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-content-'));
    const configDir = path.join(root, 'config');
    const packDir = path.join(root, 'content', 'packs');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(packDir, { recursive: true });

    // 基础层默认给出真实属性定义，否则属性校验没有词表可用
    const realStats = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'config', 'stat_definitions.json'), 'utf-8')
    );
    fs.writeFileSync(path.join(configDir, 'stat_definitions.json'), JSON.stringify(realStats));

    for (const [name, data] of Object.entries(datasetFiles)) {
        fs.writeFileSync(path.join(configDir, `${name}.json`), JSON.stringify(data));
    }
    for (const [packId, files] of Object.entries(packFiles)) {
        const dir = path.join(packDir, packId);
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, data] of Object.entries(files)) {
            // pack 里的 key 已带 .json（pack.json）或需补 .json（数据集名）
            const fileName = name.endsWith('.json') ? name : `${name}.json`;
            fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data));
        }
    }
    return { root, configPath: configDir, packDir };
}

function build({ configPath, packDir }, statRegistry = new StatRegistry()) {
    const content = new ContentRegistry({ configPath, packDir, statRegistry });
    content.load();
    return { content, statRegistry };
}

const BASE_ITEMS = {
    items: [
        { id: 'wooden_sword', name: '木剑', type: 'equipment', subtype: 'weapon', effect: { atk: 5 }, price: 10 },
        { id: 'spirit_robe', name: '法袍', type: 'equipment', subtype: 'armor', effect: { def: 15, hp_max: 50 }, price: 80 }
    ]
};

const MANIFEST = { id: 'test_pack', name: '测试资料片', version: '1.0.0' };

describe('ContentRegistry 零资料片回归', () => {
    test('没有 pack 时各数据集与基础配置逐字段一致', () => {
        const realConfigDir = path.join(__dirname, '..', 'config');
        const registry = new StatRegistry();
        const content = new ContentRegistry({
            configPath: realConfigDir,
            packDir: path.join(__dirname, 'fixtures-no-such-packs'),
            statRegistry: registry
        });
        content.load();

        for (const dataset of Object.keys(DATASET_SPECS)) {
            const file = path.join(realConfigDir, `${dataset}.json`);
            if (!fs.existsSync(file)) continue;
            const base = JSON.parse(fs.readFileSync(file, 'utf-8'));
            expect([dataset, content.dataset(dataset)]).toEqual([dataset, base]);
        }
    });

    test('真实词表能装进属性注册中心并通过校验', () => {
        const realConfigDir = path.join(__dirname, '..', 'config');
        const { statRegistry } = build(
            { configPath: realConfigDir, packDir: path.join(__dirname, 'fixtures-no-such-packs') }
        );
        expect(statRegistry.count).toBeGreaterThanOrEqual(16);
        expect(statRegistry.has('atk')).toBe(true);
        expect(statRegistry.has('matk')).toBe(true);
    });

    test('真实现网物品 effect 键全部已登记（校验不会误伤既有内容）', () => {
        const realConfigDir = path.join(__dirname, '..', 'config');
        const content = new ContentRegistry({
            configPath: realConfigDir,
            packDir: path.join(__dirname, 'fixtures-no-such-packs')
        });
        expect(() => content.load()).not.toThrow();
    });
});

describe('ContentRegistry 资料片发现与合并', () => {
    test('目录扫描即完成注册，无 add 时保持基础内容', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: { 'pack.json': MANIFEST }
        });
        const { content } = build(temp);
        expect(content.status().packs).toEqual([
            expect.objectContaining({ id: 'test_pack', version: '1.0.0', enabled: true })
        ]);
        expect(content.dataset('item_data').items).toEqual(BASE_ITEMS.items);
    });

    test('add：新增一件带法攻的武器，不改任何 Service', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': {
                    dataset: 'item_data',
                    add: [{ id: 'qingzhu_fengyun_sword', name: '青竹蜂云剑', type: 'equipment', subtype: 'weapon', effect: { atk: 30, matk: 12 } }]
                }
            }
        });
        const { content } = build(temp);
        const items = content.dataset('item_data').items;
        expect(items).toHaveLength(3);
        expect(items.find(i => i.id === 'qingzhu_fengyun_sword').effect).toEqual({ atk: 30, matk: 12 });
    });

    test('override 深合并 effect：给已有木剑补法攻，原 atk 保留', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', override: { wooden_sword: { effect: { matk: 8 } } } }
            }
        });
        const { content } = build(temp);
        expect(content.dataset('item_data').items.find(i => i.id === 'wooden_sword').effect)
            .toEqual({ atk: 5, matk: 8 });
    });

    test('override 可以改标量字段', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', override: { spirit_robe: { price: 120, name: '星罗法袍' } } }
            }
        });
        const { content } = build(temp);
        const robe = content.dataset('item_data').items.find(i => i.id === 'spirit_robe');
        expect(robe.price).toBe(120);
        expect(robe.name).toBe('星罗法袍');
        expect(robe.effect).toEqual({ def: 15, hp_max: 50 });
    });

    test('remove：下架内容', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: { 'pack.json': MANIFEST, 'item_data.json': { dataset: 'item_data', remove: ['wooden_sword'] } }
        });
        const { content } = build(temp);
        expect(content.dataset('item_data').items.map(i => i.id)).toEqual(['spirit_robe']);
    });

    test('多 pack 按 priority 合并，后者可覆盖前者', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            pack_late: {
                'pack.json': { ...MANIFEST, id: 'pack_late', priority: 200 },
                'item_data.json': { dataset: 'item_data', override: { wooden_sword: { effect: { matk: 99 } } } }
            },
            pack_early: {
                'pack.json': { ...MANIFEST, id: 'pack_early', priority: 100 },
                'item_data.json': { dataset: 'item_data', override: { wooden_sword: { effect: { matk: 7 } } } }
            }
        });
        const { content } = build(temp);
        expect(content.packs.map(p => p.id)).toEqual(['pack_early', 'pack_late']);
        expect(content.dataset('item_data').items[0].effect.matk).toBe(99);
    });

    test('enabled:false 的 pack 完全不参与合并', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': { ...MANIFEST, enabled: false },
                'item_data.json': { dataset: 'item_data', add: [{ id: 'ghost', name: '幽灵', type: 'material' }] }
            }
        });
        const { content } = build(temp);
        expect(content.dataset('item_data').items).toHaveLength(2);
        expect(content.status().packs[0]).toMatchObject({ id: 'test_pack', enabled: false });
    });

    test('map 型数据集（technique_data）按对象键合并', () => {
        const temp = makeTempContent(
            { item_data: BASE_ITEMS, technique_data: { techniques: { huang_basic_qi: { id: 'huang_basic_qi', name: '基础吐纳诀', bonuses: { atk: 1 } } } } },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data.json': {
                        dataset: 'technique_data',
                        add: [{ id: 'huang_jian_qi', name: '建木剑气诀', bonuses: { matk: 6 } }],
                        override: { huang_basic_qi: { bonuses: { matk: 2 } } }
                    }
                }
            }
        );
        const { content } = build(temp);
        const techniques = content.dataset('technique_data').techniques;
        expect(Object.keys(techniques).sort()).toEqual(['huang_basic_qi', 'huang_jian_qi']);
        expect(techniques.huang_basic_qi.bonuses).toEqual({ atk: 1, matk: 2 });
        expect(techniques.huang_jian_qi.bonuses).toEqual({ matk: 6 });
    });

    test('<dataset>__<collection>.json：同一数据集的多个集合都能被资料片扩展', () => {
        // 这条能力是为了"资料片既能加功法、也能加一门用新属性打伤害的神通"。
        // 之前一个 pack 对一个数据集只能有一个文件、一个 into，于是神通永远进不了资料片。
        const temp = makeTempContent(
            {
                item_data: BASE_ITEMS,
                technique_data: {
                    techniques: { huang_basic_qi: { id: 'huang_basic_qi', name: '基础吐纳诀', bonuses: { atk: 1 } } },
                    skills: { flame_burst: { id: 'flame_burst', name: '烈焰爆发', element: 'fire' } }
                }
            },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data.json': {
                        dataset: 'technique_data',
                        add: [{ id: 'hunyun_jianyi_jue', name: '混元剑意诀', element: 'metal' }]
                    },
                    'technique_data__skills.json': {
                        dataset: 'technique_data',
                        into: 'skills',
                        add: [{ id: 'sword_qi_slash', name: '剑气斩', element: 'none', damage_profile: 'player_sword_intent' }]
                    }
                }
            }
        );
        const { content } = build(temp);
        const merged = content.dataset('technique_data');
        expect(Object.keys(merged.techniques).sort())
            .toEqual(['huang_basic_qi', 'hunyun_jianyi_jue']);
        expect(Object.keys(merged.skills).sort())
            .toEqual(['flame_burst', 'sword_qi_slash']);
        // 基础集合不能因为多了一个文件就被顶掉
        expect(merged.skills.flame_burst.name).toBe('烈焰爆发');
    });

    test('文件名指向未登记的集合 → 启动失败，而不是内容静默丢弃', () => {
        const temp = makeTempContent(
            { item_data: BASE_ITEMS, technique_data: { techniques: {} } },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data__shills.json': { dataset: 'technique_data', add: [{ id: 'x' }] }
                }
            }
        );
        expect(() => build(temp)).toThrow(/没有该集合/);
    });

    test('文件名集合与内容里的 into 冲突 → 启动失败', () => {
        const temp = makeTempContent(
            { item_data: BASE_ITEMS, technique_data: { techniques: {}, skills: {} } },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data__skills.json': { dataset: 'technique_data', into: 'techniques', add: [] }
                }
            }
        );
        expect(() => build(temp)).toThrow(/两者必须一致/);
    });

    test('root 数组型数据集（talents）', () => {
        const temp = makeTempContent(
            { item_data: BASE_ITEMS, talents: [{ id: 't1', name: '慧根', bonuses: { cultivate_speed_pct: 10 } }] },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'talents.json': { dataset: 'talents', add: [{ id: 't2', name: '剑心', bonuses: { matk: 5 } }] }
                }
            }
        );
        const { content } = build(temp);
        expect(Array.isArray(content.dataset('talents'))).toBe(true);
        expect(content.dataset('talents').map(t => t.id)).toEqual(['t1', 't2']);
    });
});

describe('ContentRegistry 启动期校验', () => {
    test('add 撞已有 id 报错，并提示改用 override', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', add: [{ id: 'wooden_sword', name: '另一把木剑', type: 'equipment' }] }
            }
        });
        expect(() => build(temp)).toThrow(/已存在。要修改既有内容请写 override/);
    });

    test('override 目标不存在报错', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', override: { typo_sword: { effect: { atk: 1 } } } }
            }
        });
        expect(() => build(temp)).toThrow(/不存在（id 拼错？）/);
    });

    test('remove 目标不存在报错', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', remove: ['never_existed'] }
            }
        });
        expect(() => build(temp)).toThrow(/要移除的 "never_existed" 不存在/);
    });

    test('物品 effect 用了未注册属性 → 启动失败而不是静默无效', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': {
                    dataset: 'item_data',
                    add: [{ id: 'odd_blade', name: '怪刀', type: 'equipment', effect: { wind_atk: 9 } }]
                }
            }
        });
        expect(() => build(temp)).toThrow(/未登记的属性键: wind_atk/);
    });

    test('同 pack 先在 stat_definitions 声明属性，再给物品用，即通过', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'stat_definitions.json': {
                    dataset: 'stat_definitions',
                    add: [{ key: 'wind_atk', label: '风系攻击', group: 'offense', powerWeight: 1.5, panel: { visible: true, order: 36 } }]
                },
                'item_data.json': {
                    dataset: 'item_data',
                    add: [{ id: 'xuanfeng_blade', name: '玄风刀', type: 'equipment', effect: { wind_atk: 9 } }]
                }
            }
        });
        const { content, statRegistry } = build(temp);
        expect(statRegistry.has('wind_atk')).toBe(true);
        expect(statRegistry.panelStats().find(s => s.key === 'wind_atk')).toBeTruthy();
        expect(content.dataset('item_data').items.find(i => i.id === 'xuanfeng_blade').effect.wind_atk).toBe(9);
    });

    test('新效果键可在 effect_vocabulary 登记为非属性效果', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'effect_vocabulary.json': {
                    dataset: 'effect_vocabulary',
                    add: [{ id: 'sword_intent', description: '剑意，由战斗子系统消费' }]
                },
                'item_data.json': {
                    dataset: 'item_data',
                    add: [{ id: 'intent_slip', name: '剑意残页', type: 'material', effect: { sword_intent: 1 } }]
                }
            }
        });
        const { content } = build(temp);
        expect(content.isKnownEffectKey('sword_intent')).toBe(true);
        expect(content.dataset('item_data')).toBeTruthy();
    });

    test('资料片功法用了不存在的灵根名 → 启动失败（现网曾因 gold/metal 混用整条五行相克静默失效）', () => {
        const temp = makeTempContent(
            {
                item_data: BASE_ITEMS,
                // 灵根三件套要给齐：只声明 spirit_roots、不配概率与加成，会被 _validateSpiritRootRoll
                // 判成"内容看起来齐全、新号永远抽不到"（本轮把那条 warn 升成了硬拦）。
                role_init: {
                    spirit_roots: [{ id: 'metal', type: 'metal', name: '金' }],
                    spiritRootProbabilities: { '金': 1 },
                    spiritRootBonuses: { '金': { atk: 4 } }
                },
                technique_data: { techniques: { a: { id: 'a', name: '金锐诀', element: 'metal' } }, skills: {} }
            },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data.json': { dataset: 'technique_data', add: [{ id: 'b', name: '残金功', element: 'gold' }] }
                }
            }
        );
        expect(() => build(temp)).toThrow(/未知灵根名/);

        // 'none'（无属性）与真实灵根名都必须放行，否则校验会变成加内容的障碍
        const ok = makeTempContent(
            {
                item_data: BASE_ITEMS,
                // 灵根三件套要给齐：只声明 spirit_roots、不配概率与加成，会被 _validateSpiritRootRoll
                // 判成"内容看起来齐全、新号永远抽不到"（本轮把那条 warn 升成了硬拦）。
                role_init: {
                    spirit_roots: [{ id: 'metal', type: 'metal', name: '金' }],
                    spiritRootProbabilities: { '金': 1 },
                    spiritRootBonuses: { '金': { atk: 4 } }
                },
                technique_data: { techniques: { a: { id: 'a', name: '金锐诀', element: 'metal' } }, skills: {} }
            },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data.json': { dataset: 'technique_data', add: [{ id: 'b', name: '混元功', element: 'none' }] }
                }
            }
        );
        expect(() => build(ok)).not.toThrow();
    });

    test('资料片神通用了词表外的特效键 → 启动失败（过去这类键配了也没人读）', () => {
        const base = {
            item_data: BASE_ITEMS,
            technique_data: { techniques: {}, skills: { s1: { id: 's1', effects: { extra_damage_rate: 0.2 } } } }
        };
        const bad = makeTempContent(base, {
            test_pack: {
                'pack.json': MANIFEST,
                'technique_data__skills.json': {
                    dataset: 'technique_data', into: 'skills',
                    add: [{ id: 's2', name: '错字神通', effects: { extra_dmg_rate: 0.2 } }]
                }
            }
        });
        expect(() => build(bad)).toThrow(/神通 effects 校验失败/);

        const good = makeTempContent(base, {
            test_pack: {
                'pack.json': MANIFEST,
                'technique_data__skills.json': {
                    dataset: 'technique_data', into: 'skills',
                    add: [{ id: 's3', name: '青莲剑歌', effects: { extra_damage_rate: 0.25, trigger_chance: 0.2 } }]
                }
            }
        });
        expect(() => build(good)).not.toThrow();
    });

    test('manifest.id 与目录名不一致报错', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: { 'pack.json': { ...MANIFEST, id: 'other_name' } }
        });
        expect(() => build(temp)).toThrow(/与目录名不一致/);
    });

    test('depends 指向未启用 pack 时报错', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: { 'pack.json': { ...MANIFEST, depends: ['missing_pack'] } }
        });
        expect(() => build(temp)).toThrow(/依赖 missing_pack/);
    });

    test('跨数据集引用不存在的物品时报错', () => {
        const temp = makeTempContent({
            item_data: BASE_ITEMS,
            drop_data: { drops: [{ monster_id: 'rabbit', drops: [{ item_id: 'no_such_item', chance: 1 }] }] }
        }, {});
        expect(() => build(temp)).toThrow(/引用了不存在的 item_data 条目 "no_such_item"/);
    });

    test('引用完整性：合法引用通过', () => {
        const temp = makeTempContent({
            item_data: BASE_ITEMS,
            drop_data: { drops: [{ monster_id: 'rabbit', drops: [{ item_id: 'wooden_sword', chance: 1 }] }] }
        }, {});
        expect(() => build(temp)).not.toThrow();
    });

    test('未登记数据集只告警不崩溃', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: { 'pack.json': MANIFEST, 'mystery_data.json': { dataset: 'mystery_data', add: [] } }
        });
        const { content } = build(temp);
        expect(content.status().warnings.join(' ')).toMatch(/mystery_data 未在 DATASET_SPECS 登记/);
    });

    test('ContentError 类型可用于启动期分级', () => {
        const temp = makeTempContent({ item_data: BASE_ITEMS }, {
            test_pack: {
                'pack.json': MANIFEST,
                'item_data.json': { dataset: 'item_data', override: { nope: { price: 1 } } }
            }
        });
        try {
            build(temp);
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
        }
    });

    test('法宝深度玩法的配置可被资料片扩展，且其中任意深度的物品引用都要真存在', () => {
        const good = makeTempContent(
            {
                item_data: BASE_ITEMS,
                artifact_deep_lines: { settings: { blood_sword: { item_key: 'wooden_sword' } } }
            },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'artifact_deep_lines.json': {
                        dataset: 'artifact_deep_lines',
                        into: 'settings',
                        add: [{
                            id: 'moon_cauldron',
                            item_key: 'spirit_robe',
                            stages: [{ materials: [{ item_key: 'wooden_sword' }] }]
                        }]
                    }
                }
            }
        );
        const { content } = build(good);
        const settings = content.dataset('artifact_deep_lines').settings;
        expect(settings.moon_cauldron).toBeTruthy();
        expect(settings.blood_sword).toBeTruthy();     // 基础那套没被资料片顶掉

        const bad = makeTempContent(
            { item_data: BASE_ITEMS, artifact_deep_lines: { settings: {} } },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'artifact_deep_lines.json': {
                        dataset: 'artifact_deep_lines',
                        into: 'settings',
                        add: [{ id: 'jade_bottle', nested: { stages: [{ materials: [{ item_key: 'no_such_item' }] }] } }]
                    }
                }
            }
        );
        // 引用藏在 stages[].materials[].item_key 这种任意深度里也要被抓出来：
        // 这类引用以前没人查，撞上时玩家已经付了材料费、事务回滚，表现成"炼到一半报错"
        expect(() => build(bad)).toThrow(ContentError);
        expect(() => build(bad)).toThrow(/no_such_item/);
    });

    test('掉落表指向地图上不会刷出的怪时也拦（内容加了但玩家永远拿不到，比崩更难发现）', () => {
        const temp = makeTempContent({
            item_data: BASE_ITEMS,
            map_data: { maps: [{ id: 0, name: '新手村', monsters: [{ id: 'rabbit', name: '野兔' }] }] },
            drop_data: {
                drops: [{
                    monster_id: 'moon_jiao', monster_name: '月蛟',
                    drops: [{ item_id: 'wooden_sword', quantity: 1, chance: 1 }]
                }]
            }
        });
        try {
            build(temp);
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            expect(error.message).toMatch(/不会刷出的怪[\s\S]*moon_jiao/);
        }
    });

    /**
     * 功法获取途径这道闸的夹具。下面每一条反例都对应现网真出现过的形状
     * （凡人遗宝的 recipe_scroll / sect_treasury、乱星海市舶的 sect_treasury 与一卷两用的乱星图残卷），
     * 当时每一种都"配置合法、代码不崩"，只有玩家能看出来 —— 所以每条判定都要单独能红。
     */
    test('功法 acquire 只许写代码认识的分支；残卷要双向对上、且不能一卷两用', () => {
        const tech = (acquire, id = 'tech_a') => ({
            id, name: `${id}功`, grade: 'huang', element: 'none', required_realm: '炼气1层', acquire
        });
        const scroll = (id, effect, type = 'recipe_scroll') => ({ id, name: `${id}卷`, type, effect, price: 10 });
        // 基础层刻意是空的 techniques：被检的那一部一律由 pack 加进来，
        // 否则"同 id 重复 add"会先抛错，测到的就不是这道闸而是合并规则了。
        const fixture = (items, techniques) => makeTempContent(
            {
                item_data: { items },
                technique_data: { techniques: {}, skills: {}, settings: {}, grades: {}, comprehension: {} },
                sect_data: { sects: [{ id: 'yinluo', name: '阴罗宗' }] }
            },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'technique_data.json': { dataset: 'technique_data', into: 'techniques', add: techniques }
                }
            }
        );

        // 正例：双向对上的残卷；以及代码真会扣代价的 sect（限定宗门也指得着）
        expect(() => build(fixture([scroll('scroll_a', { learn_technique: 'tech_a' })],
            [tech({ source: 'recipe_scroll', item_id: 'scroll_a' })]))).not.toThrow();
        expect(() => build(fixture([],
            [tech({ source: 'sect', sect_contribution: 100, sect_id: 'yinluo' })]))).not.toThrow();

        // 反例①：写一个没人处理的 source（现网真写过 recipe_scroll / sect_treasury）
        expect(() => build(fixture([], [tech({ source: 'sect_treasury' })])))
            .toThrow(/sect_treasury[\s\S]*没有任何代码处理/);
        // 反例②：限定了一个不存在的宗门
        expect(() => build(fixture([], [tech({ source: 'sect', sect_contribution: 100, sect_id: 'nope' })])))
            .toThrow(/不是任何宗门/);
        // 反例③：残卷没回指（玩家手里那卷纸没有任何一侧认得它是钥匙）
        expect(() => build(fixture([scroll('scroll_b', {})],
            [tech({ source: 'recipe_scroll', item_id: 'scroll_b' })]))).toThrow(/必须回指这部功法/);
        // 反例④：一卷两用（乱星图残卷的真实形状——两条链各要消耗一份，先走哪条另一条就断）
        expect(() => build(fixture([scroll('scroll_c', { learn_technique: 'tech_a', learn_recipe: 'craft_x' })],
            [tech({ source: 'recipe_scroll', item_id: 'scroll_c' })]))).toThrow(/同时写了 learn_technique 与 learn_recipe/);
        // 反例⑤：物品说能悟这部功法，功法侧却没开这条通道
        expect(() => build(fixture([scroll('scroll_d', { learn_technique: 'tech_a' })],
            [tech({ source: 'default' })]))).toThrow(/这条通道没人开/);
        // 反例⑥：item_id 指向不存在的物品 / 类型不对（消耗不掉的东西不算代价）
        expect(() => build(fixture([], [tech({ source: 'recipe_scroll', item_id: 'no_such' })])))
            .toThrow(/不是任何一件物品/);
        expect(() => build(fixture([scroll('junk', {}, 'material')],
            [tech({ source: 'recipe_scroll', item_id: 'junk' })]))).toThrow(/必须是 recipe_scroll/);
    });

    /**
     * 盯的形状：灵兽的 element 是**另一套**词表（不与玩家灵根比对），以前没人校验。
     * 拼错时两处静默：图鉴退回打印原始键，兽斗里 `getElementMultiplier` 查不到攻击方就返回中性，
     * 于是"雷音神兽"从来没有五行。现网 ti_hun 正是这一类 —— 修它时要顺带把 elements 变成资料片能扩的集合。
     */
    test('灵兽 element 与相克指向都要在灵兽词表里；资料片可以自带新的一档', () => {
        const elements = extra => ({
            metal: { name: '金', strong_against: 'wood', weak_against: 'fire', color: '#f59e0b' },
            wood: { name: '木', strong_against: null, weak_against: null, color: '#22c55e' },
            fire: { name: '火', strong_against: 'metal', weak_against: 'water', color: '#ef4444' },
            water: { name: '水', strong_against: 'fire', weak_against: null, color: '#3b82f6' },
            ...(extra || {})
        });
        const beastContent = (element) => ({
            item_data: BASE_ITEMS,
            spirit_beast_data: {
                elements: elements(),
                element_multiplier: { strong: 1.5, weak: 0.75, normal: 1.0 },
                beast_types: [{ beast_key: 'probe_beast', name: '探针兽', element, rarity: 'common', base_hp: 100 }],
                rarity_config: { common: { name: '普通', color: '#9ca3af', order: 1, release_return_ratio: 0.2 } },
                settings: {}, star_upgrade: { rarity_cost_multiplier: { common: 1.0 } }
            }
        });
        expect(() => build(makeTempContent(beastContent('metal')))).not.toThrow();     // 词表里有
        expect(() => build(makeTempContent(beastContent(null)))).not.toThrow();        // 没写 = 无属性，合法
        expect(() => build(makeTempContent(beastContent('thunder'))))
            .toThrow(/probe_beast\.element="thunder"[\s\S]*不在灵兽属性词表/);

        // 相克指向拼错同样永远匹配不上（比"没配克制"更隐蔽：看起来配了）
        const badRelation = beastContent('metal');
        badRelation.spirit_beast_data.elements.metal.strong_against = 'ghost';
        expect(() => build(makeTempContent(badRelation))).toThrow(/elements\.metal\.strong_against="ghost"/);

        // 资料片自带新的一档灵兽属性 → 引用它的灵兽就此合法（改前只能改基础表）
        const packAdded = makeTempContent(
            beastContent('thunder'),
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'spirit_beast_data.json': {
                        dataset: 'spirit_beast_data', into: 'elements',
                        add: [{ id: 'thunder', name: '雷', strong_against: null, weak_against: null, color: '#a855f7' }]
                    }
                }
            }
        );
        expect(() => build(packAdded)).not.toThrow();
        expect(Object.keys(build(packAdded).content.dataset('spirit_beast_data').elements)).toContain('thunder');
    });

    /**
     * 盯的形状：override 对数组字段是**整块替换**。两片资料片改同一条目的同一个数组字段时，
     * 后合并的那片会把前一片加的条目整块吃掉，而启动报告两边都写着成功（各 ~1）。
     * 掉落表就是这个形状（一个怪一张表），现网 shark/demon 各只有一个主人，所以这条闸今天零误伤；
     * 它防的是"下一片"——没有这道闸时，唯一的发现方式是玩家少了一份掉落，而没人知道曾经有过。
     */
    test('两片资料片整块替换同一个数组字段 → 启动期点名两片，而不是后一片静默吞掉前一片', () => {
        const base = {
            item_data: BASE_ITEMS,
            map_data: { maps: [{ id: 0, name: '新手村', monsters: [{ id: 'rabbit', name: '野兔' }, { id: 'wolf', name: '野狼' }] }] },
            drop_data: {
                drops: [
                    {
                        monster_id: 'rabbit', monster_name: '野兔',
                        drops: [{ item_id: 'wooden_sword', quantity: 1, chance: 1 }]
                    },
                    {
                        monster_id: 'wolf', monster_name: '野狼',
                        drops: [{ item_id: 'spirit_robe', quantity: 1, chance: 1 }]
                    }
                ]
            }
        };
        const dropsOf = (monster, items) => ({
            dataset: 'drop_data', into: 'drops', override: { [monster]: { drops: items } }
        });
        const one = item => [{ item_id: item, quantity: 1, chance: 1 }];
        const packOf = (id, priority, files) => [id, {
            'pack.json': { ...MANIFEST, id, priority },
            ...files
        }];

        // 各改各的怪 → 不许报错
        const differentMonsters = makeTempContent(base, Object.fromEntries([
            packOf('pack_a', 10, { 'drop_data.json': dropsOf('rabbit', one('wooden_sword')) }),
            packOf('pack_b', 20, { 'drop_data.json': dropsOf('wolf', one('spirit_robe')) })
        ]));
        expect(() => build(differentMonsters)).not.toThrow();

        // 同一片自己先后替换同一字段（两个文件指向同一集合）→ 是它自己的事，不许误伤
        const samePackTwice = makeTempContent(base, Object.fromEntries([
            packOf('pack_a', 10, {
                'drop_data.json': dropsOf('rabbit', one('wooden_sword')),
                'drop_data__drops.json': dropsOf('rabbit', one('spirit_robe'))
            })
        ]));
        expect(() => build(samePackTwice)).not.toThrow();
        expect(build(samePackTwice).content.dataset('drop_data').drops[0].drops[0].item_id).toBe('spirit_robe');

        // 两片抢同一条 → 报错里必须同时出现先手与后手，作者才知道该找谁协调
        const clash = makeTempContent(base, Object.fromEntries([
            packOf('pack_a', 10, { 'drop_data.json': dropsOf('rabbit', one('wooden_sword')) }),
            packOf('pack_b', 20, { 'drop_data.json': dropsOf('rabbit', one('spirit_robe')) })
        ]));
        expect(() => build(clash)).toThrow(ContentError);
        // 报错里两片的名字都要出现（作者才知道该找谁协调），顺序不重要
        expect(() => build(clash)).toThrow(/pack_a[\s\S]*pack_b|pack_b[\s\S]*pack_a/);
        expect(() => build(clash)).toThrow(/整块替换过/);
    });

    test('怪物声明的属性必须在注册表里（拼错的键永远不会生效，比崩更难发现）', () => {
        const withStats = (stats) => ({
            maps: [{
                id: 0, name: '新手村',
                monsters: [{ id: 'rabbit', name: '野兔', realm: '凡人', exp: 10, ...stats }]
            }]
        });
        // 属性写在怪物条目上（stats 子对象）或是怪物级倍率，都该通过
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS,
            map_data: withStats({ power_multiplier: 1.5, stats: { crit_rate: 20, dodge_rate: 15 } })
        }))).not.toThrow();

        try {
            build(makeTempContent({ item_data: BASE_ITEMS, map_data: withStats({ stats: { crit_change: 20 } }) }));
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            expect(error.message).toMatch(/未注册的属性[\s\S]*crit_change/);
        }
        // 是属性但不是数（写成中文"很高"）同样拦下
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, map_data: withStats({ stats: { crit_rate: '很高' } })
        }))).toThrow(/不是数值/);
    });

    /**
     * 兽潮与灵兽探渊以前根本不在 DATASET_SPECS 里，于是 _validateCombatStatBlocks 那两条分支
     * 读的 dataset() 永远是 null —— 看起来有闸，实际闸没接线，资料片也加不了这两类内容。
     * 这两条用例就是钉"分支确实接到了一个存在的数据集"。
     */
    test('兽潮妖兽与探渊层要登记进内容层，否则校验分支永远空转', () => {
        expect(Object.keys(DATASET_SPECS)).toEqual(
            expect.arrayContaining(['beast_invasion_data', 'spirit_beast_abyss_data'])
        );

        const abyss = (monsterStats) => ({
            abyss: { beast_hp_injury_recover_hours: 2 },
            floors: [{
                floor: 1, name: '第一层', min_realm_rank: 0, monster_difficulty: 1, reward_multiplier: 1,
                monsters: [{ key: 'abyss_rat', name: '深渊鼠', element: 'dark', hp: 200, atk: 30, def: 15, speed: 60, exp_reward: 20, ...(monsterStats ? { stats: monsterStats } : {}) }]
            }]
        });
        // 新属性：登记过就通过
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, spirit_beast_abyss_data: abyss({ crit_rate: 20 })
        }))).not.toThrow();
        // 条目自己就带 atk，再在 stats 里声明一遍就是两个真相（改了也不生效）
        try {
            build(makeTempContent({ item_data: BASE_ITEMS, spirit_beast_abyss_data: abyss({ atk: 999 }) }));
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            expect(error.message).toMatch(/beast_abyss\/第1层\/abyss_rat[\s\S]*atk/);
        }
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, spirit_beast_abyss_data: abyss({ crit_change: 20 })
        }))).toThrow(/未注册的属性/);

        const invasion = (stats) => ({
            beasts: [{ beast_key: 'xuelang', name: '血狼妖兽', base_hp: 100, base_atk: 10, base_def: 5, skills: [], rewards: {}, ...stats }]
        });
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, beast_invasion_data: invasion({ stats: { dodge_rate: 12 } })
        }))).not.toThrow();
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, beast_invasion_data: invasion({ stats: { crit_change: 12 } })
        }))).toThrow(/beast_invasion\/xuelang[\s\S]*未注册的属性/);
    });

    test('傀儡的属性块与等级增长率也要登记（友方战斗单位不是校验的例外）', () => {        const puppet = (stats = { atk: 50, def: 30, hp: 200, speed: 5 }, growth = { atk: 0.08, def: 0.08, hp: 0.08, speed: 0.03 }) => ({
            enabled: true,
            battle_stat_ratio: 0.3,
            quench: { stat_growth_rate: growth },
            puppet_types: { iron_wood: { key: 'iron_wood', name: '木甲傀儡', base_stats: stats } }
        });
        expect(() => build(makeTempContent({ item_data: BASE_ITEMS, puppet_data: puppet() }))).not.toThrow();

        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, puppet_data: puppet({ atk: 50, def: 30, hp: 200, speed: 5, crit_change: 12 })
        }))).toThrow(/puppet\/iron_wood[\s\S]*未注册的属性/);

        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, puppet_data: puppet({ atk: 50, def: '很高' })
        }))).toThrow(/puppet\/iron_wood 的属性 def 不是数值/);

        // 增长率写错属性名同样是"改了没人读"：木甲傀儡不会因为 atck 那一档而变强
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, puppet_data: puppet(undefined, { atck: 0.08 })
        }))).toThrow(/等级增长率写了未登记的属性 "atck"/);
    });

    test('副本怪与副本 BOSS 的声明同样要登记（副本是另一条敌人来源，不能只盯野外）', () => {        const dungeon = (nodeStats, bossStats) => ({
            global: { difficulty_multipliers: { normal: { hp: 1, atk: 1, exp: 1 } } },
            chapters: [{
                id: 'ch1', name: '测试副本', min_realm_rank: 0,
                boss: { name: '谷中魔兽', hp: 800, attack: 80, defense: 30, ...(bossStats ? { stats: bossStats } : {}) },
                nodes: [{ id: 'ch1_node2', type: 'battle', monster: { name: '黄纹妖蛇', hp: 200, attack: 30, defense: 10, ...(nodeStats ? { stats: nodeStats } : {}) }, rewards: {}, next_node: null }]
            }]
        });
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS, dungeon_data: dungeon({ crit_rate: 15 }, { dodge_rate: 10 })
        }))).not.toThrow();

        try {
            build(makeTempContent({ item_data: BASE_ITEMS, dungeon_data: dungeon(null, { crit_change: 20 }) }));
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            // 报错要指得出是哪一只怪 —— 只说"有个键没登记"没法修
            expect(error.message).toMatch(/ch1\/boss[\s\S]*crit_change/);
        }
    });

    test('境界链断一级就拦（players.realm 存的是名字，删境界等于把玩家挂在查无此境界上）', () => {
        const realm = (rank, name) => ({ id: `r${rank}`, name, rank, base_hp: 100, exp_cap: 100 });
        const broken = {
            realm_breakthrough: { realms: [realm(0, '凡人'), realm(1, '炼气1层'), realm(3, '炼气3层')] }
        };
        try {
            build(makeTempContent({ item_data: BASE_ITEMS, ...broken }));
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            expect(error.message).toMatch(/境界链[\s\S]*rank 2 缺失[\s\S]*炼气1层/);
        }
        // 补齐那一阶就必须放行，否则这道闸会把正常内容一起拦掉
        expect(() => build(makeTempContent({
            item_data: BASE_ITEMS,
            realm_breakthrough: { realms: [realm(0, '凡人'), realm(1, '炼气1层'), realm(2, '炼气2层'), realm(3, '炼气3层')] }
        }))).not.toThrow();
    });

    test('境界名字重复也拦：两个境界挤同一个键，玩家查出来永远是先命中的那个', () => {
        const realm = (rank, name) => ({ id: `r${rank}`, name, rank, base_hp: 100, exp_cap: 100 });
        try {
            build(makeTempContent({
                item_data: BASE_ITEMS,
                realm_breakthrough: { realms: [realm(0, '凡人'), realm(1, '凡人')] }
            }));
            throw new Error('应当抛错');
        } catch (error) {
            expect(error).toBeInstanceOf(ContentError);
            expect(error.message).toMatch(/境界名字重复/);
        }
    });
});

/**
 * 嵌套集合：集合名可以写成点号路径（spirit_beast_pvp.tiers）。
 *
 * 为什么需要：现网最大的几份玩法配置（late_stage_data / ascension_data / sect_special_data
 * / spirit_beast_pvp_data …）都是"一个文件里再分子系统"，真正的条目数组住在第二层。
 * 只支持顶层集合的话，这些玩法永远进不了资料片层 —— 而它们恰恰最需要"只加数据就能扩"。
 */
describe('ContentRegistry 嵌套集合（点号路径）', () => {
    const PVP_BASE = {
        _meta: { version: '1' },
        spirit_beast_pvp: {
            tiers: [{ key: 'bronze', name: '青铜', min_wins: 0 }, { key: 'silver', name: '白银', min_wins: 3 }],
            combat: { atk_multiplier: 1 }
        }
    };
    const addPack = {
        'pack.json': MANIFEST,
        'spirit_beast_pvp_data__spirit_beast_pvp__tiers.json': { add: [{ key: 'gold', name: '黄金', min_wins: 9 }] }
    };

    test('资料片能往第二层的集合里加条目，同层的兄弟键与原文件键不受影响', () => {
        const { content } = build(makeTempContent(
            { item_data: BASE_ITEMS, spirit_beast_pvp_data: PVP_BASE }, { test_pack: addPack }
        ));
        const view = content.dataset('spirit_beast_pvp_data');
        expect(view.spirit_beast_pvp.tiers.map(t => t.key)).toEqual(['bronze', 'silver', 'gold']);
        expect(view.spirit_beast_pvp.combat).toEqual({ atk_multiplier: 1 });
        expect(view._meta).toEqual({ version: '1' });
    });

    test('合并不就地改基础配置那份对象（否则 reload 会把上一次合并的结果当基础，条目越 reload 越多）', () => {
        const { content } = build(makeTempContent(
            { item_data: BASE_ITEMS, spirit_beast_pvp_data: PVP_BASE }, { test_pack: addPack }
        ));
        const again = content.reload('spirit_beast_pvp_data');
        expect(again.spirit_beast_pvp.tiers.map(t => t.key)).toEqual(['bronze', 'silver', 'gold']);
    });

    test('override 按主键只换那一条', () => {
        const { content } = build(makeTempContent(
            { item_data: BASE_ITEMS, spirit_beast_pvp_data: PVP_BASE },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'spirit_beast_pvp_data__spirit_beast_pvp__tiers.json': {
                        override: { silver: { key: 'silver', name: '白银·改', min_wins: 5 } }
                    }
                }
            }
        ));
        const tiers = content.dataset('spirit_beast_pvp_data').spirit_beast_pvp.tiers;
        expect(tiers.find(t => t.key === 'silver').name).toBe('白银·改');
        expect(tiers.find(t => t.key === 'bronze').name).toBe('青铜');
    });

    test('路径多写/少写一层当场抛错，而不是悄悄合并出一个空集合', () => {
        expect(() => build(makeTempContent(
            { item_data: BASE_ITEMS, spirit_beast_pvp_data: PVP_BASE },
            {
                test_pack: {
                    'pack.json': MANIFEST,
                    'spirit_beast_pvp_data__spirit_beast_pvp__nope.json': { add: [] }
                }
            }
        ))).toThrow(/没有该集合/);
    });

    test('大玩法数据集已经登记（资料片加不了它们时，"支持 DLC"这句话只兑现了一半）', () => {
        expect(Object.keys(DATASET_SPECS)).toEqual(expect.arrayContaining([
            'companion_data', 'spirit_beast_pvp_data', 'sect_special_data',
            'ascension_data', 'late_stage_data', 'puppet_data', 'sparring_woodman'
        ]));
    });
});

describe('副本抉择变量词汇校验（黄龙山那类静默失效的守卫）', () => {
    const dungeonData = (choice) => ({
        dataset: 'multi_dungeon_data',
        global: { variable_labels: { morale: '士气', demo_soul_shards: '灵魄碎片' } },
        dungeons: {
            demo: {
                name: '示例副本',
                init_morale: 100,
                instance_vars: { demo_soul_shards: 0 },
                acts: [{ act_number: 1, act_name: '第一幕', choices: [choice] }]
            }
        }
    });

    test('副本声明过的变量（含去掉副本前缀的短名）通过', () => {
        expect(() => build(makeTempContent({
            multi_dungeon_data: dungeonData({ key: 'a', text: '甲', morale_change: 5, soul_shards_change: 3 })
        }))).not.toThrow();
    });

    test('抉择写了没声明的变量 → 启动失败，而不是运行期静默不生效', () => {
        expect(() => build(makeTempContent({
            multi_dungeon_data: dungeonData({ key: 'a', text: '甲', mystic_fury_change: 4 })
        }))).toThrow(/mystic_fury/);
    });

    test('现网 multi_dungeon_data 的全部抉择键都能被内容自身的词汇解释', () => {
        const realConfigDir = path.join(__dirname, '..', 'config');
        const { content } = build({ configPath: realConfigDir, packDir: path.join(__dirname, 'fixtures-no-such-packs') });
        expect(() => content._validateDungeonChoiceVars()).not.toThrow();
        // 黄龙山用的是短名 + 带前缀的列名，这条断言保证它不会因为"改名修 bug"而悄悄失去守卫
        expect(Object.keys(content.datasets.get('multi_dungeon_data').dungeons.huanglong.member_vars))
            .toEqual(expect.arrayContaining(['huanglong_eye_position', 'huanglong_contribution_score', 'huanglong_is_defecting']));
    });
});

/**
 * 器灵类型的展示元数据闸。
 * 起因：面板抄了一份 4 档器灵的文案（连"攻击 +5%（每级 +2%）"都是手打字符串），
 * 内容改数值界面不跟着变，抄的那份平灵型还漏了"暴击 +1%"。
 * 现在文案由服务端按内容数值拼（ArtifactSpiritService.spiritTypeCatalog），
 * 缺标签只能在启动期响 —— 所以这里要钉住"缺了就抛"。
 */
describe('器灵展示元数据校验（spirit_bonus_stat_labels / spirit_effect_labels）', () => {
    const spiritData = (types) => ({
        enabled: true,
        spirit_bonus_stat_labels: { atk_percent: '攻击', def_percent: '防御' },
        spirit_effect_labels: {
            damage_reflect: { label: '反弹伤害', value_format: 'percent' },
            cleanse: { label: '净化负面状态', value_format: 'none' }
        },
        spirit_types: types
    });

    test('标签齐全时通过', () => {
        expect(() => build(makeTempContent({
            artifact_spirit_data: spiritData({
                attack: { name: '攻灵型', base_bonus: { atk_percent: 0.05 }, level_bonus_per_level: { atk_percent: 0.02 }, protect_effect: 'damage_reflect', protect_value: 0.2, activate_effect: 'cleanse' }
            })
        }))).not.toThrow();
    });

    test('加成键没有中文名 → 启动失败，而不是面板上印裸键名', () => {
        expect(() => build(makeTempContent({
            artifact_spirit_data: spiritData({
                soul: { name: '魂灵型', base_bonus: { soul_percent: 0.05 }, protect_effect: 'cleanse' }
            })
        }))).toThrow(/spirit_bonus_stat_labels.*soul_percent|soul_percent/);
    });

    test('护主/催发效果码没有标签 → 启动失败', () => {
        expect(() => build(makeTempContent({
            artifact_spirit_data: spiritData({
                attack: { name: '攻灵型', base_bonus: { atk_percent: 0.05 }, protect_effect: 'blood_rage' }
            })
        }))).toThrow(/spirit_effect_labels/);
    });

    test('value_format 只认 percent/none', () => {
        const data = spiritData({ attack: { name: '攻灵型', base_bonus: {}, protect_effect: 'cleanse' } });
        data.spirit_effect_labels.cleanse.value_format = 'raw';
        expect(() => build(makeTempContent({ artifact_spirit_data: data }))).toThrow(/value_format/);
    });

    test('现网 artifact_spirit_data 过闸，且四档器灵都在（防这条闸空转）', () => {
        const { content } = build({
            configPath: path.join(__dirname, '..', 'config'),
            packDir: path.join(__dirname, 'fixtures-no-such-packs')
        });
        const types = content.datasets.get('artifact_spirit_data').spirit_types;
        expect(Object.keys(types)).toEqual(expect.arrayContaining(['attack', 'defense', 'support', 'balance']));
        expect(() => content._validateArtifactSpiritLabels()).not.toThrow();
    });
});
