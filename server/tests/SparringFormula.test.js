/**
 * 切磋木人的伤害结算（SparringService）—— 不连库
 *
 * 盯的缺陷形状：切磋是最后一份"把伤害算式抄在服务里"的玩法，而且抄了三份
 * （玩家普攻、玩家技能、木人回击）。抄成三份的代价不是难看，而是：
 *   - 全局战斗公式（combat_formulas.json）改动时，切磋不跟着变；
 *   - 给木人加一个属性，没有任何一处会去读它（startSparring 手写挑了 4 个键）；
 *   - 配置用 require(JSON) 直接读文件，进程活多久就缓存多久 —— 资料片加的木人看不到。
 * 切磋的分数进排行榜，所以这里的等价性断言是主角：同一对属性、同一个随机数，
 * 改造前后必须给出同一个伤害值。
 */
'use strict';

const SparringService = require('../game/services/SparringService');
const CombatResolver = require('../game/combat/CombatResolver');
const { infrastructure, initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');

beforeAll(async () => {
    await initializeModules();
    ensureStatRegistryLoaded();
    CombatResolver.initialize(infrastructure.ConfigLoader);
});

const RANGE = 15;
const OFFSET = 7;
const MULT = 1.5;
const PARAMS = { random_range: RANGE, random_offset: OFFSET, skill_multiplier: MULT };

// 改造前那份内联算式，逐字照抄
const legacyBasic = (atk, def, r) => Math.max(1, atk - def + Math.floor(r * RANGE) - OFFSET);
const legacySkill = (atk, def, r) => Math.floor(legacyBasic(atk, def, r) * MULT);

describe('切磋的伤害与改造前逐点相同', () => {
    const pairs = [[500, 20], [10, 1200], [80, 80], [3000, 1200], [1, 1], [2500, 1200]];

    test('普攻档：攻 - 防 + 随机浮动 - 偏移，打不动也至少 1 点', () => {
        for (const [atk, def] of pairs) {
            for (let i = 0; i < 400; i += 1) {
                const r = i / 400;
                const original = Math.random;
                Math.random = () => r;
                try {
                    expect(SparringService._strike({ atk }, { def }, false, PARAMS)).toBe(legacyBasic(atk, def, r));
                } finally {
                    Math.random = original;
                }
            }
        }
    });

    test('技能档：先夹保底、再整块乘倍率（这条形状与全局档位不同，所以档位自带 formula）', () => {
        for (const [atk, def] of pairs) {
            for (let i = 0; i < 400; i += 1) {
                const r = i / 400;
                const original = Math.random;
                Math.random = () => r;
                try {
                    expect(SparringService._strike({ atk }, { def }, true, PARAMS)).toBe(legacySkill(atk, def, r));
                } finally {
                    Math.random = original;
                }
            }
        }
    });

    test('浮动与倍率取自切磋自己的配置，不是全局常数（改了内容就该生效）', () => {
        const wide = { random_range: 60, random_offset: 30, skill_multiplier: 3 };
        const narrow = { random_range: 2, random_offset: 0, skill_multiplier: 1 };
        const original = Math.random;
        Math.random = () => 0.99;
        try {
            expect(SparringService._strike({ atk: 100 }, { def: 50 }, false, wide))
                .not.toBe(SparringService._strike({ atk: 100 }, { def: 50 }, false, narrow));
            expect(SparringService._strike({ atk: 100 }, { def: 50 }, false, wide))
                .toBe(Math.max(1, 100 - 50 + Math.floor(0.99 * 60) - 30));
        } finally {
            Math.random = original;
        }
    });
});

describe('切磋战斗循环仍然自洽', () => {
    const woodman = (over = {}) => ({
        name: '炼气木人', tier: 1, max_hp: BigInt(500), hp: BigInt(500),
        atk: 50, def: 20, speed: 50, ...over
    });
    const player = (over = {}) => ({
        atk: 120, def: 40, speed: 60, hp: BigInt(2000), hp_max: BigInt(2000),
        mp: BigInt(200), mp_max: BigInt(200), ...over
    });
    const GLOBAL = { max_rounds: 30, damage_random_range: RANGE, damage_random_offset: OFFSET, skill_mp_cost: 20, skill_damage_multiplier: MULT };

    test('够强的玩家打得赢，日志里每一记伤害都落在改造前的取值带内', () => {
        const result = SparringService._simulateBattle(player(), woodman(), GLOBAL);
        expect(result.result).toBe('win');
        const hits = result.log.flatMap(entry => entry.actions);
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
            // 普攻带 = 攻 - 防 + [0, range-1] - offset（夹 1 保底）；技能带 = 整带乘倍率后取整
            const raw = hit.attacker === 'player' ? 120 - 20 : 50 - 40;
            const band = [Math.max(1, raw - OFFSET), Math.max(1, raw + (RANGE - 1) - OFFSET)];
            const [lo, hi] = hit.action === 'skill'
                ? [Math.floor(band[0] * MULT), Math.floor(band[1] * MULT)]
                : band;
            expect(hit.damage).toBeGreaterThanOrEqual(lo);
            expect(hit.damage).toBeLessThanOrEqual(hi);
        }
        expect(result.rounds).toBeLessThan(GLOBAL.max_rounds);
        expect(result.player_mp_used).toBeGreaterThan(0n);
    });

    test('打不动就是打不动：30 回合后判超时，玩家血量永不为负', () => {
        const result = SparringService._simulateBattle(player({ atk: 21, def: 40, speed: 1 }), woodman({ atk: 30 }), GLOBAL);
        expect(result.result).toBe('timeout');
        expect(result.rounds).toBe(GLOBAL.max_rounds);
        expect(result.player_hp).toBeGreaterThanOrEqual(0n);
        expect(result.woodman_hp).toBeGreaterThan(0n);
    });

    test('服务里不再留有自己那份伤害算式，配置也不再 require 死文件', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'game', 'services', 'SparringService.js'), 'utf-8');
        expect(source).not.toMatch(/Math\.max\(1,\s*\w*[Aa]tk\s*-/);
        expect(source).toMatch(/computeDamage\(useSkill \? 'sparring_skill' : 'sparring_basic'/);
        expect(source).not.toMatch(/require\('\.\.\/\.\.\/config\/sparring_woodman\.json'\)/);
        expect(source).toMatch(/getConfig\('sparring_woodman'\)/);
    });

    test('切磋木人这个数据集要在内容层里（资料片才能加木人，启动期校验才看得见它）', () => {
        expect(Object.keys(require('../game/content/ContentRegistry').DATASET_SPECS)).toContain('sparring_woodman');
    });
});
