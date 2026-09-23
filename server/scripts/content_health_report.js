/**
 * 内容体检报告（离线命令，不连库、不启服务）
 *
 *   cd server && npm run content:report            # 人读版
 *   cd server && node scripts/content_health_report.js --json   # 机器读版（后台/CI 可以直接吃）
 *
 * 为什么要这么一条命令：这些账本来只活在 jest 的红字里（称号零来源、资料片新增物品没来源、
 * 统计量配了没人写、成就分组是死的、写了没人读的字段…）。加内容的人不该靠"跑测试猜哪条判据在管我"，
 * 而该有一条能把每一本账现算一遍、并说明**这条数字出自哪道判据**的报告。
 *
 * 报告本身不实现任何判据 —— 全部数字都来自内容层那几个函数（见 game/content/contentHealth.js 的注释）。
 * tests/ContentHealthReport.test.js 会逐条比对"报告 == 判据现算"，并用控制跑证明报告里的数字真的会动。
 *
 * 退出码：0 = 装配通过并出报告；2 = 启动闸拦下了（把闸的原文打出来，不另写一套话术）。
 */
'use strict';

const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { buildReport } = require('../game/content/contentHealth');
const { TITLE_UNREACHABLE_REASONS } = require('../game/content/sourceLedgers');

const serverRoot = path.join(__dirname, '..');
const asJson = process.argv.includes('--json');

let content;
try {
    content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'),
        packDir: path.join(serverRoot, 'content', 'packs'),
        statRegistry
    });
    content.load();
} catch (err) {
    // 装配失败就是启动闸在拦 —— 报告不解释、不改写，直接把闸的原文交给作者
    console.error('内容装配未通过（启动闸拦下）：');
    console.error(String(err && err.message || err));
    process.exit(2);
}

const report = buildReport(content);

if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

/**
 * 中英文混排的显示宽度（CJK 与全角标点算两格）：
 * `padEnd` 按码点数补齐，中文标签会被塞得比英文短一半，读起来像坏了 —— 这里按显示宽度补。
 */
const isWide = ch => /[ᄀ-ᅟ⺀-〿぀-ヿ㐀-䶿一-鿾＀-｠]/.test(ch);
const displayWidth = s => [...String(s)].reduce((w, ch) => w + (isWide(ch) ? 2 : 1), 0);
const COL = 34;
const line = (label, value) => {
    const pad = ' '.repeat(Math.max(1, COL - displayWidth(label)));
    console.log(`  ${label}${pad}${value}`);
};
const head = title => console.log(`\n【${title}】`);

head('装配');
line('资料片', report.assembly.packs.join(', '));
line('数据集 / 注册属性', `${report.assembly.datasets} 个 / ${report.assembly.registeredStats} 档`);
line('统计量来源形状', report.assembly.sourceKinds.join(' / '));
line('判据出处', report.assembly.evidence);

head('物品来源账');
line('物品总数', `${report.items.total}（其中资料片新增 ${report.items.fromPacks}）`);
line('有发放路径', report.items.withSource);
line('零来源', `${report.items.zeroSource.length}（完全没被引用 ${report.items.noReferenceAtAll.length}，只作为去路被引用 ${report.items.referencedOnlyAsSink}）`);
line('资料片新增却零来源', report.items.zeroSourceInPacks.length ? report.items.zeroSourceInPacks.join(', ') : '0 件（启动闸会拦这种）');
line('来源/去路表条数', `${report.items.grantPathKinds} 条来源 / ${report.items.sinkPathKinds} 条去路`);
line('判据出处', report.items.evidence);
if (report.items.zeroSource.length) {
    const sample = report.items.zeroSource.slice(0, 12).join(', ');
    console.log(`  零来源样本（前 12 件）：${sample}${report.items.zeroSource.length > 12 ? ` … 共 ${report.items.zeroSource.length} 件` : ''}`);
}

head('称号两本账');
line('称号总数', report.titles.total);
line('有发放路径', report.titles.withSource);
line('零来源', `${report.titles.zeroSource.length}：${report.titles.zeroSource.join(', ')}`);
line('发放路径指向不存在的称号', report.titles.danglingRefs.length ? report.titles.danglingRefs.join(', ') : '0 档（启动闸拦这种）');
line('title_name / title_desc 镜像', `${report.titles.mirrorOccurrences} 处（名字与说明只有 titles 一个来源）`);
line('零来源那份理由表是否齐全', report.titles.reasonLedgerComplete ? '齐全（每一档都写了缺哪种出口）' : '不齐全 —— 见 sourceLedgers.TITLE_UNREACHABLE_REASONS');
line('判据出处', report.titles.evidence);
if (!report.titles.reasonLedgerComplete) {
    const missing = report.titles.zeroSource.filter(id => !Object.prototype.hasOwnProperty.call(TITLE_UNREACHABLE_REASONS, id));
    console.log(`  没写理由的：${missing.join(', ')}`);
}

head('玩家统计量词表');
line('度量总数', report.metrics.total);
for (const [kind, count] of Object.entries(report.metrics.byKind)) {
    line(kind === 'realm_index' ? '  内置 realm_index' : `  来自 ${kind}.*`, count);
}
line('stats 计数有人写', `${report.metrics.statsWritten.length} 档（bumpStat / setStatKeys 字面量）`);
line('挂 pending_writer 的', report.metrics.statsPending.length ? report.metrics.statsPending.join(', ') : '0 档');
line('挂 legacy_writer 的', report.metrics.statsLegacyWriter.length ? report.metrics.statsLegacyWriter.join(', ') : '0 档（两处已迁到键级补丁）');
line('配了却没人写也没豁免', report.metrics.statsUnwritten.length ? report.metrics.statsUnwritten.join(', ') : '0 档（启动闸拦这种）');
line('判据出处', report.metrics.evidence);

head('成就的形状账');
line('成就总数', report.achievements.total);
line('用到的奖励键', Object.entries(report.achievements.rewardKeys).map(([k, n]) => `${k}×${n}`).join(', '));
line('发物品的 / 发称号的', `${report.achievements.withItems} 条 / ${report.achievements.withTitle} 条`);
line('分组', `${report.achievements.categories} 档：${Object.entries(report.achievements.perCategory).map(([k, n]) => `${k}×${n}`).join(', ')}`);
line('没有任何成就的分组', report.achievements.deadCategories.length ? report.achievements.deadCategories.join(', ') : '0 档（启动闸拦这种）');
line('判据出处', report.achievements.evidence);

head('写了但没人读的字段');
for (const entry of report.deadFields) {
    line(entry.label, `${entry.occurrences} 处 · 负责拦住它的是 ${entry.owner}`);
    if (entry.pending && entry.occurrences) {
        console.log('      这一条是"登记在案、等你拍板"（不是回潮）：留着等的是"要不要真按它排"这个决定');
    }
}

head('资料片扩不动的内容表');
line('已登记集合数', report.extension.registeredCollections);
line('形状是条目表却没登记', `${report.extension.candidates} 块（判为"本就不该给 pack 写" ${report.extension.exempted}，剩下 ${report.extension.open} 是缺口）`);
line('其中被已登记条目当外键指着', `${report.extension.withPointers} 块（资料片加得出条目、指不到这张表里的新键）`);
for (const p of report.extension.pointers) {
    line(`  ${p.id}`, `${p.entries} 档 · 指针 ${p.via.join(' / ')}`);
    if (p.exit) console.log(`      出口 · ${p.exit}`);
    else console.log('      出口 · 本轮还没读到那一步');
}
line('未列出口的缺口（按数据集）', [...new Set(report.extension.openTop
    .filter(r => !report.extension.pointers.some(p => p.id === r.id)).map(r => r.id.split('.')[0]))].join(', '));
line('判据出处', report.extension.evidence);

const hard = [];
if (report.items.zeroSourceInPacks.length) hard.push(`资料片新增物品没有来源：${report.items.zeroSourceInPacks.join(', ')}`);
if (report.titles.danglingRefs.length) hard.push(`发放路径指向不存在的称号：${report.titles.danglingRefs.join(', ')}`);
if (report.titles.mirrorOccurrences) hard.push(`还有 ${report.titles.mirrorOccurrences} 处称号名镜像`);
if (report.metrics.statsUnwritten.length) hard.push(`统计量配了没人写：${report.metrics.statsUnwritten.join(', ')}`);
if (report.achievements.deadCategories.length) hard.push(`没有任何成就的分组：${report.achievements.deadCategories.join(', ')}`);
for (const entry of report.deadFields) {
    // `pending` 的那几处是"故意留着、等拍板"的死字段（例如 grades.*.order）：混进硬伤就等于把待办刷成噪声，
    // 真回潮（清过又出现的那些）occurrences 会是 >0 且没挂 pending，仍然会进这一堆。
    if (entry.occurrences && !entry.pending) hard.push(`${entry.label} 还有 ${entry.occurrences} 处（没人读）`);
}
for (const id of report.extension.staleExemptions) hard.push(`扩展台账里"${id} 本就不该给 pack 写"这条理由已不再命中（表没了或已登记），清掉它`);
for (const id of report.extension.staleExits) hard.push(`扩展台账里 ${id} 的出口已不再命中（登记了或表没了），清掉它`);

console.log('\n【结论】');
if (!hard.length) {
    console.log('  没有"配了但玩家拿不到 / 写了但没人读"的硬伤。');
    console.log(`  剩下 ${report.titles.zeroSource.length} 档零来源称号是有账可依的存量（每档都写了缺哪种出口），等你拍板。`);
    process.exit(0);
}
for (const h of hard) console.log(`  ✗ ${h}`);
process.exit(0);
