/**
 * 内容层离线体检：不开服务器、不连 MySQL，把"资料片能不能被正确合并、内容有没有真的被用到"打出来。
 *
 * 为什么要单独一个命令：资料片的校验（属性名、效果键、元素、引用完整性）本来就写在启动期，
 * 但它只在整台服务起来时才跑一次；而加内容的人最需要的正是"我改完 JSON 立刻知道有没有踩坑"，
 * 而不是等启动日志或者线上表现成"玩家身上凭空少了个属性"。
 *
 * 用法：
 *   cd server && node scripts/validate_content.js            # 人看的清单
 *   cd server && node scripts/validate_content.js --json     # 给 CI / 后台用
 *   cd server && node scripts/validate_content.js --pack wuxing_truth   # 只看一个资料片
 *
 * 退出码：0 通过（可能有提示），1 有校验错误（这种内容启动期就会炸），2 脚本自身失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const packFilterIndex = args.indexOf('--pack');
const packFilter = packFilterIndex >= 0 ? args[packFilterIndex + 1] : null;

const { infrastructure } = require('../modules');
const { ContentRegistry, ContentError } = require('../game/content/ContentRegistry');
const { initializeContentLayer, contentRegistry } = require('../game/content');
const { statRegistry } = require('../game/stats');

/** 递归收集所有内容效果里出现的键：用来回答"这个属性除了面板还有谁在读" */
function collectEffectKeys(node, out) {
    if (Array.isArray(node)) {
        for (const item of node) collectEffectKeys(item, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    for (const [key, value] of Object.entries(node)) {
        // 物品写 effect（单数）、神通写 effects（复数），两处都是扁平的 { 属性键: 数值 }
        if ((key === 'effect' || key === 'effects') && value && typeof value === 'object'
            && !Array.isArray(value)) {
            for (const effectKey of Object.keys(value)) out.add(effectKey);
        }
        collectEffectKeys(value, out);
    }
    return out;
}

/** 资料片自己文件里的 op 条数：不依赖注册表私有结构，直接读 JSON */
function countPackOps(packDir, fileKey) {
    const parsed = JSON.parse(fs.readFileSync(path.join(packDir, `${fileKey}.json`), 'utf8'));
    const ops = ['add', 'override', 'remove', 'replace'];
    const counts = {};
    for (const op of ops) {
        const value = parsed[op];
        counts[op] = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
    }
    return counts;
}

/**
 * 扫一遍代码与配置里出现的属性键，回答"除了面板还有谁读它"。
 * 用词边界匹配，不做语义分析：这只会把"其实没人用"误判成"有人在用"，
 * 而对体检来说误判方向是安全的（宁可少报，不要让人去删一个其实在用的属性）。
 * 注册表自己的定义文件要排除在外，否则每个属性都能匹配到自己。
 */
const CODE_SCAN_ROOTS = ['game', 'modules', 'routes', 'config'];
const CODE_SCAN_SKIP = /[\\/](stats|content)[\\/]|stat_definitions\.json$|timestampCompat\.js$/;
const codeFiles = [];
for (const root of CODE_SCAN_ROOTS) {
    const abs = path.join(__dirname, '..', root);
    const stack = [abs];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { stack.push(full); continue; }
            if (!/\.(js|json)$/.test(entry.name) || CODE_SCAN_SKIP.test(full)) continue;
            codeFiles.push(full);
        }
    }
}
const codeText = codeFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');

function codeMentions(key) {
    return (codeText.match(new RegExp(`\\b${key}\\b`, 'g')) || []).length;
}

function main() {
    const configLoader = infrastructure.ConfigLoader;
    if (!configLoader.configPath) throw new Error('ConfigLoader 尚未暴露 configPath，无法定位基础配置');

    let loadError = null;
    let content = null;
    let report = null;
    // --json 模式下 stdout 必须只有 JSON：内容层装配时会自己打一行日志，挪到 stderr 去
    const originalLog = console.log;
    if (asJson) console.log = (...args) => console.error(...args);
    try {
        ({ content } = initializeContentLayer(configLoader));
        report = content.report;
    } catch (error) {
        if (!(error instanceof ContentError)) throw error;
        loadError = error;
        // 校验失败时仍然把已经发现到的资料片列出来，方便定位是哪一个写坏了
        content = new ContentRegistry({ configPath: configLoader.configPath, statRegistry });
        content.discoverPacks();
    } finally {
        console.log = originalLog;
    }

    const packs = content.packs
        .filter(pack => !packFilter || pack.id === packFilter)
        .map(pack => {
            const ops = {};
            for (const file of pack.files) {
                const target = `${file.dataset}${file.collection ? `#${file.collection}` : ''}`;
                ops[target] = countPackOps(pack.dir, file.key);
            }
            return {
                id: pack.id,
                name: pack.name,
                version: pack.version,
                enabled: pack.enabled,
                priority: pack.priority,
                depends: pack.depends,
                files: pack.files.map(file => ({
                    file: file.key,
                    dataset: file.dataset,
                    collection: file.collection || null
                })),
                ops
            };
        });

    // 条目数直接取注册表的 status()：它按"该数据集所有集合的全部条目"统计，
    // 与 GET /api/config/content/status 报的是同一个数，两处不会对不上。
    const datasets = !loadError ? content.status().datasets : {};

    // 属性使用面：面板之外的消费者（战斗档位 / 内容里的 effects 键 / 战斗角色）
    const effectKeys = new Set();
    const stats = [];
    if (!loadError) {
        for (const data of content.mergedDatasets().values()) collectEffectKeys(data, effectKeys);
        const profiles = content.mergedDatasets().get('combat_formulas')?.profiles || {};
        const profileStats = new Set();
        for (const profile of Object.values(profiles)) {
            for (const key of ['attack_stat', 'mitigate_stat', 'attack_fallback_stat', 'mitigate_fallback_stat']) {
                if (profile[key]) profileStats.add(profile[key]);
            }
        }
        for (const def of statRegistry.all()) {
            const consumers = [];
            if (profileStats.has(def.key) || (def.aliases || []).some(a => profileStats.has(a))) consumers.push('战斗档位');
            if (effectKeys.has(def.key) || (def.aliases || []).some(a => effectKeys.has(a))) consumers.push('内容 effects');
            if ((def.battleRoles || []).length) consumers.push(`战斗角色 ${def.battleRoles.join('/')}`);
            const mentions = codeMentions(def.key);
            if (mentions) consumers.push(`代码×${mentions}`);
            stats.push({ key: def.key, unit: def.unit, consumers });
        }
    }

    const unusedStats = stats.filter(s => !s.consumers.length).map(s => s.key);
    const warnings = [...(report?.warnings || [])];
    if (unusedStats.length) {
        warnings.push(`以下属性登记了但找不到任何使用者（战斗档位 / 内容 effects / 战斗角色 / 代码引用全都没有），`
            + `要么是本该接进某个玩法却漏了，要么是可以删的：${unusedStats.join(', ')}`);
    }

    const result = {
        ok: !loadError,
        error: loadError ? loadError.message : null,
        packs,
        datasets,
        statCount: statRegistry.count,
        unusedStats,
        warnings
    };

    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(loadError ? 1 : 0);
    }

    const line = (label, value) => console.log(`  ${String(label).padEnd(22)} ${value}`);
    console.log(`\n== 资料片（${packs.length} 个，启用 ${packs.filter(p => p.enabled).length} 个）==`);
    for (const pack of packs) {
        console.log(`\n[${pack.enabled ? '启用' : '停用'}] ${pack.id}@${pack.version}  ${pack.name}`);
        line('依赖', (pack.depends || []).join(', ') || '无');
        for (const file of pack.files) {
            const target = `${file.dataset}${file.collection ? `#${file.collection}` : ''}`;
            const ops = pack.ops[target] || {};
            line(file.file, `${target}  +${ops.add || 0} ~${ops.override || 0} -${ops.remove || 0} =${ops.replace || 0}`);
        }
    }

    console.log('\n== 合并后的数据集条目数（基础 + 资料片之后的视图）==');
    for (const [name, size] of Object.entries(datasets)) line(name, size);

    console.log(`\n== 属性注册表：${statRegistry.count} 条 ==`);
    if (stats.length) {
        for (const stat of stats) line(stat.key, `${stat.unit}  →  ${stat.consumers.join(', ') || '（只见面板）'}`);
    }

    console.log('\n== 结果 ==');
    if (loadError) {
        console.log(`FAIL  ${loadError.message}`);
        console.log('      （这种内容启动期就会抛错：先修好再重启服务）');
    } else {
        console.log('OK    启动期校验全部通过（属性名、效果键、元素、引用完整性）');
    }
    for (const warning of warnings) console.log(`提示  ${warning}`);
    process.exit(loadError ? 1 : 0);
}

try {
    main();
} catch (error) {
    console.error('体检脚本自身失败:', error);
    process.exit(2);
}
