/**
 * 数据集"能不能被资料片扩展"的登记门禁
 *
 * 为什么需要：DATASET_SPECS 是唯一决定"某个 config 文件能不能被 pack 增删条目"的地方。
 * 漏登记的后果是静默的 —— 内容层日志一切正常，只是资料片往那个玩法里加东西时加不进去
 * （cave_data 整份没登记就是这一类：五座设施、四条灵种、五处景观、五种访客遭遇、十件商人货摊
 * 全都扩不了，而登记之后两道既有闸当场又各自报出三处手抄清单）。
 *
 * 这道闸不要求"全都登记"：数值/阈值/凭据类文件本来就该留在代码侧，
 * 但它们必须**在下面的清单里写明理由**。理由过期同样要响 —— 那说明文件已经不是那个性质了。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');

const serverRoot = path.join(__dirname, '..');
const configDir = path.join(serverRoot, 'config');

/** 代码按名字读到的数据集：getConfig / peekConfig / loadConfig 三种写法 */
const READ_RE = /(?:getConfig|peekConfig|loadConfig)\(\s*'([\w.]+)'/g;
const SKIP_DIRS = new Set(['node_modules', 'migrations', 'tests', 'scripts']);

function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function datasetsReadByCode() {
    const found = new Map();
    for (const file of walk(serverRoot, [])) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(READ_RE)) {
            if (!found.has(m[1])) found.set(m[1], new Set());
            found.get(m[1]).add(path.relative(serverRoot, file).split(path.sep).join('/'));
        }
    }
    return found;
}

/**
 * 不登记的理由必须写在这里。
 * 判据是"这份文件里没有可以一条条增删的条目"：数值开关、阈值、凭据、界面表都算。
 */
const NOT_EXTENSIBLE = {
    ai_config: 'AI 供应商地址/密钥/超时/限流：既不是条目表，也不该让资料片往里写凭据',
    announcement_upload: '公告配图的落盘目录/URL 前缀/体积上限/文件头白名单与批量删除上限：纯运维阈值与安全白名单，没有可按条增删的内容集合',
    attribute_system: '恢复速率与丹药/加点的钳制阈值；里面的 attribute_bonuses 两张表全仓库没人读（见下条 test）',
    auction_data: '拍卖时长/加价率/手续费/调度间隔等阈值，没有可增删的条目集合',
    cave_legacy_data: '坐化遗府的活动时长、参与资格阈值与物品筛选规则，条目本身来自 item_data',
    dao_companion_data: '道侣/双修的门槛与冷却数值；heart_contract_effects.levels 按心契等级索引，扩等级同时要改玩法代码',
    // game_balance 已从"整份不可扩"移到 DATASET_SPECS，但只登记了一条嵌套路径
    // `equipment.slot_names`（装备槽位词表）。理由：槽位清单以前是裸字符串数组，不能按条增删，
    // 于是资料片加得了新装备却加不了它要进的那个槽位 —— 那是"加内容"，不是"改数值"。
    // 其余 game_balance 段落（间隔/分页/限速/段位表）仍然不可扩：写进 pack 会被"没有该集合"挡下。
    notification_icons: '事件名 → 图标映射，加事件本来就要写发事件的那行代码',
    notification_policy: '通知调度周期/批量大小/回执回收开关与重提示文案：纯运维阈值与文案模板，没有可按条增删的内容集合',
    // role_init 已登记（2026-09-22）：spirit_roots 是条目集合、概率表与加成表是 map 集合。
    // 原来那条"map 集合只支持对象值所以加不了灵根"的理由被 CollectionShapeLedger 的实测否证；
    // 而它作为"元素权威词表"的身份仍然成立 —— 校验读的是合并视图，所以资料片扩了词表，
    // 校验也跟着扩（而不是像以前那样：新灵根的 element 会被写死在基础文件上的校验拒收）。
    seclusion: '闭关参数，每个叶子都是 {value,unit,displayName} 形式的标量',
    system: '服务端口、版本、GitHub 仓库地址等运行时配置'
};

/** 登记了但故意没有基础文件的数据集：内容完全由资料片提供 */
const PACK_ONLY_DATASETS = {
    effect_vocabulary: '非属性效果键的登记表：基础配置里没有这个文件，由资料片按需追加（ContentRegistry.test.js 有活样本）'
};

const read = datasetsReadByCode();
const registered = new Set(ContentRegistry.registeredDatasets);
const onDisk = new Set(fs.readdirSync(configDir).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, '')));

describe('每个被代码读取的数据集都要么能被资料片扩展，要么写明为什么不能', () => {
    test('扫描器确实看见了真文件（读到的数据集数量与登记数都不许为 0）', () => {
        expect(read.size).toBeGreaterThanOrEqual(45);
        expect(registered.size).toBeGreaterThanOrEqual(40);
        expect(onDisk.size).toBeGreaterThanOrEqual(50);
    });

    test('读得到、又没登记、又没写理由的数据集：0 个', () => {
        const unexplained = [...read.keys()]
            .filter(name => !registered.has(name) && !NOT_EXTENSIBLE[name])
            .map(name => `${name}（读它的文件：${[...read.get(name)].slice(0, 3).join(', ')}）`);
        if (unexplained.length) {
            throw new Error('要么在 ContentRegistry 的 DATASET_SPECS 里登记它的集合名与主键，'
                + '要么在本文件的 NOT_EXTENSIBLE 里写清"为什么不是条目表"：\n  ' + unexplained.join('\n  '));
        }
        expect(unexplained).toEqual([]);
    });

    test('豁免清单不过期：每条理由对应的数据集仍被代码读取', () => {
        const stale = Object.keys(NOT_EXTENSIBLE).filter(name => !read.has(name));
        if (stale.length) throw new Error('这些数据集已经没有代码按名字读了，理由该连着文件一起清理：' + stale.join('/'));
        expect(stale).toEqual([]);
    });

    test('登记了却没有基础文件的数据集只能是有意为之的资料片扩展点', () => {
        const fileless = [...registered].filter(name => !onDisk.has(name));
        const unexplained = fileless.filter(name => !PACK_ONLY_DATASETS[name]);
        if (unexplained.length) {
            throw new Error('这些数据集登记了但 config/ 下没有同名文件，也没写理由：'
                + unexplained.join('/') + '（要么补基础文件，要么进 PACK_ONLY_DATASETS 说明它就该由资料片供内容）');
        }
        expect(unexplained).toEqual([]);
    });

    test('登记的嵌套集合路径在基础配置里真存在（写错一截就等于资料片永远合并不进来）', () => {
        const broken = [];
        for (const [dataset, spec] of Object.entries(DATASET_SPECS)) {
            if (!spec.collections) continue;
            let base;
            try { base = JSON.parse(fs.readFileSync(path.join(serverRoot, 'config', `${dataset}.json`), 'utf8')); }
            catch { continue; }   // 没有基础文件的数据集由"资料片扩展点"那条用例管
            for (const [path_, def] of Object.entries(spec.collections)) {
                if (!path_.includes('.') || def?.optional) continue;
                let cursor = base;
                for (const seg of path_.split('.')) {
                    cursor = cursor && typeof cursor === 'object' ? cursor[seg] : undefined;
                }
                if (cursor === undefined) broken.push(`${dataset}.${path_}`);
            }
        }
        if (broken.length) {
            throw new Error('这些登记的嵌套集合路径在基础配置里找不到容器（资料片写它会报"没有该集合"，等于白登记）：'
                + broken.join(', '));
        }
        expect(broken).toEqual([]);
    });

    test('代码把"某张表的键"当合法全集来遍历的地方，那张表必须登记成集合（两张已知的现在都登记了）', () => {
        // 这两处的形状一模一样：Object.keys(内容表) 决定"允许哪些值 / 算哪些档"。
        // 表不可扩展 = 资料片加了新条目却被自己的合法集挡在外头，而且报错点在代码里查不到（因为代码是泛化的）。
        const collections = DATASET_SPECS.formation_data.collections;
        expect(collections['global.category_display_names']).toEqual({ map: true });   // 阵法流派全集
        expect(collections['global.grade_display_names']).toEqual({ map: true });       // 阵法品阶全集
        expect(DATASET_SPECS.spirit_beast_data.collections.settings).toEqual({ map: true });   // 灵兽战力权重表
        // 反向钉子：相克引用表刻意不登记（值是引用不是标签，登记了才会造出"配了不生效"）
        expect(collections['global.counter_relationships']).toBeUndefined();
        const formation = fs.readFileSync(path.join(serverRoot, 'game/services/FormationService.js'), 'utf8');
        expect(formation).toMatch(/Object\.keys\(cfg\?\.global\?\.category_display_names \|\| \{\}\)/);
        const beast = fs.readFileSync(path.join(serverRoot, 'game/services/SpiritBeastService.js'), 'utf8');
        expect(beast).toMatch(/of Object\.entries\(weights\)/);
    });

    test('attribute_system.attribute_bonuses 仍是死配置（有人开始读它时，要重新评估该不该登记）', () => {
        expect(require('../config/attribute_system.json').attribute_bonuses).toBeTruthy();
        // 只认 attribute_bonuses 这个配置路径名：spirit_root_bonus 同时也是 routes/player.js 的响应字段名，
        // 拿它当"有没有人读这份配置"的判据会误报（第一版就是这么误判的）
        const readers = walk(serverRoot, [])
            .filter(f => /attribute_bonuses/.test(fs.readFileSync(f, 'utf8')))
            .map(f => path.relative(serverRoot, f).split(path.sep).join('/'));
        expect(readers).toEqual([]);
    });
});
