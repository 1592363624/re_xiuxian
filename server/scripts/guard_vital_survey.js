/**
 * vital 档升不升硬拦，用这条survey 回答：**判过多少次**比"没红"更有信息量。
 *
 * 背景：数值写回守卫把 players 的气血/灵力放在"只 warn"档，理由是这些列的写法本来就是
 * "按上限整值重设"（突破回满血、丹药回血、死亡保底），硬拦可能把正确写回判成过期。
 * 这个理由到今天为止没人量过 —— 而"跑了二十条探针都没红"也不能当证据：
 * 实测发现多数战斗把气血写在 active_battles 的行里、回血走 PlayerStateStore 的列上原子写，
 * **压根不经过 save()**，所以 vital 档可能一次都没被判过。0 冲突 + 0 判定 = 空测。
 *
 * 于是这里做的事：把一批探针各自起一个子进程，统一 `PLAYER_VITAL_GUARD=throw` +
 * `NUMERIC_GUARD_STATS=1`，把每个进程退出时打的那行判定计数收上来加总，输出
 * "判过几列、各列几次、冲突几次、拒了几笔、哪条探针本身红了"。
 *
 * 用法：cd server && node --env-file=.env scripts/guard_vital_survey.js
 *       只跑几条：... scripts/guard_vital_survey.js --only=smoke_pvp_battle,smoke_divine_duel
 *       顺带看灵兽档：加 --beast-vital=throw
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.SMOKE_PORT || 5420);

/** 默认清单：挑"真的会动玩家气血/灵力"的那些流程，不是随手抓一排 */
const DEFAULT_PROBES = [
    'smoke_pvp_battle', 'smoke_duel', 'smoke_divine_duel', 'smoke_sect_war',
    'smoke_cave_social', 'smoke_write_concurrency', 'smoke_write_crossflow',
    'smoke_adventure_complete', 'smoke_beast_settle', 'smoke_dao_companion'
];

/** 同时认 `--only=a,b` 与 `--only a b`（第一版只认后一种，结果 --only 被静默忽略、跑了整套默认清单） */
function argList(name) {
    const prefix = `--${name}=`;
    const inline = process.argv.find(a => a.startsWith(prefix));
    if (inline) return inline.slice(prefix.length).split(',').map(s => s.trim()).filter(Boolean);
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const rest = process.argv.slice(i + 1).filter(a => !a.startsWith('--'));
    return rest.length ? rest.flatMap(a => a.split(',')).map(s => s.trim()).filter(Boolean) : null;
}
const probes = argList('only') || DEFAULT_PROBES;
const beastVitalIdx = process.argv.indexOf('--beast-vital');
const beastVital = beastVitalIdx >= 0 ? (process.argv[beastVitalIdx + 1] || 'throw') : 'off';

const totals = new Map();   // label -> 累加后的计数
const rows = [];
let failures = 0;
let noStats = [];

probes.forEach((name, i) => {
    const port = BASE_PORT + i;
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--env-file=.env', `scripts/${name}.js`], {
        cwd: SERVER,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SMOKE_PORT: String(port), PLAYER_VITAL_GUARD: 'throw', BEAST_VITAL_GUARD: beastVital, NUMERIC_GUARD_STATS: '1' }
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const failedLines = out.split('\n').filter(line => line.startsWith('FAIL'));
    const STATS_PREFIX = '[numericWriteGuard.stats] ';
    const statsLine = out.split('\n').find(line => line.startsWith(STATS_PREFIX));
    if (statsLine) {
        let parsed = null;
        try {
            // 注意：以前这里是 exec 一个只匹配前缀的正则再取 [0] —— 拿回来的只有前缀本身，
            // JSON.parse('') 于是恒报 "Unexpected end of JSON input"，看起来像"子进程输出被截断"。
            parsed = JSON.parse(statsLine.slice(STATS_PREFIX.length));
        } catch (e) {
            // 解析不了要当成"这一条没量到"，不能让整条 survey 崩在半路（那样剩下的探针就白跑了）
            console.log(`  ${name}：计数行解析失败（${e.message}），这一条按没覆盖处理`);
        }
        for (const g of parsed || []) {
            const t = totals.get(g.label) || { checks: 0, dbReads: 0, conflicts: 0, rejected: 0, warned: 0, byColumn: {}, conflictByColumn: {} };
            t.checks += g.checks; t.dbReads += g.dbReads; t.conflicts += g.conflicts;
            t.rejected += g.rejected; t.warned += g.warned;
            for (const [k, v] of Object.entries(g.byColumn || {})) t.byColumn[k] = (t.byColumn[k] || 0) + v;
            for (const [k, v] of Object.entries(g.conflictByColumn || {})) t.conflictByColumn[k] = (t.conflictByColumn[k] || 0) + v;
            totals.set(g.label, t);
        }
    } else {
        noStats.push(name);
    }
    failures += failedLines.length;
    rows.push({ name, seconds: ((Date.now() - started) / 1000).toFixed(1), exit: r.status, fails: failedLines.length });
    console.log(`  ${name}：${r.status === 0 ? '绿' : `红（FAIL ${failedLines.length} 条，exit=${r.status}）`}  ${rows[rows.length - 1].seconds}s`);
    for (const line of failedLines) console.log(`      ${line.trim()}`);
});

console.log('\n=== 判定计数（vital=throw 下累计）');
for (const [label, t] of totals) {
    console.log(`${label}: checks=${t.checks} SELECT=${t.dbReads} 冲突=${t.conflicts} 拒绝=${t.rejected} warn=${t.warned}`);
    console.log(`   按列=${JSON.stringify(t.byColumn)}`);
    if (t.conflicts) console.log(`   冲突按列=${JSON.stringify(t.conflictByColumn)}`);
}
const players = totals.get('players') || { byColumn: {}, conflicts: 0, rejected: 0 };
const vitalCoverage = (players.byColumn.hp_current || 0) + (players.byColumn.mp_current || 0);

console.log('\n=== 结论');
const blockers = [];
if (noStats.length) blockers.push(`这些探针没打出计数（多半是崩了或不走守卫）：${noStats.join(', ')}`);
if (failures) blockers.push(`有 ${failures} 条探针自身断言在 vital=throw 下变红，先逐条定性再谈升档`);
if (!(vitalCoverage > 0)) blockers.push(`这批流程一次都没判过 hp_current/mp_current —— 说明"能不能升"还不能由这次压测回答（需要造到会走 save() 写气血/灵力的流程，或直接给 VitalGuard 加针对性探针）`);
if ((players.conflicts || 0) > 0) blockers.push(`真冲突 ${players.conflicts} 次：先按 detail 里的调用点逐个定性（是真丢更新还是"按上限重设"该走持锁事务）`);
console.log(blockers.length ? `还不能升硬拦。\n  - ${blockers.join('\n  - ')}` : '这次压测下：vital=throw 无冲突且覆盖到了气血/灵力两列，可以谈升默认档。');
process.exit(0);
