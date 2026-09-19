/**
 * 并发写入回归测试（2026-09-19）
 *
 * 覆盖两处修复：
 *   1. 历练结算可被双领 —— AdventureEventService.completeAdventure
 *      原实现「无锁读 status → 发奖 → 才改 completed」，两个标签页各发一遍奖励
 *   2. 寿元 tick 覆盖并发写入 —— LifespanService.updateLifespan
 *      原实现把无锁读出来的年龄当绝对值写回，会抹掉读-写窗口内其他路径的寿元改动
 *
 * 测试策略：
 *   本套件全程 mock，不接触 MySQL（tests 目录下另有 4 个套件连的是真实库，
 *   不要一起跑）。因此这里验证的是**代码逻辑**：拿不到 in_progress 行就绝不发奖、
 *   批量 UPDATE 写的是增量而不是绝对值。MySQL 行锁本身是否生效无法用 mock 证明，
 *   需要真库并发验证时请另写集成测试。
 */

// 工厂必须自包含：jest.mock 会被提升到文件顶部，不能引用外部变量。
// 事务对象挂在 mock 模块的 __lastTransaction 上供断言取用。
jest.mock('../config/database', () => {
    const db = {
        __lastTransaction: null,
        transaction: jest.fn(async () => {
            const t = {
                LOCK: { UPDATE: 'UPDATE' },
                commit: jest.fn().mockResolvedValue(),
                rollback: jest.fn().mockResolvedValue()
            };
            db.__lastTransaction = t;
            return t;
        }),
        query: jest.fn().mockResolvedValue([]),
        QueryTypes: { UPDATE: 'UPDATE' },
        // AdventureEventService 会连带 require 若干模型文件，它们在模块加载期就调用
        // sequelize.define / 关联方法。给一个通用桩，让整条 require 链能跑起来。
        define: jest.fn(() => ({
            belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(),
            findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn(),
            create: jest.fn(), update: jest.fn(), bulkCreate: jest.fn(), destroy: jest.fn()
        }))
    };
    return db;
});

jest.mock('../models/player', () => ({
    findByPk: jest.fn(),
    findAll: jest.fn()
}));

jest.mock('../models/playerAdventure', () => ({
    findOne: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn()
}));

jest.mock('../models/item', () => ({
    findOrCreate: jest.fn()
}));

// LifespanService 与 AdventureEventService 都通过 infrastructure.ConfigLoader 读配置
jest.mock('../modules', () => ({
    infrastructure: {
        ConfigLoader: {
            getConfig: (name) => {
                if (name === 'game_balance') {
                    return {
                        lifespan: { days_per_year: 365, seconds_per_day: 60, update_batch_size: 200 },
                        adventure: { early_finish_penalty: 0.5 }
                    };
                }
                if (name === 'role_init') return { agingRate: 1 };
                return {};
            }
        }
    }
}));

const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerAdventure = require('../models/playerAdventure');
const Item = require('../models/item');
const AdventureEventService = require('../game/services/AdventureEventService');
const LifespanService = require('../game/core/LifespanService');

// AdventureEventService 导出类，LifespanService 导出单例
const adventureService = new AdventureEventService();
const lifespanService = LifespanService;

/** realm_rank=1 让 getRealmMultiplier 走快路径，不触碰 RealmService */
const makePlayer = () => ({
    id: 1,
    realm_rank: 1,
    exp: '1000',
    mp_current: '100',
    spirit_stones: '500',
    hp_current: '200',
    lifespan_current: 100,
    lifespan_max: 500,
    is_secluded: false,
    is_dead: false,
    save: jest.fn().mockResolvedValue()
});

const makeAdventureRow = () => ({
    id: 77,
    status: 'in_progress',
    // 已结束（end_time 在过去）→ rewardScale=1，结果确定
    end_time: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 120_000),
    event_data: { rewards: { exp: 100, spirit_stones: 50, items: [] }, injury_chance: 0 }
});

beforeEach(() => {
    jest.clearAllMocks();
    sequelize.__lastTransaction = null;
});

/** 取被测代码最近一次开启的事务，用于断言 commit / rollback */
const tx = () => sequelize.__lastTransaction;

describe('历练结算：并发双领', () => {
    test('拿不到 in_progress 行时返回 NO_ADVENTURE，且一个奖励都不发', async () => {
        Player.findByPk.mockResolvedValue(makePlayer());
        // 第一次请求提交后，第二个标签页在行锁上排队，醒来时已无 in_progress 行
        PlayerAdventure.findOne.mockResolvedValue(null);

        const result = await adventureService.completeAdventure(1);

        expect(result.success).toBe(false);
        expect(result.code).toBe('NO_ADVENTURE');
        expect(Item.findOrCreate).not.toHaveBeenCalled();
        expect(PlayerAdventure.update).not.toHaveBeenCalled();
    });

    test('结算走事务：读历练行必须带 FOR UPDATE，成功提交、不残留未回滚事务', async () => {
        Player.findByPk.mockResolvedValue(makePlayer());
        PlayerAdventure.findOne.mockResolvedValue(makeAdventureRow());
        PlayerAdventure.update.mockResolvedValue([1]);

        const result = await adventureService.completeAdventure(1);

        expect(result.success).toBe(true);
        expect(PlayerAdventure.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { player_id: 1, status: 'in_progress' },
                lock: 'UPDATE'
            })
        );
        expect(tx().commit).toHaveBeenCalledTimes(1);
        expect(tx().rollback).not.toHaveBeenCalled();
    });

    test('标记 completed 的 WHERE 同时约束 status，语句层面保证只结算一次', async () => {
        Player.findByPk.mockResolvedValue(makePlayer());
        PlayerAdventure.findOne.mockResolvedValue(makeAdventureRow());
        PlayerAdventure.update.mockResolvedValue([1]);

        await adventureService.completeAdventure(1);

        expect(PlayerAdventure.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'completed', rewards_claimed: true }),
            expect.objectContaining({ where: { id: 77, status: 'in_progress' } })
        );
    });

    test('发奖异常时回滚事务，不会留下半提交状态', async () => {
        Player.findByPk.mockResolvedValue(makePlayer());
        PlayerAdventure.findOne.mockResolvedValue(makeAdventureRow());
        PlayerAdventure.update.mockRejectedValue(new Error('boom'));

        const result = await adventureService.completeAdventure(1);

        expect(result.success).toBe(false);
        expect(tx().rollback).toHaveBeenCalledTimes(1);
        expect(tx().commit).not.toHaveBeenCalled();
    });
});

describe('寿元 tick：不再用绝对值覆盖', () => {
    const capturedSql = () => {
        const call = sequelize.query.mock.calls.find(c => String(c[0]).includes('UPDATE players'));
        return call ? String(call[0]) : '';
    };

    test('批量 UPDATE 写增量，而不是把读出来的年龄当目标值盖回去', async () => {
        Player.findAll.mockResolvedValue([makePlayer()]);

        // 120 秒 / 60 秒每天 = 2 天；2/365 年 * agingRate(1) ≈ 0.005479 岁
        await lifespanService.updateLifespan(120);

        const sql = capturedSql();
        expect(sql).toContain('lifespan_current = COALESCE(lifespan_current, 0) + CASE');
        expect(sql).toContain('WHEN 1 THEN 0.005479');
        // 关键：绝不能出现「SET lifespan_current = CASE id WHEN ... THEN <绝对年龄>」
        expect(sql).not.toMatch(/SET lifespan_current = CASE/);
        expect(sql).not.toContain('THEN 100.005479');
    });

    test('WHERE 补上 is_secluded / is_dead，读到写之间刚闭关或刚死的玩家不被衰老', async () => {
        Player.findAll.mockResolvedValue([makePlayer()]);

        await lifespanService.updateLifespan(120);

        const sql = capturedSql();
        expect(sql).toContain('is_secluded = false');
        expect(sql).toContain('is_dead = false');
    });

    test('寿元耗尽仍走死亡分支，不做增量写入', async () => {
        const dying = makePlayer();
        dying.lifespan_current = 499.999;
        dying.lifespan_max = 500;
        Player.findAll.mockResolvedValue([dying]);
        jest.spyOn(lifespanService, 'handleLifespanEnd').mockResolvedValue({ playerId: 1 });

        const result = await lifespanService.updateLifespan(120);

        expect(lifespanService.handleLifespanEnd).toHaveBeenCalledTimes(1);
        expect(result.deadCount).toBe(1);
        expect(capturedSql()).toBe('');
    });

    test('secondsPassed 非法时不产生任何写入，避免 NaN 污染字段', async () => {
        Player.findAll.mockResolvedValue([makePlayer()]);

        const result = await lifespanService.updateLifespan(0);

        expect(result.processed).toBe(0);
        expect(sequelize.query).not.toHaveBeenCalled();
        expect(Player.findAll).not.toHaveBeenCalled();
    });
});
