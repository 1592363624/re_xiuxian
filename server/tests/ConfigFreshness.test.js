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

    test('`static _config` 那一形也要现读（傀儡 / 钓鱼 / 赌石：第七到九例，旧扫描只认 `let` 全漏了）', () => {
        // 这三家的 initialize 记的是 loader 本身，配置每次读现取；
        // 注入物只有 getConfig（单测与离线脚本里两种 loader 都存在）时必须也能读、不许 TypeError。
        const cases = [
            ['puppet', require('../game/services/PuppetService'), 'puppet_data'],
            ['fishing', require('../game/services/FishingService'), 'fishing_data'],
            ['gambling', require('../game/services/GamblingStoneService'), 'gambling_stone_data']
        ];
        for (const [, service, name] of cases) {
            const original = (() => { try { return configLoader.getConfig(name); } catch { return null; } })();
            try {
                service._config = { tag: 'override-from-test' };
                expect(service._config.tag).toBe('override-from-test');      // setter 那条路（假配置）优先
                service._config = null;

                service.initialize({ peekConfig: n => (n === name ? { tag: 'first' } : null) });
                expect(service._config.tag).toBe('first');
                service.initialize({ peekConfig: n => (n === name ? { tag: 'second' } : null) });
                // 换 loader 之后还拿到第一份 = 又把配置钉在变量里了
                expect({ name, tag: service._config.tag }).toEqual({ name, tag: 'second' });

                service.initialize({ getConfig: n => { if (n !== name) throw new Error('未加载'); return { tag: 'legacy-loader' }; } });
                expect({ name, tag: service._config.tag }).toEqual({ name, tag: 'legacy-loader' });

                service._config = null;
            } finally {
                service._config = null;
                if (original) configLoader.setMergedConfig(name, original);
                // 把 loader 也换回真的：不然同一进程里后面的测试会读到我这只假桶
                service.initialize(configLoader);
            }
        }
    });

    test('没有服务再把配置存进模块级变量（旧写法的形状）', () => {
        // 两个信号都要扫：①"配一个模块/类级变量存配置"这个声明形状；②把 getConfig 的结果**赋进那个变量**。
        // 第一版只扫 `^let _config = null;$`，于是 `static _config = null`（赌石、钓鱼）整批漏网 ——
        // 同一条规律在傀儡身上第一次就漏过（那次是 static 不是 let），扫描器不认新形状就等于没有。
        // 判据按"声明 + 缓存赋值"两条一起看：只声明不赋值的（getter 背后那份缓存）不算命中。
        const DECL = /^\s*(?:static\s+|let\s+|var\s+)(\w*_(?:config|cfg|data|settings|snapshot))\s*=\s*null\s*;?\s*$/;
        const CACHE_ASSIGN = /[\w$.]*_?(?:config|cfg)\s*=\s*[\w$.]*\.getConfig\s*\(/;
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules') continue;
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!entry.name.endsWith('.js')) continue;
                const lines = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n').split('\n');
                const declared = lines.map((line, i) => [line.match(DECL)?.[1], i + 1])
                    .filter(([name]) => Boolean(name));
                if (!declared.length) continue;
                // 允许的形状（PuppetService 那一套）：变量名以 Cache/Override 结尾，且有一份现读的 getter
                const cachedButNotReRead = declared.filter(([name]) => !/(_cache|_override|Cache|Override)$/.test(name));
                if (!cachedButNotReRead.length) continue;
                const assigns = lines.filter(line => CACHE_ASSIGN.test(line));
                if (!assigns.length && !/peekConfig\(/.test(lines.join('\n'))) continue;
                offenders.push(`${path.relative(SERVER_ROOT, p)}  声明 ${cachedButNotReRead.map(([n, l]) => `${n}@${l}`).join(',')}`
                    + (assigns.length ? ` + 缓存赋值 ${assigns.length} 处 → ${assigns[0].trim()}` : '（没有现读取舍，也没有 peekConfig）'));
            }
        })(path.join(SERVER_ROOT, 'game'));
        expect(offenders).toEqual([]);
    });

    test('扫描器自己得能看见 static 那一形（不然是假绿）', () => {
        const looksLikeDeclaration = line => Boolean(line.match(/^\s*(?:static\s+|let\s+|var\s+)(\w*_(?:config|cfg|data|settings|snapshot))\s*=\s*null\s*;?\s*$/));
        expect(looksLikeDeclaration('    static _config = null;')).toBe(true);
        expect(looksLikeDeclaration('let _config = null;')).toBe(true);
        expect(looksLikeDeclaration('    static _configCache = null;')).toBe(false);   // 现读那一套的缓存位
        expect(looksLikeDeclaration('    static _initialized = false;')).toBe(false);
    });

    test('这些服务都改成走 peekConfig', () => {
        for (const rel of [
            'game/services/BorderMilitaryService.js',
            'game/services/BorderBeastPatrolSubService.js',
            'game/services/RemnantMapSubService.js',
            'game/services/WarImprintSubService.js',
            'game/services/CaveLegacyService.js',
            'game/services/DivineDuelService.js',
            // 2026-09-23 又捞出三处同形状的：傀儡是 `static` 而不是 `let` 躲过了旧扫描，
            // 钓鱼与赌石是同一处盲区里剩下的两个（这一条清单现在按"声明了配置位的服务"点名，
            // 新增一个玩法服务如果把配置钉在类变量上，上面那条形状扫描就会先把人喊回来）
            'game/services/PuppetService.js',
            'game/services/FishingService.js',
            'game/services/GamblingStoneService.js'
        ]) {
            const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf-8');
            expect(source).toMatch(/peekConfig\(/);
            expect(source).not.toMatch(/_config\s*=\s*\w+\.getConfig\(/);
        }
    });
});
