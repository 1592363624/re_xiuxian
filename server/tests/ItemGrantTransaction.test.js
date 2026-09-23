/**
 * addItem / removeItem 必须把事务传进来的静态闸（不连库）。
 *
 * 为什么盯这一条：InventoryService 的两个助手只在**拿到 transaction 时**才对 items 那一行
 * `lock: t.LOCK.UPDATE`（源码注释自己写着"必须在本事务内对该行加锁"）。
 * 少传一个参数，它们就退化成"读数量 → 在 JS 里 ± → 整值 save()"，而且整条链路不报错：
 * 玩家一边用丹药一边有人往同一堆材料上加，后写的那份按自己读到的旧数量覆盖对方 ——
 * 表现为物品凭空变多或变少（是经济漏洞形状，不只是脏数据）。
 *
 * 全仓 91 个调用点实测：88 个传了事务，2 个匹配到的是**函数定义本身**（默认参数），
 * 唯一漏传的是 routes/admin.js 的 GM 发物品（已改成事务包住）。
 * 所以这条闸现在是满的：以后新调用点少传事务就会红，而不是靠人记得。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const serverRoot = path.join(__dirname, '..');
const DIRS = ['game', 'routes', 'models', 'utils', 'middleware'];
const CALL_RE = /\b(?:this\.|[A-Za-z_$][\w$]*[.\-])?(addItem|removeItem)\s*\(/g;

function jsFilesUnder(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) jsFilesUnder(abs, out);
        else if (entry.name.endsWith('.js')) out.push(abs);
    }
    return out;
}

function codeOnly(src) {
    return src.replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 从 `(` 起配平取实参，按顶层逗号切开（嵌套括号/方括号/花括号都算深度） */
function argsAt(src, openIdx) {
    let depth = 0, cur = '', parts = [];
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { parts.push(cur); break; }
        } else if (c === ',' && depth === 1) { parts.push(cur); cur = ''; continue; }
        if (depth >= 1) cur += c;
    }
    return parts.map(p => p.trim()).filter((p, n) => !(n === 0 && p === '('));
}

/** 第 4 个实参（两个助手都是 (playerId, itemKey, quantity, transaction)）有没有事务的样子 */
function looksLikeTransaction(arg) {
    if (!arg) return false;
    return /^(t|tx|tr|transaction|[A-Za-z_$][\w$]*\.transaction\b|options\.transaction\b)/.test(arg)
        || /\btransaction\b/.test(arg) || /withTransaction/.test(arg);
}

/** 扫一份源码，返回漏传事务的调用点（定义行按"前一个词是 async"排除） */
function findUntransactionalCalls(src) {
    const offenders = [];
    const lines = src.split('\n');
    const starts = [];
    let acc = 0;
    for (const line of lines) { starts.push(acc); acc += line.length + 1; }
    for (const m of src.matchAll(CALL_RE)) {
        const before = src.slice(Math.max(0, m.index - 12), m.index);
        if (/async\s+$/.test(before)) continue;                 // 定义本身
        const open = src.indexOf('(', m.index);
        const args = argsAt(src, open);
        if (!looksLikeTransaction(args[3])) {
            offenders.push({
                line: starts.findIndex((s, n) => m.index >= s && (n === starts.length - 1 || m.index < starts[n + 1])) + 1,
                call: m[1], args: args.length
            });
        }
    }
    return offenders;
}

describe('发物品/扣物品必须带事务（否则 items 那一行没人锁）', () => {
    const all = [];
    beforeAll(() => {
        for (const dir of DIRS) {
            for (const file of jsFilesUnder(path.join(serverRoot, dir))) {
                const rel = path.relative(serverRoot, file).replace(/\\/g, '/');
                for (const hit of findUntransactionalCalls(codeOnly(fs.readFileSync(file, 'utf8')))) {
                    all.push(`${rel}:${hit.line} ${hit.call}(${hit.args} 个实参)`);
                }
            }
        }
    });

    test('生产代码里漏传事务的 addItem/removeItem 调用点必须为 0', () => {
        expect(all).toEqual([]);
    });

    test('扫描器真的看得见（控制跑：少一个参数必须被抓，带事务的必须放过）', () => {
        const sample = codeOnly(`
            async addItem(playerId, itemKey, quantity = 1, transaction = null, metadata = null) { return; }
            await InventoryService.addItem(pid, 'x', 1, t);
            await inventoryService.addItem(pid, 'y', 2);
            await InventoryService.removeItem(pid, 'z', 1, transaction);
            await InventoryService.removeItem(pid, 'w');
        `);
        const hits = findUntransactionalCalls(sample);
        expect(hits).toHaveLength(2);
        expect(hits.map(h => `${h.call}@${h.args}`).sort()).toEqual(['addItem@3', 'removeItem@2']);
        // 定义行没被算进来（它第 4 个"实参"是默认值 `transaction = null`，会被误判成有事务）
        expect(hits.some(h => h.line === 2)).toBe(false);
    });

    test('这条闸认识的两个助手签名没被人改掉（改了就要同步这里的实参位次）', () => {
        const src = codeOnly(fs.readFileSync(path.join(serverRoot, 'game/services/InventoryService.js'), 'utf8'));
        expect(src).toMatch(/async addItem\(\s*playerId,\s*itemKey,\s*quantity = 1,\s*transaction = null/);
        expect(src).toMatch(/async removeItem\(\s*playerId,\s*itemKey,\s*quantity = 1,\s*transaction = null\s*\)/);
        // 而且"没事务就不加锁"这句话仍然成立 —— 哪天助手改成自带事务，本闸的前提就变了，要重新判
        expect(src).toMatch(/lock:\s*transaction \? transaction\.LOCK\.UPDATE : undefined/);
    });
});
