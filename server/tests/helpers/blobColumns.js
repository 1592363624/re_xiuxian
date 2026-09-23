/**
 * 测试用共享检测器：模型里哪些列是"整块 JSON 列"，其中哪些是**原生 JSON 列**。
 *
 * 为什么单独一个文件：BlobColumnCensus 与 JsonColumnSameRefWrite 都要同一份"什么算整块列"的判据，
 * 各自抄一份就会漂移（模型写法一变，一道闸还绿着、另一道已经在看不到东西）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..', '..');

/** 一个模型文件里的 `    col: { … }` 属性定义体（同名只保留第一处） */
function attributeBodies(src) {
    const map = new Map();
    for (const m of src.matchAll(/^\s{4}([a-z][a-z0-9_]*):\s*\{([\s\S]*?)^\s{4}\},?$/gm)) {
        if (!map.has(m[1])) map.set(m[1], m[2]);
    }
    return map;
}

/** 模型里的整块 JSON 列：DataTypes.JSON，或 getter+setter 成对做 JSON.parse/stringify */
function modelJsonColumns(modelDir = path.join(SERVER_ROOT, 'models')) {
    const found = [];
    for (const file of fs.readdirSync(modelDir).filter(n => n.endsWith('.js'))) {
        const model = file.replace(/\.js$/, '');
        const src = fs.readFileSync(path.join(modelDir, file), 'utf8');
        for (const [column, body] of attributeBodies(src)) {
            const isBlob = /DataTypes\.JSON/.test(body)
                || (/JSON\.parse/.test(body) && /JSON\.stringify/.test(body));
            if (isBlob) found.push({ model, column, at: `${model}.${column}`, body });
        }
    }
    return found;
}

/**
 * 其中**原生 JSON 列**（DataTypes.JSON 且 getter 不重新 parse）才是"同引用赋回"会丢写的地方：
 * 这种列的 getter 直接返回库里那份对象的引用，`const a = row.col; a.push(x); row.col = a;`
 * 之后 changed() 判成没改，save() 不带这一列（真库实测 spirit_beast_pastures.steal_yields）。
 *
 * 反面教训（2026-09-21，我自己踩的）：把"整块列"一网打尽地当成这一族的受害者，量出 15 处，
 * 其中 7 处其实定义在 TEXT + "get 里 JSON.parse / set 里 JSON.stringify" 上
 * （players.titles、playerEquipment.deep_line_state、activeBattle.battle_log、
 * playerDivineTemple.offering_pool、playerSect.daily_quests_completed）——
 * 那种列每次读都 parse 出一个新对象，赋回去必然与库里的字符串不同，照样落库，不是缺陷。
 * 所以这一条判定只看原生 JSON 列。
 */
function nativeJsonColumns(modelDir = path.join(SERVER_ROOT, 'models')) {
    return modelJsonColumns(modelDir)
        .filter(({ body }) => /DataTypes\.JSON/.test(body) && !/JSON\.parse/.test(body))
        .map(({ model, column, at }) => ({ model, column, at }));
}

/** 模型里的 TEXT/STRING 列（且不是上面那种成对 parse/stringify 定义） */
function modelTextColumns(modelDir = path.join(SERVER_ROOT, 'models')) {
    const found = [];
    for (const file of fs.readdirSync(modelDir).filter(n => n.endsWith('.js'))) {
        const model = file.replace(/\.js$/, '');
        const src = fs.readFileSync(path.join(modelDir, file), 'utf8');
        for (const [column, body] of attributeBodies(src)) {
            const declaredJson = /DataTypes\.JSON/.test(body)
                || (/JSON\.parse/.test(body) && /JSON\.stringify/.test(body));
            if (!declaredJson && /DataTypes\.(TEXT|STRING)/.test(body)) {
                found.push({ model, column, at: `${model}.${column}` });
            }
        }
    }
    return found;
}

/**
 * **实际上被当整块 JSON 读写**的 TEXT/STRING 列。
 * 判据只认确证：某处代码写 `.col = JSON.stringify(`，或读 `JSON.parse(<表达式>.col`。
 *
 * 为什么必须把这一类也算进"整块列"：`players.attributes` 那套 blobWriteGuard / 户口册本来是为了
 * 根治"读出来改一改、再整块写回 → 把别人这段时间写的键抹掉"，而这一族缺陷**与列的声明类型无关**：
 * 公告 metadata、历练 event_data/rewards、切磋与 PvP 的 battle_log 都是 TEXT 列，
 * 按类型检测完全看不见 —— 于是那份"闭合清单"其实漏了 12 个真正在装整块对象的列。
 */
function pseudoJsonColumns(modelDir = path.join(SERVER_ROOT, 'models'), src = serverSources()) {
    const hits = [];
    for (const { model, column, at } of modelTextColumns(modelDir)) {
        const reWrite = new RegExp(`\\.${column}\\s*=\\s*JSON\\.stringify\\(`);
        const reRead = new RegExp(`JSON\\.parse\\(\\s*[^;]{0,40}\\.${column}\\b`);
        const files = src.filter(s => reWrite.test(s.src) || reRead.test(s.src)).map(s => s.rel);
        if (files.length) hits.push({ model, column, at, files });
    }
    return hits;
}

/** 服务端源码（不含 models/tests） */
function serverSources(dirs = ['game', 'routes', 'modules', 'state', 'core']) {
    const out = [];
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'tests') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.js')) out.push(full);
        }
    };
    for (const d of dirs) {
        const abs = path.join(SERVER_ROOT, d);
        if (fs.existsSync(abs)) walk(abs);
    }
    return out.map(f => ({
        rel: path.relative(SERVER_ROOT, f).split(path.sep).join('/'),
        src: fs.readFileSync(f, 'utf8')
    }));
}

module.exports = {
    modelJsonColumns, nativeJsonColumns, modelTextColumns, pseudoJsonColumns,
    attributeBodies, serverSources, SERVER_ROOT
};
