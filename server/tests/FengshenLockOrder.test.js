/**
 * 封神台锁顺序静态门禁
 *
 * 为什么需要它：FengshenService 的三条写路径（setDefense / challengeRank / settleSeason）都要在一笔事务里
 * 同时锁 players 和 fengshen_rankings。锁"对不对"取决于**语句先后**，而并发探针压不出这种错 ——
 * smoke_fengshen_defense 量过：整表升序加锁 33ms、单笔 setDefense 346ms，"持锁再伸手"的窗口只占 10%，
 * 6 路 × 8 轮 48 次并发一次都没撞上（F6）。真正能判定的是 F7 那种把窗口钉死的语句顺序差分，
 * 而差分只能证明"当下这一版"，管不住以后有人新增一条写路径又按调用顺序随手加锁。
 * 所以这里把契约钉在源码结构上：
 *   players(按 id 升序) → fengshen_rankings(按 id 升序) → 写
 * 任何单行 FOR UPDATE 之前，必须先有一步升序的整表/整批取锁。
 *
 * 说明这是**按方法体切块**的文本扫描：它能看见"本方法内先锁了什么"，
 * 也必须在计数上自检（最后一条 test），否则改名或换写法会让门禁悄悄变成空跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '..', 'game/services/FengshenService.js');
const source = fs.readFileSync(SOURCE_FILE, 'utf-8').replace(/\r\n/g, '\n');

/** 把 class 里的方法切成块；辅助方法里发起的锁会出现在调用方的块里，所以按方法体切是够用的 */
function splitMethods(src) {
    return src.split('\n    async ')
        .slice(1)
        .map(chunk => {
            const name = (chunk.match(/^(\w+)\(/) || [])[1];
            return name ? { name, body: chunk } : null;
        })
        .filter(Boolean);
}

const methods = splitMethods(source);
const byName = new Map(methods.map(m => [m.name, m.body]));

/** 方法体内所有查询调用的位置；用"到下一个调用为止"当一处查询的选项范围，避免把下一条语句的 lock: 算进来 */
const CALL_RE = /\b(Player|FengshenRanking)\.(findOne|findByPk|findAll)\(/g;

function callsIn(body) {
    const calls = [];
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(body)) !== null) {
        calls.push({ model: m[1], kind: m[2], index: m.index, end: m.index + m[0].length });
    }
    for (let i = 0; i < calls.length; i++) {
        calls[i].block = body.slice(calls[i].end, i + 1 < calls.length ? calls[i + 1].index : calls[i].end + 500);
    }
    return calls;
}

/** 该模型在本方法里**带 lock** 的查询点，按出现顺序 */
function lockSites(body, model) {
    return callsIn(body).filter(c => c.model === model && /lock:/.test(c.block));
}

describe('封神台写路径的锁顺序契约', () => {
    test('扫描器看到的是真文件，方法切块没有静默失效', () => {
        // 门禁最怕"0 处命中 = 通过"。这里先把"应该扫到多少处锁"钉住。
        expect(methods.length).toBeGreaterThan(8);
        for (const name of ['setDefense', 'challengeRank', 'settleSeason', '_recalculateRanks',
            '_lockPlayersByIdAsc', '_lockRankingsByIdAsc']) {
            expect(byName.has(name)).toBe(true);
        }
        const totalRankLocks = methods.reduce((n, m) => n + lockSites(m.body, 'FengshenRanking').length, 0);
        const totalPlayerLocks = methods.reduce((n, m) => n + lockSites(m.body, 'Player').length, 0);
        // 数目是按"批量升序锁一次就把整行读回来"这一版量出来的（2026-09-21）：调用方不再逐行补 FOR UPDATE，
        // 所以 players 的锁点收敛到助手函数里那一处 —— 这不是漏扫，恰恰是契约要的样子：
        // 锁只在助手里发一次，调用方只认助手返回的那批行。真正防"改名/换写法把门禁变空跑"的是下面两条。
        expect(totalRankLocks).toBeGreaterThanOrEqual(3);
        expect(lockSites(byName.get('_lockPlayersByIdAsc'), 'Player')).toHaveLength(1);
        // 排名助手把 options 提到变量里再传，本文件的"到下一个调用为止"窗口看不到那条 lock:
        // —— 这是本测试自己扫描器的粗糙处（与 LockOrderCensus 里那两条判例同源），所以直接查源码文本。
        expect(byName.get('_lockRankingsByIdAsc')).toMatch(/lock:\s*t\.LOCK\.UPDATE/);
        expect(totalPlayerLocks).toBeGreaterThanOrEqual(1);
    });

    test('单行排名锁之前一定先有升序整批取锁（不允许"先锁自己那行、再扫全表"）', () => {
        const offenders = [];
        for (const { name, body } of methods) {
            if (name === '_lockRankingsByIdAsc') continue;
            const singleRow = lockSites(body, 'FengshenRanking').filter(s => s.kind !== 'findAll');
            if (!singleRow.length) continue;
            const prepared = body.search(/this\._lockRankingsByIdAsc\(/);
            const swept = body.search(/this\._recalculateRanks\(/);
            const firstPrepared = [prepared, swept].filter(i => i >= 0).sort((a, b) => a - b)[0];
            if (firstPrepared === undefined || firstPrepared > singleRow[0].index) {
                offenders.push(`${name}() 先锁了单行排名记录（${singleRow[0].kind}），之后才升序取锁`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('players 行锁之前一定先有 _lockPlayersByIdAsc（跨表次序：players 先于 rankings）', () => {
        const offenders = [];
        for (const { name, body } of methods) {
            if (name === '_lockPlayersByIdAsc') continue;
            const sites = lockSites(body, 'Player');
            if (!sites.length) continue;
            const prepared = body.search(/this\._lockPlayersByIdAsc\(/);
            if (prepared < 0 || prepared > sites[0].index) {
                offenders.push(`${name}() 在 ${sites[0].kind} 上加了 players 行锁，却没先按 id 升序批量取锁`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('每一处 FOR UPDATE 的多行扫描都按 id 升序，不按积分/名次序', () => {
        // 按 fengshen_score 取锁 = 每笔事务看到的加锁次序不同 → 并发结算互相成环（改造前就是这样）。
        const offenders = [];
        for (const { name, body } of methods) {
            for (const site of lockSites(body, 'FengshenRanking')) {
                if (site.kind !== 'findAll') continue;
                const block = site.block;
                if (!/\['id',\s*'ASC'\]/.test(block)) offenders.push(`${name}() 的整表 FOR UPDATE 没有 ORDER BY id ASC`);
                if (/fengshen_score',\s*'DESC'/.test(block)) offenders.push(`${name}() 的整表 FOR UPDATE 仍按积分序取锁`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('两个取锁助手自己按数值升序排 id（传参顺序不能影响加锁次序）', () => {
        for (const name of ['_lockPlayersByIdAsc', '_lockRankingsByIdAsc']) {
            expect(byName.get(name)).toMatch(/\.sort\(\(a, b\) => a - b\)/);
        }
    });
});
