/**
 * "发奖不许谎报"这一层的验收测试（game/items/itemGrant.js）。
 *
 * 盯的缺陷形状：`try { addItem } catch { console.warn }` 然后照旧把这件东西写进
 * 给玩家看的那份列表（战斗掉落的 `items`、探渊的 `items_gained`、兽潮的全场广播摘要）。
 * 失败只在日志里，玩家以为自己拿到了；记录也留了一条不存在的收获，之后不会再补。
 * 物品键写错那条已经被启动期校验堵住了，这里管的是运行期真发不出去（背包满、并发、异常）：
 * **要么发到，要么明确没发到** —— 调用方拿不到"假装发到"的选项。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const InventoryService = require('../game/services/InventoryService');
const { grantItems, describeGrant } = require('../game/items/itemGrant');
const { itemName } = require('../game/items/itemNaming');
const { initializeModules } = require('../modules');

const serverRoot = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(serverRoot, rel), 'utf8').replace(/\r\n/g, '\n');

function jsFilesUnder(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFilesUnder(abs));
        else if (entry.name.endsWith('.js')) out.push(abs);
    }
    return out;
}

// try 块里出现 addItem，连同它自己的 catch 体一起抓出来。
// 不用"try{ …400字… addItem … } catch{ … }"这种整串正则：窗口一放宽，相邻的两个 try
// 会被并成一个匹配、lastIndex 跳过中间那些，计数就飘了（实测 6 处只报 3 处）。
// 这里按大括号配对，逐个 try 块老实数。
function tryBlocksWrapping(src, callMarker) {
    const out = [];
    for (const m of src.matchAll(/try\s*\{/g)) {
        const open = m.index + m[0].indexOf('{');
        const close = matchBrace(src, open);
        if (close < 0) continue;
        const body = src.slice(open + 1, close);
        if (!body.includes(callMarker)) continue;
        const after = /\s*catch\s*\([^)]*\)\s*\{/.exec(src.slice(close + 1));
        if (!after) continue;                       // try/finally，没有吞 catch
        const catchOpen = close + 1 + after.index + after[0].length - 1;
        const catchClose = matchBrace(src, catchOpen);
        out.push({
            line: src.slice(0, m.index).split('\n').length,
            tryBody: body,
            catchBody: src.slice(catchOpen + 1, catchClose < 0 ? src.length : catchClose),
            tail: catchClose < 0 ? '' : src.slice(catchClose + 1, catchClose + 201)
        });
    }
    return out;
}

function matchBrace(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

// "这件发到了"的记录写法：塞进列表，或给 summary/result 的字段赋值。
const RECORDS = /\bpush\s*\(|\b(?:summary|result|rewards|data)\.[\w.]+\s*=[^=]/;
// catch 里出现这些，说明失败被记成了失败，而不是被抹平。
const FAILURE_MARKED = /rollback\(|return\s|throw\s+|\.error|\.destroyed|\bfailed\b|\bfail\b|\blost\b|\bskipped\b/i;

/**
 * 一处的 try 包裹 addItem 是不是在说谎。**说谎的形状是"记录与发放脱钩"**，
 * 而不是"catch 里只留了一行日志"：
 *   ① addItem 之前就先把这件记成已到手（发没发都不影响这条记录）；
 *   ② catch 里把它记成已到手，却没记成失败（背包满 → 摘要说"你拿到了"）；
 *   ③ 记录写在 try/catch 之后、引用的还是同一件（= 迁移前 CombatService 的写法）。
 * 反过来，"try 里 await addItem 之后再 push、catch 只 warn"是诚实的：抛错时那条记录根本不会执行。
 */
function isLyingGrant(tryBody, catchBody, tailAfterCatch) {
    const callIdx = tryBody.indexOf('InventoryService.addItem(');
    if (RECORDS.test(tryBody.slice(0, callIdx))) return '记录写在发放之前';
    if (RECORDS.test(catchBody) && !FAILURE_MARKED.test(catchBody)) return 'catch 里记成已到手，却没记成失败';
    const root = itemRootOf(tryBody.slice(callIdx));
    // 整词匹配：`drop` 命中 `drops:`/`memberClueDrops` 是字符串巧合，不是同一件东西
    if (root && RECORDS.test(tailAfterCatch) && new RegExp(`\\b${root}\\b`).test(tailAfterCatch)) {
        return '记录写在 try/catch 之外，抛错也照记';
    }
    return null;
}

/** addItem 第二个实参引用的是哪个变量（picked.item_key → picked；字面量 → null） */
function itemRootOf(fromCall) {
    let depth = 0, seen = 0, arg = '';
    for (let i = fromCall.indexOf('(') + 1; i < fromCall.length; i++) {
        const c = fromCall[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) { if (seen++ === 1) break; continue; }
        if (seen === 1) arg += c;
    }
    const id = /^\s*([A-Za-z_$][\w$]*)\s*[.\[]/.exec(arg);
    return id ? id[1] : null;
}

const HONEST_FILES = [
    'game/services/BeastInvasionService.js',
    'game/services/CombatService.js',
    'game/services/BeastAbyssService.js',
    'game/services/DungeonService.js',
    'game/services/MultiDungeonService.js',
    'game/services/BeastPastureService.js',
    'game/services/BorderMilitaryService.js',
    'game/services/BorderBeastPatrolSubService.js',
    'game/services/RemnantMapSubService.js'
];

beforeAll(async () => {
    await initializeModules();
});

describe('发奖结果必须可分辨：发到 / 没发到', () => {
    test('单件失败不连带其它件，失败的进 failed 并带原因', async () => {
        const real = InventoryService.addItem;
        InventoryService.addItem = async (playerId, key) => {
            if (key === 'bei_bao_man_de') throw new Error('背包容量不足');
        };
        try {
            const out = await grantItems(7, [
                { item_key: 'ling_ying_guo', quantity: 2 },
                { item_key: 'bei_bao_man_de', quantity: 1 },
                'spirit_herb'
            ], null, { label: 'test' });
            expect(out.granted.map(g => g.item_key)).toEqual(['ling_ying_guo', 'spirit_herb']);
            expect(out.granted[0]).toMatchObject({ quantity: 2 });
            expect(out.granted[1].quantity).toBe(1);          // 字符串条目：没写数量按 1 件
            expect(out.failed).toHaveLength(1);
            expect(out.failed[0].reason).toContain('背包容量不足');
        } finally {
            InventoryService.addItem = real;
        }
    });

    test('名字与键名都取自内容（引用字段名各家不同也认）', async () => {
        const real = InventoryService.addItem;
        const seen = [];
        InventoryService.addItem = async (playerId, key, qty) => { seen.push([key, qty]); };
        try {
            const out = await grantItems(7, [
                { item_id: 'zi_yun_shen', qty: 3 },
                { key: 'huanglong_merit_token', quantity: 1 },
                { material: 'unknown_so_no_name' }
            ], null, { label: 'test' });
            expect(seen).toEqual([['zi_yun_shen', 3], ['huanglong_merit_token', 1], ['unknown_so_no_name', 1]]);
            expect(out.granted.map(g => g.item_name)).toEqual(['紫云参', '黄龙军功牌', 'unknown_so_no_name']);
        } finally {
            InventoryService.addItem = real;
        }
    });

    test('摘要只报名字；全失败时明说而不是留空当成功', async () => {
        const granted = [{ item_key: 'zi_yun_shen', quantity: 2, item_name: '紫云参' }];
        const failed = [{ item_key: 'ju_yuan_dan', quantity: 1, item_name: '聚元丹', reason: '背包容量不足' }];
        expect(describeGrant(granted, failed).text).toBe('紫云参x2');
        expect(describeGrant([], failed).allFailed).toBe(true);
        expect(describeGrant([], []).allFailed).toBe(false);
        expect(describeGrant(granted).text).not.toContain('zi_yun_shen');
    });

    test('helper 不改动调用方传进来的那份列表（那是要落库的引用）', async () => {
        const real = InventoryService.addItem;
        InventoryService.addItem = async () => {};
        const entries = [{ item_key: 'zi_yun_shen', quantity: 1 }];
        try {
            await grantItems(7, entries, null, { label: 'test' });
        } finally {
            InventoryService.addItem = real;
        }
        expect(entries).toEqual([{ item_key: 'zi_yun_shen', quantity: 1 }]);
    });

    test('内容里的物品名在这条链上真的解析得出来（否则又会有裸键上屏）', () => {
        expect(itemName('zi_yun_shen')).toBe('紫云参');
    });
});

describe('发奖这一层不许退回去（全 game/ 树扫描，不靠手点文件）', () => {
    test('扫描器看得到这些文件与这层 helper（防空跑）', () => {
        for (const rel of HONEST_FILES) {
            if (!read(rel).includes('grantItems(')) throw new Error(`${rel} 不再走 grantItems() 了 —— 是退回 try/catch 吞失败，还是改名了？`);
        }
        expect(read('game/items/itemGrant.js')).toContain('InventoryService.addItem');
    });

    // 只盯 HONEST_FILES 的话，"漏掉的那个文件"就是"漏掉的那一整类"，
    // 所以这里遍历整棵树：凡是把 addItem 包在 try 里的地方，catch 都必须把失败记进
    // 一个**对外可分辨**的通道。诚实的写法三种：回滚整笔 / return 或 throw /
    // 把这件记到失败或跳过字段（CaveLegacy 储物袋满 → summary.destroyed，玩家看到的是"销毁了多少"）。
    const seen = [];
    const swallows = [];
    for (const abs of jsFilesUnder(path.join(serverRoot, 'game'))) {
        const src = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
        if (!src.includes('InventoryService.addItem(')) continue;
        const rel = path.relative(serverRoot, abs).replace(/\\/g, '/');
        for (const block of tryBlocksWrapping(src, 'InventoryService.addItem(')) {
            seen.push(`${rel}:${block.line}`);
            const lie = isLyingGrant(block.tryBody, block.catchBody, block.tail);
            if (lie) swallows.push(`${rel}:${block.line} —— ${lie}`);
        }
    }

    test('全树确实扫到了 try 里的 addItem（否则这条门禁是空跑）', () => {
        // 下界 6：helper 1 处 + 各服务里"整笔回滚/记失败字段/只 warn"的存量 try。
        // 数字往下掉说明 walk() 或配对逻辑断了，而不是代码变干净了 —— 那要改门禁，不是庆祝。
        if (seen.length < 6) throw new Error(`只扫到 ${seen.length} 处 try 包裹的 addItem，扫描器大概坏了（期望 ≥6）：\n  ${seen.join('\n  ')}`);
        expect(seen.length).toBeGreaterThanOrEqual(6);
    });

    test('发奖调用不许再回到"try/catch 一声不响 + 照旧上报"', () => {
        if (swallows.length) {
            throw new Error('这些发奖把失败吞在日志里，玩家摘要却照旧写"已获得"：\n  '
                + swallows.join('\n  ') + '\n改用 grantItems()，只把真发到的写进给玩家看的列表。');
        }
        expect(swallows).toEqual([]);
    });
});
