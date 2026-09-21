/**
 * 热更新路径的内容契约测试（临时目录，不连库）。
 *
 * 后台改配置文件是这条路径的入口（routes/config.js、admin_formation 等多处 hotUpdateConfig），
 * 它过去绕过了启动期那套校验：把一个拼错的属性键写进 item_data，
 * 表现不是报错，而是玩家身上凭空少一份加成——正是这轮改造要消灭的那类静默失效。
 *
 * 更危险的是失败之后的状态：hotUpdateConfig 会先把"裸基础配置"写进缓存，再通知内容层重新合并。
 * 以前内容层把异常吞在监听器里，于是缓存就这么留在裸基础值上——
 * 一次没通过的编辑等于让运行中的进程突然看不到所有资料片内容（道具定义成片的消失），
 * 直到重启才恢复。现在两边都要求可回滚。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigLoader } = require('../modules/infrastructure/ConfigLoader');
const { ContentRegistry, ContentError } = require('../game/content/ContentRegistry');
const { initializeContentLayer } = require('../game/content');
const { StatRegistry } = require('../game/stats/StatRegistry');

const REAL_STAT_DEFINITIONS = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'stat_definitions.json'), 'utf-8')
);

const BASE_ITEMS = {
    items: [
        { id: 'wooden_sword', name: '木剑', type: 'equipment', subtype: 'weapon', effect: { atk: 5 }, price: 10 }
    ]
};

const PACK_FILES = {
    'pack.json': { id: 'hot_reload_pack', name: '热更测试片', version: '1.0.0' },
    'item_data.json': {
        dataset: 'item_data',
        into: 'items',
        add: [{ id: 'flying_shadow_blade', name: '飞影剑', type: 'equipment', subtype: 'weapon', effect: { atk: 30 }, price: 900 }]
    }
};

function makeTempWorld() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-hotreload-'));
    const configPath = path.join(root, 'config');
    const packDir = path.join(root, 'content', 'packs');
    fs.mkdirSync(configPath, { recursive: true });
    fs.mkdirSync(path.join(packDir, 'hot_reload_pack'), { recursive: true });
    fs.writeFileSync(path.join(configPath, 'stat_definitions.json'), JSON.stringify(REAL_STAT_DEFINITIONS));
    fs.writeFileSync(path.join(configPath, 'item_data.json'), JSON.stringify(BASE_ITEMS));
    for (const [name, data] of Object.entries(PACK_FILES)) {
        fs.writeFileSync(path.join(packDir, 'hot_reload_pack', name), JSON.stringify(data));
    }
    return { root, configPath, packDir };
}

const itemIds = (view) => (view?.items || []).map(i => i.id).sort();

describe('内容层热更新契约', () => {
    let world;

    beforeEach(() => { world = makeTempWorld(); });
    afterEach(() => { fs.rmSync(world.root, { recursive: true, force: true }); });

    function buildRegistry() {
        const statRegistry = new StatRegistry();
        const content = new ContentRegistry({
            configPath: world.configPath,
            packDir: world.packDir,
            statRegistry
        });
        content.load();
        return { content, statRegistry };
    }

    test('基础配置被改成野属性键时，reload 抛错（与启动期同一道闸）', () => {
        const { content } = buildRegistry();
        fs.writeFileSync(path.join(world.configPath, 'item_data.json'), JSON.stringify({
            items: [{ id: 'wooden_sword', name: '木剑', type: 'equipment', effect: { atk_k: 5 }, price: 10 }]
        }));

        expect(() => content.reload('item_data')).toThrow(ContentError);
        expect(() => content.reload('item_data')).toThrow(/atk_k/);
    });

    test('reload 失败后退回上一份视图：资料片内容仍然在，属性注册表没被清空', () => {
        const { content, statRegistry } = buildRegistry();
        const before = itemIds(content.dataset('item_data'));
        expect(before).toContain('flying_shadow_blade');

        fs.writeFileSync(path.join(world.configPath, 'item_data.json'), JSON.stringify({
            items: [{ id: 'wooden_sword', name: '木剑', type: 'equipment', effect: { not_a_stat: 5 }, price: 10 }]
        }));
        expect(() => content.reload('item_data')).toThrow(/not_a_stat/);

        expect(itemIds(content.dataset('item_data'))).toEqual(before);
        expect(statRegistry.resolveStatKey('atk')).toBeTruthy();
        // 磁盘上那份坏文件还在，但内存里的视图是好的：下一次成功的热更才会把新内容带进来
        fs.writeFileSync(path.join(world.configPath, 'item_data.json'), JSON.stringify({
            items: [
                { id: 'wooden_sword', name: '木剑', type: 'equipment', effect: { atk: 6 }, price: 10 },
                { id: 'herb', name: '灵草', type: 'material', price: 1 }
            ]
        }));
        expect(itemIds(content.reload('item_data'))).toEqual(['flying_shadow_blade', 'herb', 'wooden_sword']);
    });

    test('一次失败的 hotUpdateConfig 不会把裸基础配置留在运行缓存里', async () => {
        const loader = new ConfigLoader();
        loader.configPath = world.configPath;
        await loader.loadAllConfigs();
        initializeContentLayer(loader, { packDir: world.packDir });

        const mergedBefore = itemIds(loader.getConfig('item_data'));
        expect(mergedBefore).toContain('flying_shadow_blade');

        fs.writeFileSync(path.join(world.configPath, 'item_data.json'), JSON.stringify({
            items: [{ id: 'wooden_sword', name: '木剑', type: 'equipment', effect: { broken_stat: 5 }, price: 10 }]
        }));

        await expect(loader.hotUpdateConfig('item_data')).rejects.toThrow(/broken_stat/);
        // 关键断言：编辑失败之后，进程看到的仍然是含资料片的那一份
        expect(itemIds(loader.getConfig('item_data'))).toEqual(mergedBefore);
    });

    test('成功的 hotUpdateConfig 把新基础内容与资料片一起合并', async () => {
        const loader = new ConfigLoader();
        loader.configPath = world.configPath;
        await loader.loadAllConfigs();
        initializeContentLayer(loader, { packDir: world.packDir });

        fs.writeFileSync(path.join(world.configPath, 'item_data.json'), JSON.stringify({
            items: [{ id: 'iron_fan', name: '铁扇', type: 'equipment', subtype: 'weapon', effect: { atk: 12 }, price: 40 }]
        }));
        await expect(loader.hotUpdateConfig('item_data')).resolves.toMatchObject({ success: true });

        const items = loader.getConfig('item_data').items;
        expect(itemIds({ items })).toEqual(['flying_shadow_blade', 'iron_fan']);
        expect(items.find(i => i.id === 'iron_fan').effect.atk).toBe(12);
    });
});
