/**
 * 历练事件内容的验收测试。
 *
 * 盯的缺陷形状：这 15 条事件（以及抽取权重、AI 标题、AI 保底经验三份按同一组 type 抄的字典）
 * 以前抄在 AdventureEventService 的代码里。抄在代码里的内容对所有内容闸都是隐形的 ——
 * 于是 treasure_2 的 rewards.items 指着一条 item_data 里根本没有的 ancient_token 躺了很久：
 * 玩家领到的是一条既查不出名字、也没有定义的背包行，界面只能把裸键印出去。
 * 搬进 config/adventure_event_data.json 之后，本文件钉住四件事：
 *   1) 资料片加一条事件真的进得来（DLC 承诺的最低形态）；
 *   2) 事件的 type 没在 event_types 里声明 → 启动期拒收（不然这一类永远抽不到，两头都不报错）；
 *   3) rewards.items 写错物品键 → 启动期拒收（第 1 条 bug 的回归闸）；
 *   4) 资料片文件写成形如 {"events": [...]}（不是 add/override/remove 那套操作包）→ 拒收，
 *      否则这份内容一个字都不会合并，而日志照样报"资料片装配成功"；
 *   5) 模板不许再抄回代码里。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');
const PlayerAdventure = require('../models/playerAdventure');

const serverRoot = path.join(__dirname, '..');
const configDir = path.join(serverRoot, 'config');

const tempDirs = [];
afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个只含 adventure_event_data 的临时资料片，返回的是 packs 根目录（注册表扫的是根目录下的子目录） */
function packDirWith(ops) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rxjs-adventure-'));
    tempDirs.push(root);
    const pack = path.join(root, 'adv_probe');
    fs.mkdirSync(pack);
    fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({
        id: 'adv_probe', name: '历练事件探针', version: '1.0.0'
    }));
    fs.writeFileSync(path.join(pack, 'adventure_event_data.json'), JSON.stringify(ops));
    return root;
}

function loadWith(ops) {
    const content = new ContentRegistry({
        configPath: configDir,
        packDir: packDirWith(ops),
        statRegistry: new StatRegistry()
    });
    content.load();
    return content.dataset('adventure_event_data');
}

const event = (over) => ({
    type: 'treasure', title: '探针事件', description: '内容闸用的事件', duration: 30, rewards: {}, ...over
});
const addEvents = (...events) => ({ dataset: 'adventure_event_data', into: 'events', add: events });

const base = () => {
    const content = new ContentRegistry({
        configPath: configDir,
        packDir: path.join(serverRoot, 'content', 'packs'),
        statRegistry: new StatRegistry()
    });
    content.load();
    return content;
};

describe('历练事件住在内容里', () => {
    test('资料片加一条事件，服务侧立刻看得见（不用改代码）', () => {
        const merged = loadWith(addEvents(
            event({ id: 'probe_1', rewards: { exp: 1, items: ['spirit_herb'] } })
        ));
        const added = merged.events.find(e => e.id === 'probe_1');
        expect(added).toBeTruthy();
        expect(added.title).toBe('探针事件');
        // 基础内容那 15 条还在：资料片是追加，不是替换
        expect(merged.events.some(e => e.id === 'treasure_2')).toBe(true);
    });

    test('事件 type 没在 event_types 里声明：启动期拒收', () => {
        expect(() => loadWith(addEvents(event({ id: 'probe_bad_type', type: 'treasur' }))))
            .toThrow(/event_types/);
    });

    test('rewards.items 写了不存在的物品键：启动期拒收（ancient_token 那次的回归闸）', () => {
        expect(() => loadWith(addEvents(event({ id: 'probe_bad_item', rewards: { items: ['mo_cun_zai_de_wu_pin'] } }))))
            .toThrow(/mo_cun_zai_de_wu_pin/);
    });

    test('资料片文件写成形如 {"events": [...]}：拒收，不再静默不合并', () => {
        expect(() => loadWith({ dataset: 'adventure_event_data', into: 'events', events: [] }))
            .toThrow(/不会被合并/);
    });

    test('真实内容里每条事件的 type 都是 DB ENUM 认的值', () => {
        const enums = PlayerAdventure.rawAttributes.event_type.values;
        const bad = base().dataset('adventure_event_data').events
            .filter(e => !enums.includes(e.type))
            .map(e => `${e.id}="${e.type}"`);
        expect(bad).toEqual([]);
    });

    test('真实内容里每件奖励物品都是真物品（否则界面只能印裸键）', () => {
        const content = base();
        const events = content.dataset('adventure_event_data').events;
        const itemIds = new Set((content.dataset('item_data')?.items || []).map(i => String(i.id)));
        expect(itemIds.size).toBeGreaterThan(0);
        const refs = events.flatMap(e => Array.isArray(e.rewards?.items) ? e.rewards.items : []);
        expect(refs.length).toBeGreaterThan(0);
        const phantom = refs.filter(key => !itemIds.has(String(key)));
        if (phantom.length) {
            const who = events.filter(e => (e.rewards?.items || []).includes(phantom[0])).map(e => e.id);
            throw new Error(`这些奖励物品在 item_data 里不存在（发出去就是一条没名字的背包行）：`
                + `${phantom.join('/')}，出自事件 ${who.join('/')}`);
        }
        expect(phantom).toEqual([]);
    });

    test('模板不许再抄回服务代码里', () => {
        const src = fs.readFileSync(path.join(serverRoot, 'game', 'services', 'AdventureEventService.js'), 'utf8');
        const back = ['peaceful_1', 'treasure_2', 'discovery_3', '途中偶遇', 'guardian_beast']
            .filter(literal => src.includes(literal));
        if (back.length) throw new Error(`服务里又抄回了事件字面量：${back.join(' / ')}`);
        expect(back).toEqual([]);
    });
});
