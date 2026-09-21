/**
 * 属性面板契约测试
 *
 * 兑现"加一个属性不用改前端"的那一半：前端只认 GET /api/attribute/panel 下发的词表，
 * 所以这份词表必须自带标签、短名、后缀、显示位置，并且能覆盖现网内容里真实出现过的
 * 每一个效果键。这里任何一条失败，表现都是玩家在某张卡片上看到 "sword_intent+12" 这种原始键名。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');

const serverRoot = path.join(__dirname, '..');

const content = new ContentRegistry({
    configPath: path.join(serverRoot, 'config'),
    packDir: path.join(serverRoot, 'content', 'packs'),
    statRegistry
});
content.load();

const panel = statRegistry.panelStats();
const vocabulary = content.effectVocabulary();

/** 收集物品数据里真正用到的 effect 键（基础配置 + 资料片的 add/override 都算） */
function collectItemEffectKeys() {
    const keys = new Set();
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        if (typeof node.effect === 'object' && node.effect) {
            Object.keys(node.effect).forEach(key => keys.add(key));
        }
        Object.values(node).forEach(visit);
    };
    visit(content.dataset('item_data'));
    return [...keys];
}

describe('面板字段定义', () => {
    test('每个可见属性都带齐展示所需字段，前端不需要再抄一份表', () => {
        expect(panel.length).toBeGreaterThan(0);
        for (const entry of panel) {
            expect(typeof entry.label).toBe('string');
            expect(entry.label.length).toBeGreaterThan(0);
            expect(entry.shortLabel || entry.label).toBeTruthy();
            expect(typeof entry.description).toBe('string');
            expect(['sidebar', 'detail']).toContain(entry.spot);
            expect(Number.isFinite(entry.order)).toBe(true);
            expect(Array.isArray(entry.aliases)).toBe(true);
        }
    });

    test('百分比单位一律带 % 后缀（含资料片属性）', () => {
        const percent = statRegistry.all().filter(def => def.unit === 'percent');
        expect(percent.length).toBeGreaterThan(0);
        for (const def of percent) {
            expect(def.panel.suffix).toBe('%');
        }
    });

    test('左栏属性格由定义决定：资料片加的剑意自动占一格，前端零改动', () => {
        const sidebar = statRegistry.panelStatsFor('sidebar').map(s => s.key);
        expect(sidebar).toEqual(expect.arrayContaining(['atk', 'def', 'speed', 'sense']));
        expect(sidebar).toContain('sword_intent');
    });

    test('可加点属性把客户端提交键与存储键一起下发，加点表单不必硬编码', () => {
        for (const entry of panel.filter(s => s.allocatable)) {
            expect(typeof entry.allocInputKey).toBe('string');
            expect(entry.allocInputKey.length).toBeGreaterThan(0);
            expect(typeof entry.bonusKey).toBe('string');
            expect(entry.bonusKey.endsWith('_bonus')).toBe(true);
        }
        // hp/mp 的客户端键与规范键不同，存储键也是历史遗留名，必须显式给出而不是让前端猜
        const hp = panel.find(s => s.key === 'hp_max');
        expect(hp.allocatable).toBe(true);
        expect(hp.allocInputKey).toBe('hp');
        expect(hp.bonusKey).toBe('hp_bonus');
    });
});

describe('物品效果词表', () => {
    test('现网物品用到的每个效果键都能查到展示名', () => {
        const labelable = new Map([
            ...panel.map(entry => [entry.key, entry.label]),
            ...panel.flatMap(entry => entry.aliases.map(alias => [alias, entry.label])),
            ...vocabulary.map(entry => [entry.id, entry.label])
        ]);
        const unlabelled = collectItemEffectKeys().filter(key => !labelable.has(key));
        expect(unlabelled).toEqual([]);
    });

    test('倍率型效果标记了换算方式，前端据此显示百分号而不是裸小数', () => {
        const breakthrough = vocabulary.find(entry => entry.id === 'breakthrough_bonus');
        expect(breakthrough.format).toBe('ratio_pct');
    });
});

describe('配置可解析性（面板链路的启动前提）', () => {
    test('stat_definitions 与资料片同名文件都是合法 JSON', () => {
        const files = [
            path.join(serverRoot, 'config', 'stat_definitions.json'),
            path.join(serverRoot, 'content', 'packs', 'fanren_legacy', 'stat_definitions.json')
        ];
        for (const file of files) {
            expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
        }
    });
});
