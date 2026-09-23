/**
 * 「神识」这一份余额只有一处读、一处增减（2026-09-23，把元婴出窍四条链的整块写回迁掉时收的口）
 *
 * 起因与"灵兽稀有度"那一族同形：一个键（`players.attributes.sense`）被六七个玩法各自实现过一遍，
 * 而每一份实现都只对自己那条链正确 ——
 *   · 飞升（AscensionService）与第二元神（SecondSoulService）逐字抄了同一对
 *     `getDivineSense` + `consumeDivineSense`（形状对，但重复两份）；
 *   · 轮回（ReincarnationService）又抄了第三份读法；
 *   · 元婴出窍（NascentSoulService）四条流程各自"摊平整份 attributes → 改 sense → 赋回实例 → save 整行"，
 *     四份兜底还各不相同：`|| 境界基数`、`|| 10`、`|| 10`、`Number() || 0`。
 *   · 更要紧的是 `attrs.sense || 兜底` 把 **0 读成"键不存在"** —— 神识是可以正常花光的
 *     （`current < cost` 才拒绝，等于就通过 → 正好扣到 0），于是"把神识用光的人"下一次进这些流程
 *     会白拿一份兜底余额，再扣掉一次消耗。这是 §"抬配置不等于关功能：`x || default` 会吃掉 0" 同一族。
 *
 * 所以这里钉三件事：① 语义（0 是余额、不是缺失；负数夹到 0；字符串 blob 能解析）；
 * ② 写库形状（键级 `$add` + `$min: 0`、复用调用方事务、$min 生效时回执报**真正生效**的增量）；
 * ③ 不许回潮（全仓再出现第二份 sense 的整块写/兜底读，或有人绕过 sensePool 自己实现一份，就红）。
 * 判据都配了"喂旧文本进同一个扫描器"的反证，否则一条 0 命中的断言等于没写。
 *
 * 端到底进没进库、并发扣费会不会互相抹，是 scripts/smoke_soul_blob_writes.js 的活（连库）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');

/* 必须在 require sensePool 之前挂好 mock：它在模块加载时就 require 持久层 */
const mockStoreCalls = [];
const mockSenseKey = 'sense';      // 与被测模块同一个键；对不上时下面那条补丁形状断言会红
jest.mock('../game/persistence/PlayerStateStore', () => {
    return {
        __esModule: true,
        // 假装"锁内那份"就是这里给的 before，然后按 mergeBlobPatch 的 $add/$min 语义算完返回。
        // 真库上的同一件事由 scripts/smoke_soul_blob_writes.js 断（这里只钉"发出去的是什么补丁"）。
        patchPlayerState: jest.fn(async (id, patch = {}, options = {}) => {
            const before = Number(mockStoreCalls.beforeFor ?? 0);
            const deltaPatch = (patch.attributes || {})[mockSenseKey];
            const after = deltaPatch && '$add' in deltaPatch
                ? Math.max(deltaPatch.$min ?? -Infinity, before + deltaPatch.$add)
                : before;
            mockStoreCalls.push({ id, patch, transaction: options.transaction, after });
            return { getDataValue: () => ({ [mockSenseKey]: after }), attributes: { [mockSenseKey]: after } };
        }),
        mirrorPatchedBlob: jest.fn((instance, updated) => ({ mirrored: instance, updated }))
    };
});

const sensePool = require('../game/core/sensePool');

const playerWith = (sense, over = {}) => ({ id: 7, attributes: sense === undefined ? {} : { sense }, ...over });

describe('语义：0 是余额，不是"这个键不存在"', () => {
    test('有键取值，脏值与缺键才用兜底', () => {
        expect(sensePool.senseOf(playerWith(123))).toBe(123);
        expect(sensePool.senseOf(playerWith(undefined), 10)).toBe(10);
        expect(sensePool.senseOf(playerWith('abc'), 10)).toBe(10);      // 脏值不能变成 NaN 传下去
        expect(sensePool.senseOf(null, 10)).toBe(10);
        expect(sensePool.senseOf(playerWith(5), 'x')).toBe(5);
        expect(sensePool.senseOf(playerWith(undefined), 'x')).toBe(0);  // 兜底本身不是数就归 0
    });

    test('余额 0 就是 0：传了兜底也不给它复活（旧写法 `attrs.sense || 10` 会白送一次消耗）', () => {
        expect(sensePool.senseOf(playerWith(0), 10)).toBe(0);
        expect(sensePool.senseOf(playerWith(0), 500)).toBe(0);
        expect(sensePool.canSpend(playerWith(0), 1)).toBe(false);
        expect(sensePool.canSpend(playerWith(10), 10)).toBe(true);       // 恰好等于余额可以花光（旧语义下花光后会复活）
        expect(sensePool.canSpend(playerWith(0), 0)).toBe(true);
        expect(sensePool.canSpend(playerWith(5), -1)).toBe(false);       // 负消耗不是"白捡"，直接算不合法
    });

    test('负数余额夹到 0（历史上 `兜底 − 消耗` 能写出负数），字符串 blob 也读得动', () => {
        expect(sensePool.senseOf(playerWith(-40))).toBe(0);
        expect(sensePool.senseOf({ id: 7, attributes: JSON.stringify({ sense: 33 }) })).toBe(33);
        expect(sensePool.senseOf({ id: 7, attributes: '{不是JSON' }, 8)).toBe(8);
    });
});

describe('写库形状：键级 $add + 行锁内 $min，回执只报真正生效的那一笔', () => {
    beforeEach(() => { mockStoreCalls.length = 0; });

    test('扣费发的是 { attributes: { sense: { $add: -cost, $min: 0 } } }，且带上调用方事务', async () => {
        mockStoreCalls.beforeFor = 100;
        const player = playerWith(100);
        const t = { fake: 'transaction' };
        const change = await sensePool.spendSense(player, 30, { transaction: t });

        expect(mockStoreCalls).toHaveLength(1);
        expect(mockStoreCalls[0].id).toBe(7);
        expect(mockStoreCalls[0].patch).toEqual({ attributes: { sense: { $add: -30, $min: 0 } } });
        expect(mockStoreCalls[0].transaction).toBe(t);        // 不自开连接（§50 那一族：事务里再开一条会自锁）
        expect(change).toEqual({ before: 100, after: 70, delta: -30 });
    });

    test('余额不够时 $min 在锁内夹住，回执报的是实际生效的 -3 而不是请求的 -10', async () => {
        mockStoreCalls.beforeFor = 3;
        const change = await sensePool.spendSense(playerWith(3), 10, { transaction: {} });
        expect(change).toEqual({ before: 3, after: 0, delta: -3 });
    });

    test('0 消耗一次库都不写（不为了"扣 0"去自增 state_version）', async () => {
        for (const cost of [0, undefined, NaN, '0']) {
            expect(await sensePool.spendSense(playerWith(50), cost, { transaction: {} })).toEqual({ before: 50, after: 50, delta: 0 });
        }
        expect(mockStoreCalls).toHaveLength(0);
    });

    test('增加走同一份形状（$add: +gain），并且没有玩家实例时直接抛而不是悄悄写库', async () => {
        mockStoreCalls.beforeFor = 20;
        const change = await sensePool.grantSense(playerWith(20), 5, { transaction: {} });
        expect(mockStoreCalls[0].patch.attributes.sense).toEqual({ $add: 5, $min: 0 });
        expect(change.after).toBe(25);
        await expect(sensePool.spendSense(null, 5, {})).rejects.toThrow(/玩家实例/);
    });
});

/* ==================== 不许回潮：整份仓库只许有一处实现 ==================== */

function walkJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkJs(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const SOURCE_FILES = [...walkJs(path.join(serverRoot, 'game')), ...walkJs(path.join(serverRoot, 'routes'))];

// 扫描器不剥注释会自己坑自己（§51），所以判据只看代码行
function codeLines(text) {
    return text.replace(/\r\n/g, '\n').split('\n').filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
}

const SENSE_SHAPES = [
    { name: '往 blob 里整块赋 sense', re: /\battrs?\.sense\s*=(?!=)/ },
    { name: '读时 `|| 兜底`（会把 0 当缺失）', re: /\battrs?\.sense\s*\|\|/ },
    { name: '绕过读取口点写 attributes.sense', re: /attributes\.sense\s*=(?!=)/ }
];

function scanSense(text) {
    return codeLines(text).filter(line => SENSE_SHAPES.some(s => s.re.test(line)));
}

describe('扫描器自己得先被证明能抓到旧写法（不然"0 命中"是假的）', () => {
    test('HEAD 里那段真实旧文本被点到两处；整块写回那一处由 ContentIntegrity 负责', () => {
        const oldText = [
            '            const attrs = typeof player.attributes === \'string\'',
            '                ? JSON.parse(player.attributes)',
            '                : (player.attributes || {});',
            '            const currentSense = attrs.sense || baseSense;',
            '            attrs.sense = currentSense - senseCost;',
            '            player.attributes = attrs;',
            '            await player.save({ transaction: t });'
        ].join('\n');
        // 兜底读 + 往 blob 里赋 sense。`player.attributes = attrs` 是"整块写回"那一族，
        // 判据在 tests/ContentIntegrity.test.js（它按整块列名扫，不认具体键）。
        expect(scanSense(oldText)).toHaveLength(2);
    });

    test('三条判据各抓各的，不多不少（合成文本）', () => {
        const cases = [
            ['attrs.sense = 3;', 1],
            ['const v = attrs.sense || 10;', 1],
            ['attributes.sense = 3;', 1],
            ['const v = attrs.sense;', 0],                    // 只读不是命中
            ['const v = Number(attrs.sense) || 0;', 0],       // 上面那行就是这种写法，别把它算成命中
            ['// attrs.sense = 3', 0],                        // 注释行不算（扫描器不剥注释会自己坑自己）
            ['attrs.sense == 3;', 0]                          // 比较不是赋值
        ];
        for (const [text, want] of cases) expect(scanSense(text)).toHaveLength(want);
    });
});

describe('神识读写只在 game/core/sensePool.js 一处', () => {
    test('game/ 与 routes/ 里再没有第二份 sense 的整块写或兜底读', () => {
        const offenders = [];
        for (const file of SOURCE_FILES) {
            const relative = path.relative(serverRoot, file).split(path.sep).join('/');
            if (relative === 'game/core/sensePool.js') continue;
            const hits = scanSense(fs.readFileSync(file, 'utf8'));
            if (hits.length) offenders.push(`${relative}: ${hits.length} 处 → ${hits[0].trim()}`);
        }
        expect(offenders).toEqual([]);
    });

    test('四条元婴流程都在用这一份，且本地不再留 `getDivineSense` 那种自实现', () => {
        const nascent = fs.readFileSync(path.join(serverRoot, 'game/services/NascentSoulService.js'), 'utf8');
        expect((nascent.match(/sensePool\.senseOf\(/g) || []).length).toBe(4);
        expect((nascent.match(/sensePool\.spendSense\(/g) || []).length).toBe(4);
        // 三个转调侧：必须 import 这一份、必须用它读、且本地那份自实现已经不在了
        const problems = [];
        for (const file of ['game/services/AscensionService.js', 'game/services/SecondSoulService.js', 'game/services/ReincarnationService.js']) {
            const src = fs.readFileSync(path.join(serverRoot, file), 'utf8');
            if (!src.includes("require('../core/sensePool')")) problems.push(`${file} 没有 require sensePool`);
            if (!src.includes('sensePool.senseOf(player)')) problems.push(`${file} 没有用 sensePool.senseOf`);
            if (codeLines(src).some(l => /return Number\(\s*attrs\.sense/.test(l))) problems.push(`${file} 还留着自己的那份读法`);
        }
        expect(problems).toEqual([]);
        // 飞升那份还带"加神识"，也必须走同一处
        expect(fs.readFileSync(path.join(serverRoot, 'game/services/AscensionService.js'), 'utf8')).toContain('sensePool.grantSense(');
    });

    test('sensePool 只发增量补丁（$add + $min），不许改成整值写', () => {
        const store = fs.readFileSync(path.join(serverRoot, 'game/persistence/PlayerStateStore.js'), 'utf8');
        expect(store).toContain('if (value.$min !== undefined)');
        const pool = fs.readFileSync(path.join(serverRoot, 'game/core/sensePool.js'), 'utf8');
        expect(pool).toContain('{ $add: amount, $min: 0 }');
        // 不许有人把神识"顺手"改成"读旧值 + 写绝对值"（那会绕过锁内的非负判定，也回到旧快照那一族）
        expect(pool).not.toMatch(/attributes:\s*\{\s*\[KEY\]:\s*after/);
        expect(pool).not.toMatch(/attributes:\s*\{\s*\[KEY\]:\s*Number\(/);
    });
});
