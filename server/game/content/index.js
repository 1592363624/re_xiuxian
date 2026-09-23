/**
 * 内容层启动装配：把"基础配置 + 资料片"的合并视图接进 ConfigLoader。
 *
 * 顺序很重要：
 *   1. ConfigLoader 先把 server/config/*.json 读进缓存（基础层）
 *   2. 这里构建 ContentRegistry：扫描 server/content/packs，合并、校验、装属性词表
 *   3. 合并结果回灌 configLoader.setMergedConfig(...)
 *      → 现网数十处 getConfig('item_data') 不需要任何改动就能看到资料片内容
 *   4. 订阅 configHotUpdated：后台改基础配置后重新合并，避免热更把资料片内容冲掉
 *
 * 校验不过时故意让异常抛出：内容损坏（属性名拼错、引用不存在的物品）应该在启动时就炸，
 * 而不是像以前那样在运行期返回 undefined 表现成"玩家数据不对"。
 */
'use strict';

const { ContentRegistry, ContentError } = require('./ContentRegistry');
const { statRegistry } = require('../stats');

let instance = null;

function initializeContentLayer(configLoader, options = {}) {
    const content = new ContentRegistry({
        configPath: configLoader.configPath,
        // 测试要能指向一份临时 pack 目录；不给就用 ContentRegistry 的默认位置
        packDir: options.packDir,
        statRegistry
    });

    const report = content.load();

    for (const [name, data] of content.mergedDatasets().entries()) {
        configLoader.setMergedConfig(name, data);
    }

    // 后台热更只重写基础文件；重新合并一次，否则资料片内容会被裸基础值顶掉
    configLoader.on('configHotUpdated', ({ configName }) => {
        const merged = content.reload(configName);
        if (merged !== null && merged !== undefined) {
            configLoader.setMergedConfig(configName, merged);
        }
        // 这里刻意不 try-catch：ContentRegistry.reload 校验不过会退回上一版视图再抛错，
        // 异常顺着 emit 回到 hotUpdateConfig，由它把运行时缓存整体退回旧值、让接口报错给操作者。
        // 吞掉异常的话，失败的编辑就会以"配置悄悄少了资料片内容"的形式留在运行中的进程里。
    });

    instance = content;

    const packs = report.packs.filter(pack => pack.enabled);
    console.log(
        `[ContentRegistry] 内容层装配完成：${packs.length} 个资料片` +
        (packs.length ? `（${packs.map(p => `${p.id}@${p.version}`).join(', ')}）` : '') +
        `，${content.mergedDatasets().size} 个数据集，${statRegistry.count} 个属性`
    );
    // 体检提示默认不刷屏到控制台（console.warn 走 stderr，启动窗口会整片发红）。
    // 明细在 report.warnings，用 npm run content:report 或设 CONTENT_VERBOSE=1 查看。
    if (report.warnings.length) {
        if (process.env.CONTENT_VERBOSE) {
            for (const warning of report.warnings) console.log(`[ContentRegistry] ${warning}`);
        } else {
            console.log(`[ContentRegistry] 内容体检提示 ${report.warnings.length} 条（明细: npm run content:report）`);
        }
    }

    return { content, report };
}

function contentRegistry() {
    return instance;
}

/** 属性是否可用（内容层未装配时给调用方一个明确的失败点，而不是 undefined） */
function requireStatRegistry() {
    if (!instance) throw new Error('内容层尚未初始化，statRegistry 不可用');
    return statRegistry;
}

module.exports = { initializeContentLayer, contentRegistry, requireStatRegistry, ContentError };
