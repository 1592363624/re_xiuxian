/**
 * 陈旧镜像键闸：players.attributes 里那五个"旧属性管线的输出键"不许再被读、被写。
 *
 * 背景（为什么这五个键危险）：2026-09-20 的属性管线改造后，攻/防/气血上限/灵力上限/速度
 * 一律由 AttributeService 现算（境界基数 + 各来源加成），**没有任何消费者读 blob 里的
 * atk/def/hp_max/mp_max/speed，也没有任何来源以它们为基数**。但换境界与建号的老代码还在往
 * blob 里写这些键，于是它们变成一份"看着像面板、其实是某个时刻的残骸"的镜像：
 * 现网实测（re_xiuxian_test）有人 blob 里写着战力 6185、真实只有 98；
 * 谁照着 attrs.atk 取值结算，就是在拿一个玩家从来没有过的数字玩他。
 *
 * 这一族已经修掉的读者：封神防守快照、吃药血蓝上限、斗法先手、宗门问安、赶路速度、
 * 切磋入参、夺舍继承（2026-09-22）。这一条闸负责让"再写回去 / 再读回来"当场红。
 *
 * 判据不是"文件里有 LOCK"那种松匹配，而是**按变量来源**判：
 *   1) 找出被绑定到 players.attributes 那份 blob 的局部变量（三种常见写法，见 BLOB_BINDINGS）；
 *   2) 这些变量上的 .atk / .def / .hp_max / .mp_max / .speed 读写，以及 `player.attributes.atk` 直读，全部算命中；
 *   3) 注册表认识的存储键（atk_bonus / reincarnation_bonus / sense / *_pct）一律不算 —— 那些是真在用的键。
 * 所以 `const s = resolveCombatStats(...)` 那种解析结果不会被误伤：它的变量从没被绑到 blob 上。
 *
 * 自检（防空跑，也防放宽）：三条夹具用例把"旧写法必须命中、新写法必须不命中"钉死。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['game', 'routes'];
const LEGACY_MIRROR_KEYS = ['atk', 'def', 'hp_max', 'mp_max', 'speed'];

/**
 * 已经看过、并且刻意保留的降级读点：`文件 → 理由`。
 * 与 ContentRegistry.OPTIONAL_ITEM_REFS 同一套纪律 —— 要写清理由，且**一旦这一处不再命中，
 * 下面会反过来报"豁免已过期"**，不许跟着它想解释的那段代码一起烂掉。
 */
const REGISTERED_FALLBACKS = {
    'game/services/SparringService.js':
        '只在 AttributeService.calculateFullAttributesAsync 抛错的 catch 分支里当降级值（有 console.warn）。'
        + '解析链路整个挂掉时宁可拿旧数结算一局训练玩法，也不要让切磋直接 500；正式战斗入口不吃这条。',
    'game/services/InventoryService.js':
        '吃药回血的血蓝上限：先取解析值，只有解析值 <= 0（等于属性服务已经不正常）才退回 blob 镜像，'
        + '最后才是 100 兜底。顺序写在 capOf 那一行和上面的注释里，别倒过来。'
};

/** 把变量绑定到 players.attributes 那份 blob 的几种写法 */
const BLOB_BINDINGS = [
    // const attrs = player.attributes || {};
    /(?:const|let|var)\s*([A-Za-z_$][\w$]*)\s*=\s*[\w$?.]*\battributes\s*(?:\|\||;|$)/,
    // const attrs = typeof player.attributes === 'string' ? JSON.parse(...) : (player.attributes || {});
    /(?:const|let|var)\s*([A-Za-z_$][\w$]*)\s*=\s*typeof\s+[\w$?.]*\battributes\b/,
    // attrs = this._attributesOf(player) / = getAttributes(...) 这类显式取 blob 的助手
    /(?:const|let|var)\s*([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*_attributesOf\s*\(/,
    // **不带声明的重新赋值**也要认：切磋那种
    //   let fullAttrs; try { fullAttrs = 解析结果 } catch { fullAttrs = player.attributes || {} }
    // 只写第一条规则会一条都不命中，于是"现网 0 命中"是假的（第一版就在这里漏掉了 SparringService）。
    /^\s*([A-Za-z_$][\w$]*)\s*=\s*[\w$?.]*\battributes\s*(?:\|\||;)/
];

function stripComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * 扫一份源码，返回命中：`{line, expr, var}`。
 * @param {string} code 已剥注释的源码
 */
function findStaleMirrorAccess(code) {
    const blobVars = new Set();
    for (const line of code.split('\n')) {
        for (const re of BLOB_BINDINGS) {
            const m = line.match(re);
            if (m) blobVars.add(m[1]);
        }
    }
    const keys = LEGACY_MIRROR_KEYS.join('|');
    const direct = new RegExp(`(?:[\\w$?]*\\.)?\\battributes\\s*\\.\\s*(?:${keys})\\b`, 'g');
    const viaVar = new RegExp(`\\b(?:${[...blobVars].map(v => v.replace(/\$/g, '\\$')).join('|') || '____none____'})`
        + `\\s*(?:\\?\\.)?\\s*\\.\\s*(${keys})\\b`, 'g');
    const hits = [];
    code.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(direct)) hits.push({ line: i + 1, expr: m[0].trim() });
        if (blobVars.size) for (const m of line.matchAll(viaVar)) hits.push({ line: i + 1, expr: m[0].trim() });
    });
    return hits;
}

function rel(file) { return path.relative(SERVER_ROOT, file).split(path.sep).join('/'); }

function scanRepo() {
    const found = [];
    for (const dir of SCAN_DIRS) {
        for (const file of walk(path.join(SERVER_ROOT, dir))) {
            const code = stripComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
            for (const hit of findStaleMirrorAccess(code)) {
                found.push({ file: rel(file), ...hit });
            }
        }
    }
    return found;
}

describe('players.attributes 里的旧输出键不许再被读写', () => {
    const hits = scanRepo();
    const matched = new Set();

    test('扫描器自己要有牙：夹具里的旧写法必须命中', () => {
        const stale = stripComments([
            "const attrs = player.attributes || {};",
            "const atk = Number(attrs.atk) || 10;",
            "attrs.hp_max = nextRealm.base_hp;",
            "player.attributes = attrs;",
            "const hp = player.attributes.def;",
            "let fullAttrs;",
            "fullAttrs = player.attributes || {};",
            "const hpMax = Number(fullAttrs.hp_max) || 100;"
        ].join('\n'));
        const found = findStaleMirrorAccess(stale).map(h => h.expr);
        expect(found).toEqual(expect.arrayContaining([
            'attrs.atk', 'attrs.hp_max', 'player.attributes.def',
            'fullAttrs.hp_max'          // 不带声明的重新赋值也要认（第一版在这里漏过一次）
        ]));
    });

    test('解析结果与注册表存储键不是陈旧镜像：新写法不许误伤', () => {
        const fine = stripComments([
            "const resolved = await CombatResolver.resolveCombatStats(player);",
            "const atk = Number(resolved.stats.atk) || 10;",
            "const attrs = player.attributes || {};",
            "attrs.atk_bonus = 5;",
            "attrs.sense = 12;",
            "attrs.reincarnation_bonus = { atk: 3 };",
            "const roleInit = configLoader.getConfig('role_init');",
            "const base = roleInit.initialAttributes.hp_max;"
        ].join('\n'));
        expect(findStaleMirrorAccess(fine)).toEqual([]);
    });

    test('现网命中要么为 0，要么点名登记了理由', () => {
        // 命中清单打在测试输出里：这条闸的价值在于"看得见 + 有结论"，不只是"红或绿"。
        console.log(`陈旧镜像键命中 ${hits.length} 处：\n`
            + hits.map(h => `  ${h.file}:${h.line}  ${h.expr}`).join('\n'));
        const unregistered = hits.filter(h => !REGISTERED_FALLBACKS[h.file]);
        expect(unregistered).toEqual([]);
    });

    test('登记的理由不能变成僵尸豁免（这一处不再命中就该把登记删掉）', () => {
        const stillHit = new Set(hits.map(h => h.file));
        const expired = Object.keys(REGISTERED_FALLBACKS).filter(f => !stillHit.has(f));
        expect(expired).toEqual([]);
    });

    test('夺舍这条链现在读的是解析属性，不是 blob 镜像（点名取证）', () => {
        const src = fs.readFileSync(path.join(SERVER_ROOT, 'game/services/ReincarnationService.js'), 'utf8');
        expect(src).toMatch(/CombatResolver\.resolveCombatStats\(player/);
        expect(src).toMatch(/sourceOverrides:\s*\{\s*reincarnation:\s*\{\}/);
        // 旧的"写死输出键 + 整块赋回"两件事都不许回来
        expect(src).not.toMatch(/newAttrs\.(atk|def|hp_max|mp_max|speed)\s*=/);
        expect(src).not.toMatch(/player\.attributes\s*=(?!=)/);
        // "满血复活"必须写 players 那一列，而不是 blob 里的同名键
        expect(src).toMatch(/columns:\s*\{\s*hp_current:/);
    });

    /**
     * 种下去的那一手：建号与 GM 重置都从 role_init.initialAttributes 取初值。
     * 那份配置里混着两种键 —— 真的住 blob 的（神识池 + attributeField 那几档属性）
     * 和旧管线留下的输出键。过滤判据取自注册表（不在这份代码里抄键名清单），
     * 所以资料片加一档 attributeField 属性时它自动认，抄死的清单一定会漂移。
     */
    test('新号与 GM 重置都不再往 blob 里种那五个输出键', () => {
        const PlayerService = require('../game/core/PlayerService');
        const roleInit = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'config', 'role_init.json'), 'utf8'));
        const blob = PlayerService.initialAttributeBlob(roleInit.initialAttributes);
        for (const key of LEGACY_MIRROR_KEYS) {
            expect(Object.prototype.hasOwnProperty.call(blob, key)).toBe(false);
        }
        // 该留的要留着：神识池 + 两档 attributeField 属性（少了就是玩家资源池被清空，是真事故）
        expect(blob).toMatchObject({ sense: expect.any(Number), luck: expect.any(Number), wisdom: expect.any(Number) });
        // 注册表都不认识的键一律保留（可能是玩法自己的状态位），别把"没抄进清单"当"该删"
        expect(PlayerService.initialAttributeBlob({ some_playfield_flag: 1 })).toEqual({ some_playfield_flag: 1 });
    });

    test('建号与重置两处都用同一个过滤口径（不许有人再直接赋整份 initialAttributes）', () => {
        const created = fs.readFileSync(path.join(SERVER_ROOT, 'game/core/PlayerService.js'), 'utf8');
        const reset = fs.readFileSync(path.join(SERVER_ROOT, 'routes/admin.js'), 'utf8');
        expect(created).toMatch(/attributes: this\.initialAttributeBlob\(initialAttributes\)/);
        expect(reset).toMatch(/player\.attributes = PlayerService\.initialAttributeBlob\(initialAttrs\)/);
    });
});
