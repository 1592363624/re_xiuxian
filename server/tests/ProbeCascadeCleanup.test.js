/**
 * 探针收尾的棘轮：删 players 行只准走 PlayerCascadePurge（任务 #24）
 *
 * 为什么要这一条：`scripts/` 下 35 个探针各自手写"收尾要清哪几张表"（`smoke_duel` 与 `smoke_bounty`
 * 甚至各抄了一份同名 `wipe()`，清的还是同一张表），漏一张就在隔离库留一排孤儿行。而任务 #22 之后
 * 级联清理已经按 `information_schema` 现查表清单 —— 新玩法多一张带 player_id 的表，探针不需要跟着改；
 * 反过来，只要探针还写着"自己点名清哪几张"，那张表就永远在无人负责的状态。
 *
 * 两条判据：
 *   1. **过渡名单只许变小**：名单与实测的"直接删号、没走级联"文件集合必须严格相等。
 *      多一条（新写了个自己删号的探针）红，少一条（迁完了没把名字从名单里删）也红 ——
 *      后者是为了防止名单变成一坨没人敢动的化石。
 *   2. **迁完之后彻底禁裸删**：除了一份需要"只删主行"作对照的探针（豁免表里带理由），
 *      `scripts/` 里不许再出现任何形状的 players 行删除。
 *
 * 判据本身用合成输入证伪（见最后两条 test）：往真实探针文件里注入再还原，会和其它改动撞车。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const SCRIPTS = path.join(SERVER, 'scripts');

/** 删 players 行的三种写法：模型静态方法、实例方法、以及内联 require 直接调 */
const RAW_PLAYER_DELETE = [
    /\bPlayer\.destroy\s*\(/,
    /\bplayer\.destroy\s*\(/,
    /require\(\s*['"][^'"]*models\/player[^'"]*['"]\s*\)\s*\.destroy\s*\(/
];
/**
 * "走了级联那道门"= 文件里既引用了 PlayerCascadePurge，又真的调了它的 delete*。
 * 故意不写成 `PlayerCascadePurge.deletePlayers(`：探针里常见 `const P = require(...)` 之后 `P.deletePlayers(...)`，
 * 也常见 `require('...').\n  deletePlayers(...)` 换行接方法名 —— 按"整串"匹配会把这些判成没迁（假红），
 * 而按"文件里两个条件都在"匹配才不会（同一份文件里引用与调用必然同源）。
 */
const CASCADE_DELETE_CALL = /\.(deletePlayer|deletePlayers|deleteByUsernames)\s*\(/;
const ANY_PURGE = /PlayerCascadePurge/;

/**
 * 还没迁到级联的探针（只许变小，见文件头）。
 * **2026-09-22 迁空**：35 个删号探针全部改走 `PlayerCascadePurge.delete*`，唯一还留着裸删的是
 * `smoke_player_cascade_purge.js`（它需要那份形状作对照，在下面的豁免表里带着理由）。
 * 空表是正常状态；数组留着而不是删掉，是为了"哪天有人新写一个自己删号的探针"时报错能点到文件名，
 * 并且逼他要么迁掉、要么在这里加一条带理由的条目。
 */
const TRANSITION_LEDGER = [];

/** 需要"只删主行、不级联"这个形状本身作对照的探针 —— 豁免必须带理由，且不再命中时报"豁免过期" */
const RAW_DELETE_EXEMPTIONS = new Map([
    ['smoke_player_cascade_purge.js',
        '它要量的就是"只删主行会留下孤儿"与"级联之后不留行"两种形状，必须保留一处裸 destroy 作对照']
]);

/**
 * 纯函数：吃一份 (文件名 → 源码) 清单，产出两种判定。
 * 分开成纯函数是为了能在不碰真实文件的前提下做控制跑。
 */
function auditProbeDeletes(sources) {
    const sites = [];
    const unpurged = [];
    const rawDeletes = [];
    const doorFiles = [];
    for (const [name, text] of sources) {
        const hasRaw = RAW_PLAYER_DELETE.some(re => re.test(text));
        const hasDoor = ANY_PURGE.test(text) && CASCADE_DELETE_CALL.test(text);
        if (!hasRaw && !hasDoor) continue;
        doorFiles.push(name);
        if (!hasRaw) continue;
        sites.push(name);
        if (RAW_DELETE_EXEMPTIONS.has(name)) continue;
        if (!hasDoor && !ANY_PURGE.test(text)) unpurged.push(name);
        if (!hasDoor) rawDeletes.push(name);
    }
    return {
        sites: sites.sort(),
        doorFiles: doorFiles.sort(),
        unpurged: unpurged.sort(),
        rawDeletes: rawDeletes.sort()
    };
}

function readScripts() {
    return fs.readdirSync(SCRIPTS)
        .filter(n => n.endsWith('.js'))
        .map(n => [n, fs.readFileSync(path.join(SCRIPTS, n), 'utf8')]);
}

const sources = readScripts();
const measured = auditProbeDeletes(sources);

describe('探针删号棘轮（只许变小，且不许留着已经迁完的条目）', () => {
    test('扫描器看得见东西：至少 30 个探针有"删号"这一步', () => {
        // 底线用"删号点总数"（裸删 + 走级联那道门都算），它不随迁移变小 ——
        // 拿 sites 当底线会变成"迁完就红"的自杀式门禁。
        expect(measured.doorFiles.length).toBeGreaterThanOrEqual(30);
        // 迁空之后，唯一合法的裸删号就是那份需要对照形状的探针；再多一条就该由下面的名单相等判据抓到
        expect(measured.sites).toEqual([...RAW_DELETE_EXEMPTIONS.keys()].sort());
    });

    test('过渡名单与实测严格相等（新增没级联的探针红；迁完没删条目也红）', () => {
        expect(measured.unpurged).toEqual([...TRANSITION_LEDGER].sort());
    });

    test('名单之外没有第二个"自己点名清表"的删号形状', () => {
        for (const name of measured.rawDeletes) {
            expect(TRANSITION_LEDGER).toContain(name);
        }
    });

    test('豁免表不许变成化石：条目指向的文件必须真的还在删号', () => {
        for (const [name, reason] of RAW_DELETE_EXEMPTIONS) {
            expect(reason.length).toBeGreaterThan(15);
            expect(sources.some(([f]) => f === name)).toBe(true);
            expect(measured.sites).toContain(name);
        }
    });
});

describe('这两条判据真的会红（控制跑，全用合成输入）', () => {
    const migrated = ['smoke_migrated.js', 'const P=require(\'../game/persistence/PlayerCascadePurge\'); await P.deletePlayers(ids);'];
    const legacy = ['smoke_legacy.js', 'await Player.destroy({ where: { id: ids } });'];
    const halfMigrated = ['smoke_half.js',
        'const P=require(\'../game/persistence/PlayerCascadePurge\'); await P.purge(id); await Player.destroy({ where: { id } });'];

    test('合成清单：没级联的进 unpurged，"只 purge 不删号"的进 rawDeletes 但不进 unpurged', () => {
        const out = auditProbeDeletes([migrated, legacy, halfMigrated]);
        // 迁干净的那份已经没有裸删号了，所以它不算"删号点"（sites 判的是"还在直接删 players 行"），
        // 但它仍然是"有删号这一步"的文件（doorFiles 判的是两种形状之和，这个数不随迁移变小）。
        expect(out.sites).toEqual(['smoke_half.js', 'smoke_legacy.js']);
        expect(out.doorFiles.sort()).toEqual(['smoke_half.js', 'smoke_legacy.js', 'smoke_migrated.js']);
        expect(out.unpurged).toEqual(['smoke_legacy.js']);
        expect(out.rawDeletes).toEqual(['smoke_half.js', 'smoke_legacy.js']);
    });

    test('三种写法都认得（内联 require 与实例方法是最容易漏的两种）', () => {
        for (const src of ['await Player.destroy({ where: { id } })',
            'await player.destroy()',
            'await require(\'../models/player\').destroy({ where: { username } })']) {
            expect(auditProbeDeletes([['x.js', src]]).sites).toEqual(['x.js']);
        }
        // 阳性对照的反面：清别的表的 destroy 不该被算成删号
        expect(auditProbeDeletes([['y.js', 'await Item.destroy({ where: { player_id: id } })']]).sites).toEqual([]);
    });

    test('"走了级联那道门"认别名与换行接方法名（只按整串匹配会把迁好的文件判成没迁）', () => {
        const alias = ['a.js', 'const P = require(\'../game/persistence/PlayerCascadePurge\');\nawait P.deletePlayers(ids);'];
        const broken = ['b.js', 'const PlayerCascadePurge = require(\'../game/persistence/PlayerCascadePurge\');\n'
            + 'await PlayerCascadePurge\n    .deleteByUsernames([\'probe_a\']);'];
        const purgeOnly = ['c.js', 'await PlayerCascadePurge.purgeMany(ids);'];   // 清了派生行，但删号那一步仍然自己写
        expect(auditProbeDeletes([alias, broken]).doorFiles).toEqual(['a.js', 'b.js']);
        expect(auditProbeDeletes([purgeOnly]).doorFiles).toEqual([]);
    });
});
