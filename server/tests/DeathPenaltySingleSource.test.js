/**
 * 「玩家死了扣多少修为」只剩一处定义（2026-09-23）
 *
 * 改造前仓里有 5 份实现（PVE 战斗 / 世界BOSS / 妖兽入侵 / 寿元耗尽 / 重生），
 * 三份把率按两位小数圆、两份按四位，两份还"绝对值写 exp + 把 attributes 整块赋回"，
 * 一份连行锁都没有。这类"同一件规则抄五遍"正是业主说的"加一个东西很多地方要改"的极端形状：
 * 谁改了其中一份，其余四份继续按旧算法跑，而玩家能同时踩到（死在野怪身上 -10%，死在 BOSS 身上 -5%）。
 *
 * 现在唯一实现在 `game/core/deathPenalty.js`：写的是 players.exp 列上的**原子减**
 * （`patchPlayerState({amounts})`，锁内重读、下限 0、blob 镜像由 PlayerStateStore 维护），
 * 各作用域的率仍各读各的内容键（BOSS 5% / 野外 10% 是刻意设计差异，不是漂移）。
 * 这份测试负责三件事：率与精度只有一个来源、写库形状是原子减而不是绝对值、
 * 以及**五个调用点真的在用它**（把旧写法塞进同一段文本里必须被抓到 —— 防止户口册空转）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { serverRoot } = require('./helpers/realContent');
const { infrastructure } = require('../modules');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const deathPenalty = require('../game/core/deathPenalty');

const SCOPED_SITES = [
    ['game/services/CombatService.js', 'combat'],
    ['game/services/WorldBossService.js', 'world_boss'],
    ['game/services/BeastInvasionService.js', 'beast_invasion'],
    ['game/core/LifespanService.js', 'lifespan'],
    ['game/core/PlayerService.js', 'lifespan']
];

const readSite = rel => fs.readFileSync(path.join(serverRoot, rel), 'utf8');

describe('率的唯一来源', () => {
    let warnBefore = [];
    beforeAll(async () => {
        const { initializeModules } = require('../modules');
        await initializeModules();                       // 不装配 ConfigLoader 时 getConfig 会抛，别拿默认值当测量结果
        warnBefore = console.warn;
    });

    test('四个作用域各自读内容里那一键（期望值现读现算，不在测试里抄数字）', () => {
        const balance = infrastructure.ConfigLoader.getConfig('game_balance');
        expect(deathPenalty.resolveExpPenaltyRate('combat')).toBe(Number(balance.combat.death_exp_penalty_rate));
        expect(deathPenalty.resolveExpPenaltyRate('world_boss')).toBe(Number(balance.world_boss.death_exp_penalty_rate));
        expect(deathPenalty.resolveExpPenaltyRate('beast_invasion')).toBe(Number(balance.beast_invasion.death_exp_penalty_rate));
        expect(deathPenalty.resolveExpPenaltyRate('lifespan')).toBe(Number(balance.lifespan.death_exp_loss_rate));
    });

    test('配置里的 0 是"不罚"，不会被 || 兜底吃回默认值', () => {
        const loader = infrastructure.ConfigLoader;
        const real = loader.getConfig.bind(loader);
        const patched = { ...real('game_balance'), combat: { ...real('game_balance').combat, death_exp_penalty_rate: 0 } };
        loader.getConfig = name => (name === 'game_balance' ? patched : real(name));
        try {
            expect(deathPenalty.resolveExpPenaltyRate('combat')).toBe(0);
        } finally {
            loader.getConfig = real;
        }
        expect(deathPenalty.resolveExpPenaltyRate('combat')).not.toBe(0);   // 还原后照旧
    });

    test('配置写错（越界/非数）→ 回默认并点名一次，而不是把惩罚力度算成 NaN', () => {
        const loader = infrastructure.ConfigLoader;
        const real = loader.getConfig.bind(loader);
        let warned = 0;
        const originalWarn = console.warn;
        console.warn = (...args) => { if (String(args[0]).includes('不是 0~1 的数')) warned += 1; };
        loader.getConfig = name => (name === 'game_balance'
            ? { ...real('game_balance'), world_boss: { death_exp_penalty_rate: 1.5 } } : real(name));
        try {
            const fallback = deathPenalty.RATE_KEYS.world_boss.fallback;
            expect(deathPenalty.resolveExpPenaltyRate('world_boss')).toBe(fallback);
        } finally {
            loader.getConfig = real; console.warn = originalWarn;
        }
        expect(warned).toBe(1);
    });

    test('未知作用域直接抛（新玩法要加一档就得先在这份表里说清读哪个键）', () => {
        expect(() => deathPenalty.resolveExpPenaltyRate('sect_war')).toThrow(/未知的陨落惩罚作用域/);
    });

    test('精度统一到万分比：0.025 不再被圆成 0.02/0.03', () => {
        expect(deathPenalty.penaltyOf(100000n, 0.025)).toBe(2500n);
        // 旧的两份写法：Math.round(0.025*100)=3 → 3000（另一份 4 位 → 2500）同一个配置两个结果
        expect(100000n * BigInt(Math.round(0.025 * 100)) / 100n).toBe(3000n);
    });
});

describe('写库形状：列上原子减，不是"读旧值算绝对值再整块写回"', () => {
    const originals = {
        readForUpdate: PlayerStateStore.readForUpdate,
        patchPlayerState: PlayerStateStore.patchPlayerState,
        withTransaction: PlayerStateStore.withTransaction
    };
    let calls;

    beforeEach(() => {
        calls = { patches: [], locked: 0, ownTx: 0 };
        PlayerStateStore.readForUpdate = async (id) => { calls.locked += 1; return { exp: 100000n }; };
        PlayerStateStore.patchPlayerState = async (id, patch, options) => {
            calls.patches.push({ patch, options });
            const delta = Number(patch.amounts.exp);
            return { exp: BigInt(100000 + delta) };
        };
        PlayerStateStore.withTransaction = async fn => fn({ LOCK: { UPDATE: 'UPDATE' } });
    });
    afterEach(() => Object.assign(PlayerStateStore, originals));

    test('扣的是锁内那一份，且写的是 amounts（不是 columns 绝对值、也不是整块 attributes）', async () => {
        const t = { LOCK: { UPDATE: 'UPDATE' } };
        const result = await deathPenalty.applyExpPenalty({ playerId: 7, scope: 'world_boss', transaction: t });
        expect(calls.locked).toBe(1);
        expect(calls.patches).toHaveLength(1);
        expect(calls.patches[0].patch).toEqual({ amounts: { exp: -5000n } });   // 100000 × 5%
        expect(calls.patches[0].options.transaction).toBe(t);                   // 复用调用方事务，不自开连接（§50 自锁那一族）
        expect(calls.patches[0].patch.attributes).toBeUndefined();
        expect(calls.ownTx).toBe(0);
        expect(result).toMatchObject({ rate: 0.05, penalty: 5000n, skipped: false });
        expect(result.exp_after).toBe(95000n);
    });

    test('率为 0 时一次库都不写（skipped），也不再 bump state_version', async () => {
        const result = await deathPenalty.applyExpPenalty({ playerId: 7, rate: 0, transaction: { LOCK: {} } });
        expect(result).toMatchObject({ penalty: 0n, skipped: true, exp_after: 100000n });
        expect(calls.patches).toEqual([]);
    });

    test('调用方没事务时自己开一个并在里面锁读（寿元耗尽那条链以前是无锁读 + 整行写回）', async () => {
        let opened = 0;
        PlayerStateStore.withTransaction = async fn => { opened += 1; return fn({ LOCK: { UPDATE: 'UPDATE' } }); };
        const result = await deathPenalty.applyExpPenalty({ playerId: 7, scope: 'lifespan' });
        expect(opened).toBe(1);
        expect(calls.locked).toBe(1);
        expect(calls.patches[0].patch.amounts.exp).toBe(-10000n);               // 100000 × 10%
        expect(result.skipped).toBe(false);
    });

    test('非法率抛，而不是悄悄按 0 或按 NaN 扣', async () => {
        await expect(deathPenalty.applyExpPenalty({ playerId: 7, rate: 'abc' })).rejects.toThrow(/陨落惩罚率非法/);
        await expect(deathPenalty.applyExpPenalty({ playerId: 7, rate: 2 })).rejects.toThrow(/陨落惩罚率非法/);
    });
});

describe('五个陨落入口都在用这一份（并且不再自己写 exp）', () => {
    test.each(SCOPED_SITES)('%s 调 applyExpPenalty 且作用域是 %s', (rel, scope) => {
        const src = readSite(rel);
        expect(src).toMatch(/require\('\.{1,2}\/(?:core\/)?deathPenalty'\)/);
        const calls = [...src.matchAll(/applyExpPenalty\(\{[^}]*scope:\s*'([a-z_]+)'/g)].map(m => m[1]);
        expect(calls).toContain(scope);
        // 不再"读旧值 → 算绝对值 → 写回 exp"，也不再自己碰 attributes
        expect(src).not.toMatch(/player\.exp\s*=(?!=)/);
        expect(src).not.toMatch(/_applyDeathExpPenalty/);
    });

    test('陨落惩罚的配置键只出现在唯一实现里（要加一个作用域就先在那份表里登记）', () => {
        const files = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) files.push(full);
            }
        };
        walk(path.join(serverRoot, 'game'));
        walk(path.join(serverRoot, 'routes'));
        const offenders = files
            .filter(f => !f.endsWith(path.join('core', 'deathPenalty.js')))
            .map(f => path.relative(serverRoot, f).split(path.sep).join('/'))
            .filter(rel => readSite(rel).split('\n')
                .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
                .some(line => /death_exp_penalty_rate|death_exp_loss_rate/.test(line)));
        expect(offenders).toEqual([]);
    });

    test('控制跑：把旧写法塞回一段文本，判据必须抓到（户口册不是空转）', () => {
        const legacy = `
            const currentExp = safeBigInt(player.exp);
            const penaltyRate = getGameBalanceConfig().combat?.death_exp_penalty_rate ?? 0.1;
            player.exp = currentExp - penaltyExp;
            player.attributes = attrs;`;
        expect(legacy).toMatch(/player\.exp\s*=(?!=)/);
        expect(legacy).toMatch(/death_exp_penalty_rate/);
        expect(legacy).not.toContain('applyExpPenalty');
    });

    test('寿元耗尽那句提示跟着真正生效的率（收口时那个局部量已被删，留着会印 NaN%）', () => {
        const src = readSite('game/core/LifespanService.js');
        expect(src).toMatch(/deathPenalty\.rate/);
        expect(src).not.toMatch(/Math\.round\(lossRate/);
    });
});
