/**
 * 配置新鲜度门禁：热更新之后，服务必须立刻读到新值
 *
 * 起因：慕兰战线（主服务 + 三个子服务）、坐化遗府、神识对决都把 getConfig(...) 的结果
 * 存在模块级 `_config` 里，只在"还没存到"时才重读。于是后台改完配置、甚至
 * POST /api/config/hot-update 返回成功之后，这些服务仍然用着开机那一刻的旧副本，而且不报错。
 * （getConfig 本身只是 Map.get，解析早在加载时做过 —— 那层缓存没有收益，只有 staleness。）
 *
 * 现在这些服务每次现读 ConfigLoader.peekConfig(...)。这里既钉住"每次现读"的行为，
 * 也钉住"别再往模块变量里存配置"这个形状，防止下一个玩法又抄一遍旧写法。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const BorderMilitaryService = require('../game/services/BorderMilitaryService');
const CaveLegacyService = require('../game/services/CaveLegacyService');
const DivineDuelService = require('../game/services/DivineDuelService');

const SERVER_ROOT = path.join(__dirname, '..');
const WATCHED = ['border_military_data', 'cave_legacy_data', 'late_stage_data'];
const originals = new Map(WATCHED.map(name => [name, (() => {
    try { return configLoader.getConfig(name); } catch { return null; }
})()]));

afterAll(() => {
    for (const [name, value] of originals) {
        if (value) configLoader.setMergedConfig(name, value);
        else configLoader.configCache.delete(name);
    }
});

describe('配置热更新后要立刻被服务读到', () => {
    test('peekConfig：没加载给 null，要哪段给哪段，换了配置下一次读就是新值', () => {
        expect(configLoader.peekConfig('this_config_does_not_exist')).toBe(null);

        configLoader.setMergedConfig('border_military_data', { settings: { daily_reset_hour: 4 }, tag: 'A' });
        expect(configLoader.peekConfig('border_military_data').tag).toBe('A');
        expect(configLoader.peekConfig('border_military_data', 'settings').daily_reset_hour).toBe(4);
        expect(configLoader.peekConfig('border_military_data', 'not_a_section')).toBe(null);

        configLoader.setMergedConfig('border_military_data', { settings: { daily_reset_hour: 9 }, tag: 'B' });
        expect(configLoader.peekConfig('border_military_data').tag).toBe('B');
    });

    test('慕兰战线主服务：连着两次热更都跟着变（旧写法第二次仍返回第一份副本）', () => {
        configLoader.setMergedConfig('border_military_data', { settings: { min_realm: '炼气' }, tag: 'first' });
        expect(BorderMilitaryService.getConfig().tag).toBe('first');

        configLoader.setMergedConfig('border_military_data', { settings: { min_realm: '炼气' }, tag: 'second' });
        expect(BorderMilitaryService.getConfig().tag).toBe('second');

        configLoader.configCache.delete('border_military_data');
        expect(BorderMilitaryService.getConfig()).toBe(null);
    });

    test('坐化遗府与神识对决读的是配置里自己那一段，并且同样即时', () => {
        configLoader.setMergedConfig('cave_legacy_data', { cave_legacy: { max_duration_hours: 24, tag: 'legacy-1' } });
        expect(CaveLegacyService.getConfig().tag).toBe('legacy-1');
        configLoader.setMergedConfig('cave_legacy_data', { cave_legacy: { max_duration_hours: 48, tag: 'legacy-2' } });
        expect(CaveLegacyService.getConfig().max_duration_hours).toBe(48);

        configLoader.setMergedConfig('late_stage_data', { divine_duel: { max_rounds: 3, tag: 'duel-1' } });
        expect(DivineDuelService.getConfig().tag).toBe('duel-1');
        configLoader.setMergedConfig('late_stage_data', { divine_duel: { max_rounds: 7, tag: 'duel-2' } });
        expect(DivineDuelService.getConfig().max_rounds).toBe(7);

        // 这两处判的是"整份配置里我这一段"，段不存在时必须给 null（服务方法靠它判可用性）
        configLoader.setMergedConfig('late_stage_data', { other_section: {} });
        expect(DivineDuelService.getConfig()).toBe(null);
    });

    test('没有服务再把配置存进模块级变量（旧写法的形状）', () => {
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules') continue;
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!entry.name.endsWith('.js')) continue;
                fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
                    if (/^let _(config|cachedConfig|data|settings)\s*=\s*null;?$/.test(line)) {
                        offenders.push(`${path.relative(SERVER_ROOT, p)}:${i + 1}  ${line.trim()}`);
                    }
                });
            }
        })(path.join(SERVER_ROOT, 'game'));
        expect(offenders).toEqual([]);
    });

    test('这 6 个服务都改成走 peekConfig', () => {
        for (const rel of [
            'game/services/BorderMilitaryService.js',
            'game/services/BorderBeastPatrolSubService.js',
            'game/services/RemnantMapSubService.js',
            'game/services/WarImprintSubService.js',
            'game/services/CaveLegacyService.js',
            'game/services/DivineDuelService.js'
        ]) {
            const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf-8');
            expect(source).toMatch(/peekConfig\(/);
            expect(source).not.toMatch(/_config\s*=\s*\w+\.getConfig\(/);
        }
    });
});
