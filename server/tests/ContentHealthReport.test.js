/**
 * 内容体检报告的自证（不连库）
 *
 * 一条汇总报告最坏的下场不是报错，而是**变成一份对不上的旧文档**：判据改了、报告还印着老数字，
 * 人就会拿它当结论。所以这份测试只干一件事 —— 证明报告的每个数字都是从判据现算出来的：
 *   ① 与直接调用判据函数的结果逐项相等；
 *   ② 控制跑：往合并视图里塞一样死内容，报告里对应的数字必须跟着动，
 *      而且**同一份改动必须让对应的启动闸抛**（报告说"有硬伤"而闸放行的分歧不允许存在）；
 *   ③ 每个板块都带 evidence（点名是哪道判据在管），且指向的文件真实存在。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ContentRegistry, statWriterCalls } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const {
    buildReport, itemReachability, titleReachability, metricsLedger, achievementReport, deadFieldLedger
} = require('../game/content/contentHealth');
const {
    normalizeRefPath, ITEM_GRANT_PATHS, TITLE_UNREACHABLE_REASONS
} = require('../game/content/sourceLedgers');

const serverRoot = path.join(__dirname, '..');
const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');

function realView() {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
    content.load();
    return content;
}

const hasGrant = paths => [...paths].some(p => ITEM_GRANT_PATHS.some(g => g.re.test(p)));

describe('报告里的数字 == 判据现算', () => {
    const content = realView();
    const report = buildReport(content);

    test('物品账：与 itemReferenceIndex + ITEM_GRANT_PATHS 独立算一遍完全一致', () => {
        const items = content.dataset('item_data').items;
        const pathsOf = new Map();
        for (const [raw, ids] of content.itemReferenceIndex().entries()) {
            const at = normalizeRefPath(raw);
            for (const id of ids) {
                if (!pathsOf.has(id)) pathsOf.set(id, new Set());
                pathsOf.get(id).add(at);
            }
        }
        const expectZero = items.map(i => String(i.id)).filter(id => !hasGrant(pathsOf.get(id) || []));
        const expectPackZero = items
            .filter(i => i.__content_origin)
            .map(i => String(i.id))
            .filter(id => !hasGrant(pathsOf.get(id) || []));
        const mine = itemReachability(content);
        expect(mine.total).toBe(items.length);
        expect(mine.zeroSource.slice().sort()).toEqual(expectZero.sort());
        expect(mine.withSource).toBe(items.length - expectZero.length);
        expect(mine.zeroSourceInPacks).toEqual(expectPackZero);
        // 现网这条必须是 0，否则报告只是把硬伤印得好看一点
        expect(mine.zeroSourceInPacks).toEqual([]);
    });

    test('称号账与成就账：数字来自 titleGrantIndex / 合并视图本身，不是写死的常量', () => {
        const titles = content.dataset('titles');
        const grants = content.titleGrantIndex();
        const mine = titleReachability(content);
        expect(mine.total).toBe(titles.length);
        expect(mine.withSource).toBe(titles.filter(t => grants.has(String(t.id))).length);
        expect(mine.zeroSource).toEqual(titles.map(t => String(t.id)).filter(id => !grants.has(id)));
        expect(mine.danglingRefs).toEqual([]);          // 引用方向：0 档指向不存在的称号（闸保证）

        const ach = achievementReport(content);
        const list = content.dataset('achievement_data').achievements;
        expect(ach.total).toBe(list.length);
        expect(ach.withItems).toBe(list.filter(a => Array.isArray(a.reward?.items)).length);
        expect(ach.withTitle).toBe(list.filter(a => a.reward?.title_id).length);
        expect(ach.deadCategories).toEqual([]);
        // 分组数字要能加回成就总数（漏一档就等于报告在少报）
        expect(Object.values(ach.perCategory).reduce((s, n) => s + n, 0)).toBe(list.length);
        expect(report.titles.total).toBe(mine.total);
    });

    test('统计量账：谁在写这件事直接问 statWriterCalls，报告不自己扫源码', () => {
        const table = content.dataset('player_metrics').metrics;
        const mine = metricsLedger(content);
        const statsKeys = Object.keys(table)
            .filter(id => String(table[id].from).startsWith('stats.'))
            .map(id => ({ id, key: String(table[id].from).slice('stats.'.length) }));
        expect(mine.statsWritten.map(x => `${x}`).sort())
            .toEqual(statsKeys.filter(s => statWriterCalls().has(s.key)).map(s => s.id).sort());
        expect(mine.statsUnwritten).toEqual([]);
        expect(mine.total).toBe(Object.keys(table).filter(k => !k.startsWith('_')).length);
    });

    test('每个板块都点名了判据出处：符号能对上、路径文件真实存在（报告要能被人工复核）', () => {
        const evidence = [
            report.assembly.evidence, report.items.evidence, report.titles.evidence,
            report.metrics.evidence, report.achievements.evidence,
            ...report.deadFields.map(f => f.owner)
        ];
        for (const e of evidence) expect(typeof e === 'string' && e.length > 10).toBe(true);

        const all = evidence.join('\n');
        const files = new Set();
        for (const e of evidence) {
            for (const m of e.matchAll(/(?:config|game|scripts)\/[\w./-]+/g)) files.add(m[0].replace(/[.，、)）]+$/, ''));
        }
        // 报告不许自己判：这几支判据必须被点名（少了就说明有人在报告里另写了一套规则）
        for (const needed of [
            'itemReferenceIndex()', 'titleGrantIndex()', 'titleMirrorPaths()',
            'statWriterCalls()', '_validateAchievementCategories', 'ITEM_GRANT_PATHS'
        ]) expect(all).toContain(needed);
        expect(files.size).toBeGreaterThanOrEqual(1);
        for (const rel of files) expect(fs.existsSync(path.join(serverRoot, rel))).toBe(true);
    });

    test('"写了但没人读"的字段：本轮清掉的三处必须是 0，新登记那条"留着等拍板"的按实测数走', () => {
        const ledger = deadFieldLedger(content);
        const fields = Object.fromEntries(ledger.map(f => [f.id, f.occurrences]));
        expect(fields).toEqual({
            achievement_category_color: 0,
            title_name_mirror: 0,
            legacy_writer: 0,
            // 品阶表的 order：有人写、没人读（`getGradeConfig` 是唯一读取口，12 处消费都不读它）。
            // 删还是让它有人读属设计决定，所以挂 pending 记在账上 —— 这一格只许变小，不许变大。
            technique_grade_order: 5
        });
        // pending 那条必须自己说清"等什么决定"，否则就是一张没人会回来收的白条
        for (const entry of ledger.filter(f => f.pending)) {
            expect(String(entry.why).length).toBeGreaterThanOrEqual(40);
        }
    });
});

describe('控制跑：报告必须跟着判据动，且"报告说硬伤"与"启动闸抛"不许分歧', () => {
    test('塞一档零来源称号 → 报告点名它、理由表判为不齐，同时 _validateTitleGrants 抛', () => {
        const content = realView();
        const before = titleReachability(content).zeroSource.length;
        const titles = content.datasets.get('titles');
        titles.push({ id: 'probe_report_dead_title', name: '探针死称号', quality: 'rare', bonuses: {}, __content_origin: 'probe_pack' });

        const mine = titleReachability(content);
        expect(mine.zeroSource).toContain('probe_report_dead_title');
        expect(mine.zeroSource.length).toBe(before + 1);
        expect(mine.reasonLedgerComplete).toBe(false);           // 新死档没在理由表里
        expect(Object.prototype.hasOwnProperty.call(TITLE_UNREACHABLE_REASONS, 'probe_report_dead_title')).toBe(false);
        expect(() => content._validateTitleGrants()).toThrow(/没有任何发放路径/);
    });

    test('把一档统计量指向没人写的计数 → 报告列进 statsUnwritten，同时 _validatePlayerMetrics 抛', () => {
        const content = realView();
        const table = content.datasets.get('player_metrics').metrics;
        const original = JSON.parse(JSON.stringify(table));
        table.probe_no_writer = { label: '探针没人写', from: 'stats.probe_key_nobody_writes' };

        const mine = metricsLedger(content);
        expect(mine.statsUnwritten).toContain('probe_no_writer');
        expect(() => content._validatePlayerMetrics()).toThrow(/没有任何 bumpStat/);

        content.datasets.set('player_metrics', { metrics: original });
        expect(metricsLedger(content).statsUnwritten).toEqual([]);
        expect(() => content._validatePlayerMetrics()).not.toThrow();
    });

    test('塞一件资料片物品且没有任何来源 → 报告点名它（这条正是 ItemSourceCoverage 的棘轮判的同一件事）', () => {
        const content = realView();
        const items = content.datasets.get('item_data').items;
        const before = content.report;
        expect(before.packs.length).toBeGreaterThan(0);
        items.push({ id: 'probe_report_orphan_item', name: '探针无来源物品', type: 'material', __content_origin: 'probe_pack' });

        const mine = itemReachability(content);
        expect(mine.zeroSource).toContain('probe_report_orphan_item');
        expect(mine.zeroSourceInPacks).toContain('probe_report_orphan_item');
        expect(mine.noReferenceAtAll).toContain('probe_report_orphan_item');
    });

    test('塞一档没人挂的成就分组 → 报告与启动闸同时不放过', () => {
        const content = realView();
        const dataset = content.datasets.get('achievement_data');
        dataset.categories.probe_dead_group = { name: '探针空分组', icon: '✦', __content_origin: 'probe_pack' };
        expect(achievementReport(content).deadCategories).toContain('probe_dead_group');
        expect(() => content._validateAchievementCategories()).toThrow(/没有任何成就挂在下面/);
    });
});

describe('命令行外壳', () => {
    const run = args => execFileSync(process.execPath,
        [path.join(serverRoot, 'scripts', 'content_health_report.js')].concat(args),
        { cwd: serverRoot, encoding: 'utf8' });

    test('人读版能跑完并给出结论；--json 是合法 JSON 且带全部板块', () => {
        const text = run([]);
        expect(text).toContain('【称号两本账】');
        expect(text).toContain('【结论】');
        const parsed = JSON.parse(run(['--json']));
        // 板块清单是刻意维护的：加一本新账要同时在这里点名、并在人读版有一段能看见（否则数字没人读）
        expect(Object.keys(parsed).sort()).toEqual(
            ['achievements', 'assembly', 'deadFields', 'extension', 'generatedAt', 'items', 'metrics', 'titles'].sort());
        expect(parsed.items.total).toBeGreaterThan(400);
        expect(text).toContain('【资料片扩不动的内容表】');
        // "留着等拍板"的死字段不算硬伤（混进来的话真回潮会被噪声盖掉）
        expect(text).not.toMatch(/grades\.\*\.order 还有/);
        expect(text).toMatch(/technique_data\.grades\.\*\.order\s+5 处/);
        expect(parsed.extension.candidates).toBe(parsed.extension.open + parsed.extension.exempted);
    });

    test('中文标签按显示宽度对齐（CJK 占两格）：值从第 34 列之后开始，不会贴着长标签', () => {
        const wide = ch => /[_㄰-㆏　-〿぀-ヿ㐀-䶿一-龾＀-｠]/.test(ch);
        const width = s => [...s].reduce((w, ch) => w + (wide(ch) ? 2 : 1), 0);
        const rows = run([]).split(String.fromCharCode(10))
            .map(l => l.match(/^ {2}(\S.*?)( {2,})(\S.*)$/))
            .filter(Boolean);
        expect(rows.length).toBeGreaterThan(15);
        for (const [, label, gap] of rows) {
            const col = width(label) + gap.length;
            expect(col).toBeGreaterThanOrEqual(34);
            expect(col).toBeLessThan(37);
        }
        // 上一版的毛病正是值贴标签：出现"…镜像0 处"这种没空格分隔的连写就该判红
        expect(run([])).not.toMatch(/[^\s]0 处/);
    });
});
