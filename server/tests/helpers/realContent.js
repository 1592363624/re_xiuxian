/**
 * 资料片验收测试的共用装配：把"基础配置 + 全部资料片"的真实视图喂给各服务。
 *
 * 单元测试不连库，所以这里给的是一个假的 configLoader：
 * 已登记进 DATASET_SPECS 的数据集取合并结果，其余（spirit_system / combat_formulas 之外的裸配置）
 * 直接回读 config 目录。两个资料片测试共用，避免各自抄一份、然后只有一份真的在测合并视图。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ContentRegistry } = require('../../game/content/ContentRegistry');

const serverRoot = path.join(__dirname, '..', '..');

function loadRealContent(statRegistry) {
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'),
        packDir: path.join(serverRoot, 'content', 'packs'),
        statRegistry
    });
    content.load();
    return content;
}

function makeRealConfigLoader(content) {
    const caches = new Map(content.mergedDatasets());
    const readFromDisk = (name) => require(path.join(serverRoot, 'config', `${name}.json`));
    const resolve = (name) => {
        if (caches.has(name)) return caches.get(name);
        const fromDisk = readFromDisk(name);
        caches.set(name, fromDisk);
        return fromDisk;
    };
    return {
        getConfig: (name) => resolve(name),
        loadConfig: async (name) => resolve(name),
        hasConfig: (name) => {
            if (caches.has(name)) return true;
            return fs.existsSync(path.join(serverRoot, 'config', `${name}.json`));
        }
    };
}

/**
 * 把所有需要查库的属性来源显式给定（空的或指定的），
 * 这样测试测的是"属性怎么算"，而不是"能不能连上 MySQL"。
 */
function emptySources(extra = {}) {
    return {
        equipment: {}, spirit_beast: {}, technique: {}, puppet: null,
        artifact_deep_line: { is_active: false, absolute: {}, percent: {}, effects: {}, breakdown: {} },
        artifact_spirit: { is_active: false, absolute: {}, percent: {}, effects: [], breakdown: [] },
        dharma_form: { pct: 0 },
        ...extra
    };
}

module.exports = { serverRoot, loadRealContent, makeRealConfigLoader, emptySources };
