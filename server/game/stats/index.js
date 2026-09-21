/**
 * 属性系统对外入口：全进程共用一个 StatRegistry 实例。
 *
 * 属性词表由 ContentRegistry 在启动时装入（基础层 config/stat_definitions.json
 * + 各资料片的 stat_definitions 追加），因此任何服务只要 require('../game/stats')
 * 拿到的都是同一份"游戏里到底有哪些属性"。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { StatRegistry, StatDefinitionError } = require('./StatRegistry');
const { StatEngine, normalizeModifiers } = require('./StatEngine');
const Expr = require('./Expr');

const statRegistry = new StatRegistry();

/**
 * 确保属性词表可用。
 *
 * 正常启动路径是内容层（ContentRegistry）装配时把"基础 + 资料片"的合并词表装入；
 * 但服务被单独使用（单元测试、脚本、后台任务）时没人跑过启动流程，
 * 这里退回直接读基础定义文件，保证"有哪些属性"这个事实只有一个来源而不是一推就 undefined。
 *
 * @param {Object} [configLoader] 已初始化的配置加载器，优先用它的热缓存
 */
function ensureStatRegistryLoaded(configLoader) {
    if (statRegistry.isLoaded) return statRegistry;

    let defs = null;
    if (configLoader?.hasConfig?.('stat_definitions')) {
        defs = configLoader.getConfig('stat_definitions')?.stats || null;
    }
    if (!defs) {
        const file = path.join(__dirname, '..', '..', 'config', 'stat_definitions.json');
        defs = JSON.parse(fs.readFileSync(file, 'utf-8')).stats || [];
    }

    statRegistry.reset();
    statRegistry.load(defs, 'base');
    statRegistry.validate();
    return statRegistry;
}

module.exports = {
    statRegistry,
    ensureStatRegistryLoaded,
    StatRegistry,
    StatEngine,
    normalizeModifiers,
    Expr,
    StatDefinitionError
};
