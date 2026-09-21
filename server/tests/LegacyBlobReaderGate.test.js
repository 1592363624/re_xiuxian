/**
 * 遗留 blob 键（players.attributes 里的 atk/def/hp_max）不许再被当成真相读 —— 静态闸（不连库）
 *
 * 为什么钉这条：这三键是建号时从 `role_init.initialAttributes` 抄进 JSON 列的**静态快照**，
 * 解析链路（`AttributeService.calculateFullAttributes*`）根本不读它。历史上正是因为有人读它才出了
 * 一批"打出来的伤害/血量按建号时的值算"的事故，改造后各消费点都留了注释说明（见
 * `CombatService.js:297`、`DuelService.js:280`、`PvpService.js:819` 等）。
 * 面板那条路也是安全的：`routes/player.js:102` 下发的 `attributes` 装的是 `fullAttributes.final`
 * （解析后的最终值），所以 `PlayerStatus.vue` 读 `player.attributes.atk` 读到的是新值，不是 blob。
 *
 * 现状（2026-09-21 实测，隔离库 re_xiuxian_test）：45 个玩家里 **38 行还带着这三键，其中 27 行的值
 * 与初始 10/100 已经不同** —— 说明还有路径在刷新这份快照（升级/GM 改属性），它"看着对"的时候最危险：
 * 下一个人就会觉得读它没问题。所以数据要不要清是业主的决定，**不许读**这条由本闸钉住。
 *
 * 白名单只有一条，且写清凭什么：`game/core/PlayerService.js` 在建号时用 `initialAttributes.hp_max`
 * 作为 `hp_current` 的初值 —— 那是"配置的初始值"，不是从已有玩家的 blob 里读快照。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['game', 'routes', 'models', 'modules', 'core', 'config'];

// 读这三个键的写法：点号 / 可选链 / 下标
const READ_PATTERNS = [
    /\.attributes\s*\??\.\s*(atk|def|hp_max)\b/g,
    /\.attributes\s*\[\s*['"](atk|def|hp_max)['"]\s*\]/g,
    /\battributes\s*\.\s*(atk|def|hp_max)\b/g
];
// 写这些键的写法不算读（清理由写入点负责：见任务 #36 已完成的写入方审计）
const WRITE_OK = /(attributes\s*\[?\s*['"]?(atk|def|hp_max)['"]?\s*\]?\s*=|initialAttributes)/;
const ALLOWED = [
    // 建号：hp_current 初值取自配置，不是读已有 blob
    'game/core/PlayerService.js::initialAttributes'
];

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); continue; }
        if (entry.name.endsWith('.js')) yield full;
    }
}

function stripNoise(line) {
    // 注释与注释掉的调用不算读者
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    return t;
}

function scanReaders() {
    const hits = [];
    for (const d of SCAN_DIRS) {
        const abs = path.join(SERVER_ROOT, d);
        if (!fs.existsSync(abs)) continue;
        for (const file of walk(abs)) {
            const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((raw, i) => {
                const line = stripNoise(raw);
                if (!line || WRITE_OK.test(line)) return;
                for (const re of READ_PATTERNS) {
                    re.lastIndex = 0;
                    if (re.test(line)) {
                        // 解析结果对象（fullAttributes.final / final_stats）里的 attributes 不是 blob：
                        // 这类写法左边一定是变量名包含 final/resolved/full 的来源
                        if (/(full|final|resolved)\w*\.(final|stats)|final\.\w+/.test(line)) continue;
                        hits.push(`${rel}:${i + 1}::${line.slice(0, 90)}`);
                        break;
                    }
                }
            });
        }
    }
    return hits.sort();
}

describe('遗留 blob 键（atk/def/hp_max）的读取闸', () => {
    const readers = scanReaders();

    test('扫描器确实在看真代码：能认出"读 blob 快照"这一类写法（防空跑）', () => {
        const probe = 'const v = player.attributes.atk;';
        const caught = READ_PATTERNS.some(re => { re.lastIndex = 0; return re.test(probe); });
        if (!caught) throw new Error('判定式认不出 `player.attributes.atk` —— 这条闸现在是摆设');
        const probe2 = 'const v = player.attributes?.hp_max;';
        if (!READ_PATTERNS.some(re => { re.lastIndex = 0; return re.test(probe2); })) {
            throw new Error('判定式认不出可选链写法 `attributes?.hp_max`');
        }
        if (SCAN_DIRS.every(d => !fs.existsSync(path.join(SERVER_ROOT, d)))) {
            throw new Error('扫描根目录不存在，这条闸什么都没看');
        }
        // 全仓至少该看到那些"说明为什么不能读"的历史注释（证明这些文件确实在扫描范围内）
        const all = SCAN_DIRS.flatMap(d => {
            const abs = path.join(SERVER_ROOT, d);
            return fs.existsSync(abs) ? [...walk(abs)] : [];
        });
        const withExplanations = all.filter(f => /attributes\.atk|attributes\.hp_max/.test(fs.readFileSync(f, 'utf8')));
        if (withExplanations.length < 2) {
            throw new Error(`只扫到 ${withExplanations.length} 个提到 attributes.atk/hp_max 的文件，扫描范围不对`);
        }
    });

    test('服务端不许有读 players.attributes 遗留键的地方（白名单只有建号取配置初值那一条）', () => {
        const extra = readers.filter(h => !ALLOWED.some(a => h.startsWith(a.split('::')[0])));
        if (extra.length) {
            throw new Error('有人在把 blob 里的陈旧快照当属性真相读（这三键不是解析链的输入，'
                + '值会随境界/装备/灵根过期）：\n  ' + extra.join('\n  ')
                + '\n  要拿最终值请用 AttributeService.calculateFullAttributes*/resolveCombatStats；'
                + '确实要新增合法读者，就在本文件 ALLOWED 里写清它凭什么不是快照。');
        }
    });
});
