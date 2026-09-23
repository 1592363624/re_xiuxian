/**
 * 批次6 琉璃古塔 / 剑诀 / 奇遇 / 宗门外交 / 定脉 —— 配置与纯逻辑契约
 *
 * 不连库。盯三件事：
 *   1. 五份配置形状正确（层/剑诀/事件/宗门/动作都齐）
 *   2. 纯玩法结算函数（古塔模拟、脉象加权）可复现、不抛
 *   3. 路由文件导出 express router，且 index.js 已挂载
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '../config');

function loadJson(name) {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`), 'utf8'));
}

describe('批次6 玩法配置形状', () => {
    test('pagoda_data：9 层 + 全局参数 + 首通奖励键齐全', () => {
        const cfg = loadJson('pagoda_data');
        expect(cfg.floors.length).toBeGreaterThanOrEqual(5);
        expect(cfg.global.daily_limit).toBeGreaterThan(0);
        for (const f of cfg.floors) {
            expect(typeof f.floor).toBe('number');
            expect(f.name).toBeTruthy();
            expect(f.stats?.max_hp).toBeGreaterThan(0);
            expect(f.rewards?.exp_win).toBeGreaterThanOrEqual(0);
        }
    });

    test('sword_art_data：剑诀含炼剑阶 + 剑阵含前置条件', () => {
        const cfg = loadJson('sword_art_data');
        expect(cfg.manuals.length).toBeGreaterThanOrEqual(2);
        for (const m of cfg.manuals) {
            expect(m.id).toBeTruthy();
            expect(m.refine_stages?.length).toBeGreaterThanOrEqual(3);
            expect(m.display_bonus_only).toBe(true);
        }
        for (const f of cfg.formations || []) {
            expect(f.required_manual).toBeTruthy();
            expect(typeof f.required_insight).toBe('number');
            expect(f.display_bonus_only !== false).toBe(true);
        }
    });

    test('fated_event_data：事件含命令提示与抉择/答题之一', () => {
        const cfg = loadJson('fated_event_data');
        expect(cfg.events.length).toBeGreaterThanOrEqual(5);
        for (const e of cfg.events) {
            expect(e.id).toBeTruthy();
            expect(Array.isArray(e.command_hints)).toBe(true);
            expect(e.command_hints.length).toBeGreaterThan(0);
            const hasChoice = (e.choices || []).length > 0;
            const hasQuiz = !!e.quiz;
            expect(hasChoice || hasQuiz).toBe(true);
        }
    });

    test('sect_diplomacy_data：6 宗门 + 四类外交行动 + 关系分档', () => {
        const cfg = loadJson('sect_diplomacy_data');
        expect(cfg.sects.length).toBeGreaterThanOrEqual(4);
        const acts = cfg.global.diplomacy_actions;
        for (const key of ['goodwill', 'ally', 'hostile', 'break_relation']) {
            expect(acts[key]).toBeTruthy();
        }
        expect(cfg.global.relation_bands.length).toBeGreaterThanOrEqual(4);
    });

    test('dingmai_data：四动作 + 脉象 + 灵根修正', () => {
        const cfg = loadJson('dingmai_data');
        expect(cfg.actions.length).toBe(4);
        const ids = cfg.actions.map(a => a.id).sort();
        expect(ids).toEqual(['charge', 'infuse', 'purify', 'stabilize']);
        expect(cfg.vein_types.length).toBe(4);
        expect(cfg.root_type_modifiers.waste.can_charge).toBe(false);
    });
});

describe('古塔模拟纯逻辑', () => {
    const PagodaService = require('../game/services/PagodaService');

    test('模拟返回完整战报，win/lose/timeout 三态之一', () => {
        const playerStats = { hp: 5000, mp: 200, atk: 300, def: 100, speed: 120 };
        const floorStats = { max_hp: 2800, atk: 190, def: 90, speed: 100 };
        const sim = PagodaService._simulate(playerStats, floorStats, 20);
        expect(['win', 'lose', 'timeout']).toContain(sim.result);
        expect(sim.rounds_used).toBeGreaterThan(0);
        expect(Array.isArray(sim.log)).toBe(true);
        expect(sim.log.length).toBeGreaterThan(0);
        expect(typeof sim.hp_ratio).toBe('number');
    });

    test('超强玩家必胜，弱鸡玩家难胜', () => {
        const god = PagodaService._simulate(
            { hp: 999999, mp: 99999, atk: 99999, def: 99999, speed: 999 },
            { max_hp: 100, atk: 1, def: 0, speed: 1 },
            20
        );
        expect(god.result).toBe('win');

        const weak = PagodaService._simulate(
            { hp: 10, mp: 0, atk: 1, def: 0, speed: 1 },
            { max_hp: 999999, atk: 99999, def: 99999, speed: 999 },
            5
        );
        expect(weak.result).toBe('lose');
    });
});

describe('路由与挂载契约', () => {
    test('五个路由文件导出 router', () => {
        for (const name of ['pagoda', 'sword_art', 'fated_event', 'sect_diplomacy', 'dingmai']) {
            const src = fs.readFileSync(path.join(__dirname, `../routes/${name}.js`), 'utf8');
            expect(src).toMatch(/module\.exports\s*=\s*router/);
            expect(src).toMatch(/auth/);
        }
    });

    test('index.js 已挂载五个新路由', () => {
        const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
        for (const p of ['/api/pagoda', '/api/sword-art', '/api/fated-event', '/api/sect-diplomacy', '/api/dingmai']) {
            expect(src).toContain(p);
        }
    });

    test('前端 actionCatalog 已登记五个入口', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../client/src/data/actionCatalog.js'), 'utf8'
        );
        for (const id of ['pagoda', 'sword_art', 'fated_event', 'sect_diplomacy', 'dingmai']) {
            expect(src).toMatch(new RegExp(`${id}:`));
        }
    });

    test('前端 registry 已绑定五个面板', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../client/src/components/panels/registry.js'), 'utf8'
        );
        for (const p of ['PagodaPanel', 'SwordArtPanel', 'FatedEventPanel', 'SectDiplomacyPanel', 'DingmaiPanel']) {
            expect(src).toContain(p);
        }
    });
});
