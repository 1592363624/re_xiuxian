/**
 * 原生 JSON 列的"同引用赋回"必须为零（静态棘轮闸，不连库）
 *
 * 盯的缺陷形状：DataTypes.JSON 列的 getter 返回库里那份对象的**引用**。
 * 于是 `const a = row.col; a.push(x); row.col = a; save()` 里 `changed('col')` 为 false，
 * `save()` 不带这一列 → 改动静默不落地。这不是推测：2026-09-21 用真库对
 * spirit_beast_pastures.steal_yields 实测过 —— 赋回同引用 changed=false 且库里长度不变，
 * 赋新数组 changed=true 才写得进去。**不需要并发，一次请求就丢**，
 * 所以它是"旧快照覆盖新快照"这一族里更隐蔽的成员。
 *
 * 两条不让它误伤自己的规矩（这一轮被自己咬出来两次）：
 *  1) 只判**原生 JSON 列**，而且要是**该文件 import 的那些模型**上的原生 JSON 列。
 *     第一版只看列名，报了 15 处：其中 7 处定义在 `TEXT + get(){JSON.parse} + set(){JSON.stringify}`
 *     上（每次读都造一个新对象，赋回去必然与库里那份字符串不同，照样落库，根本不是缺陷），
 *     另有 1 处是 activeBattle.battle_log(TEXT) 撞了 spiritBeastPvpMatch.battle_log(JSON) 这个名字。
 *  2) 认 `row.changed('col', true)` 这个显式逃生口 —— TaoismGateService 那处早就用它强制标脏，
 *     再判违规就是逼人多抄一层没用的拷贝。
 *
 * 存量：2026-09-21 逐条看完后为 **0**（唯一真丢过写的 steal_yields 已改，
 * 并在 scripts/smoke_title_grant.js 里留了"旧写法确实不落库"的对照腿）。
 * 所以这张表现在是纯防新增的网：REGISTERED 应保持为空，往里加的人要写清凭什么。
 */
'use strict';

const { modelJsonColumns, nativeJsonColumns, serverSources } = require('./helpers/blobColumns');

const ALL_BLOB_COLUMNS = modelJsonColumns();
const NATIVE = nativeJsonColumns();
const sources = serverSources();

/** 列名 → 哪些模型上它是原生 JSON 列 */
const nativeByColumn = new Map();
for (const { model, column } of NATIVE) {
    if (!nativeByColumn.has(column)) nativeByColumn.set(column, new Set());
    nativeByColumn.get(column).add(model);
}

/** 这个文件 import 了哪些模型（含 handler 内部就地 require） */
function importedModels(src) {
    const out = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\('[^']*\/models\/([A-Za-z0-9_.]+)'\)/g)) {
        out.add(m[1]);
    }
    return out;
}

/**
 * 抹掉注释但保留换行与列位置（行号仍然准）。
 * 行尾注释也要剥：控制跑时我顺手在还原的那行后面加了句注释，
 * 判定式因为行尾有注释整行没匹配上，闸门当场假绿。
 */
function stripComments(src) {
    return src.replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^\s*|\s)\/\/.*$/gm, '$1');
}

const ESCAPE_WINDOW = 8;   // changed('col', true) 允许写在赋值行之后几行内

/**
 * @param {string} src 单份源码
 * @param {Set<string>} fileColumns 该文件可判定的原生 JSON 列名（按它 import 的模型算）
 */
function scan(src, fileColumns) {
    const lines = stripComments(src).split('\n');
    const hits = [];
    const bound = new Map();              // 局部变量 → { column, receiver }
    lines.forEach((line, i) => {
        const decl = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\.([a-z_]+)\s*(?:\|\|\s*(?:\[\]|\{\}))?\s*;?\s*$/);
        if (decl && fileColumns.has(decl[3])) bound.set(decl[1], { column: decl[3], receiver: decl[2] });

        const back = line.match(/([A-Za-z_$][\w$.]*)\.([a-z_]+)\s*=\s*([A-Za-z_$][\w$]*)\s*;/);
        if (!back || !fileColumns.has(back[2])) return;
        const origin = bound.get(back[3]);
        // 只有"读的是这一个对象、赋回的也还是这一个对象"才算这一族
        if (!origin || origin.column !== back[2] || origin.receiver !== back[1]) return;

        const nearby = lines.slice(i + 1, i + 1 + ESCAPE_WINDOW).join('\n');
        if (new RegExp(`\\.changed\\(\\s*['"]${back[2]}['"]\\s*,\\s*true\\s*\\)`).test(nearby)) return;
        hits.push({ column: back[2], at: i + 1 });
    });
    return hits;
}

/** 每个文件按它自己 import 的模型决定"哪些列名算原生 JSON 列" */
function tally() {
    const byKey = new Map();
    for (const s of sources) {
        const models = importedModels(s.src);
        const fileColumns = new Set(
            [...nativeByColumn.entries()]
                .filter(([, owners]) => [...owners].some(m => models.has(m)))
                .map(([col]) => col)
        );
        if (!fileColumns.size) continue;
        for (const hit of scan(s.src, fileColumns)) {
            const key = `${s.rel}::${hit.column}`;
            const row = byKey.get(key) || { count: 0, lines: [] };
            row.count++;
            row.lines.push(hit.at);
            byKey.set(key, row);
        }
    }
    return byKey;
}

/** 谁要往这里加，必须写清"这一处为什么允许存在"（而不是先加进来再说） */
const REGISTERED = {};

describe('原生 JSON 列不许"同引用赋回"（赋回同一对象 = Sequelize 不写这一列）', () => {
    test('检测器不是空跑：认得坏形状，也不误伤四种合法写法', () => {
        const fake = [
            "const Foo = require('../models/foo');",
            'async function bad(row) {',
            '  const list = row.some_json_col || [];',
            '  list.push({ a: 1 });',
            '  row.some_json_col = list;',                       // 同引用赋回 → 必须命中（第 5 行）
            '}',
            'async function good(row) {',
            '  const copy = [...(row.some_json_col || [])];',
            '  copy.push({ a: 1 });',
            '  row.some_json_col = copy;',                       // 新数组 → 不许命中
            '}',
            'async function force(row) {',
            '  const same = row.some_json_col || [];',
            '  same.push({ a: 1 });',
            '  row.some_json_col = same;',                        // 同引用，但下一行显式标脏 → 不许命中
            "  row.changed('some_json_col', true);",
            '}',
            'async function other(row) {',
            '  const list2 = row.some_json_col || [];',
            '  another.some_json_col = list2;',                   // 赋给别的对象 → 不属于这一族
            '}',
            'function commented(row) { /* row.some_json_col = same; */ }'   // 注释里的不算
        ].join('\n');
        nativeByColumn.set('some_json_col', new Set(['foo']));
        const found = scan(fake, new Set(['some_json_col'])).map(h => h.at);
        nativeByColumn.delete('some_json_col');
        expect(found).toEqual([5]);
    });

    test('判定范围非空：现网确有整块列与原生 JSON 列（模型写法一变就要当场知道）', () => {
        // 2026-09-21 实测：整块列 53 条，其中原生 JSON 列 24 条；服务端源文件 224 个
        expect(new Set(ALL_BLOB_COLUMNS.map(c => c.at)).size).toBeGreaterThanOrEqual(50);
        expect(NATIVE.length).toBeGreaterThanOrEqual(20);
        expect(sources.length).toBeGreaterThanOrEqual(200);
    });

    test('原生 JSON 列上的"同引用赋回"处数与登记完全一致（多一处红，少一处也红）', () => {
        const found = tally();
        const problems = [];
        for (const [key, entry] of Object.entries(REGISTERED)) {
            const hit = found.get(key);
            if (!hit) { problems.push(`${key} 已经没有命中了 —— 把登记删掉，并说明是怎么验的`); continue; }
            if (hit.count !== entry.count) {
                problems.push(`${key} 命中 ${hit.count} 处，登记的是 ${entry.count}（行号 ${hit.lines.join(',')}）`);
            }
            expect(entry.reason.length).toBeGreaterThan(20);
        }
        for (const [key, hit] of found) {
            if (!REGISTERED[key]) {
                problems.push(`${key} 命中（行号 ${hit.lines.join(',')}）：改成"复制成新对象再赋回"，`
                    + `或确实需要就地改就在赋值后加 row.changed('${key.split('::')[1]}', true)，`
                    + '再不行才登记并写清依据');
            }
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    test('扫描器认得出真丢过写的那一处：现网是修好的，还原成旧写法就必须命中（防空跑）', () => {
        const fixed = sources.find(s => s.rel === 'game/services/BeastPastureService.js');
        if (!fixed) throw new Error('BeastPastureService.js 不在了 —— 这条闸已经在看不到东西');
        const cols = new Set(['steal_yields', 'yield_snapshot', 'beast_snapshot']);
        expect(scan(fixed.src, cols).map(h => h.column)).not.toContain('steal_yields');

        const regressed = fixed.src.replace(
            /const stealYields = Array\.isArray\(pasture\.steal_yields\)[^;]*;/,
            'const stealYields = pasture.steal_yields || [];'
        );
        expect(regressed).not.toBe(fixed.src);                 // 替换没生效就等于空跑
        expect(scan(regressed, cols).map(h => h.column)).toContain('steal_yields');
    });
});
