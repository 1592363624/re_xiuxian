/**
 * 双时间系统与坊市锚定单元测试
 *
 * 覆盖范围（对应 P3 修复）：
 *   - 时间路由依赖的服务端方法真实存在且行为正确（旧实现调用了不存在的 DualTimeService 方法，必然 TypeError）
 *   - 活动年数、完成时点全部由服务端配置与服务器时钟决定，客户端只能被钳制
 *   - time_system_data 不再接收客户端 activity_config 结构
 *   - 坊市挂单价格锚定：拒绝"1 灵石换神器"式折价
 *
 * 测试策略：纯逻辑，注入 mock configLoader 与 LifespanService，不接触 MySQL。
 */

// 坊市锚定为纯计算校验，不触发查询；仅 mock 死亡流程依赖
const mockHandleLifespanEnd = jest.fn(async (player) => ({ playerId: player.id, message: '寿元耗尽' }));
jest.mock('../game/core/LifespanService', () => ({
    handleLifespanEnd: (...args) => mockHandleLifespanEnd(...args)
}));

const DualTimeService = require('../game/core/DualTimeService');
const MarketService = require('../game/services/MarketService');

const TIME_SYSTEM_CONFIG = {
    heavenly_events: [
        { key: 'spirit_tide', name: '灵潮', interval_years: 10, first_year: 5 },
        { key: 'beast_calamity', name: '兽劫', interval_years: 25, first_year: 15 },
        { key: 'immortal_assembly', name: '万仙大会', interval_years: 50, first_year: 30 }
    ],
    mortal_activities: {
        cultivation: { name: '参悟打坐', default_years: 0.5, min_years: 0.5, max_years: 5, real_seconds_per_year: 60 },
        training: { name: '秘境历练', default_years: 1, min_years: 1, max_years: 10, real_seconds_per_year: 120 },
        seclusion: { name: '闭关苦修', default_years: 3, min_years: 1, max_years: 20, real_seconds_per_year: 180 }
    },
    limits: { max_pending_activities: 3, next_events_preview_count: 3 }
};

function makeConfigLoader(configs) {
    return {
        getConfig: (name) => {
            if (!(name in configs)) throw new Error(`配置 ${name} 未加载`);
            return configs[name];
        },
        loadConfig: async (name) => configs[name] || {}
    };
}

const makePlayer = (overrides = {}) => ({
    id: 1,
    lifespan_current: 20,
    lifespan_max: 60,
    heavenly_age: 0,
    mortal_age: 0,
    time_system_data: { pending_activities: [] },
    saved: 0,
    async save() { this.saved += 1; },
    ...overrides
});

beforeEach(() => {
    DualTimeService.initialize(makeConfigLoader({ time_system: TIME_SYSTEM_CONFIG }));
    mockHandleLifespanEnd.mockClear();
});

describe('天道时间状态', () => {
    test('getTimeSystemStatus 返回纪年与按年份升序的世界事件', () => {
        const status = DualTimeService.getTimeSystemStatus();

        expect(status.heavenly_time.current_year).toBeGreaterThanOrEqual(1);
        expect(status.heavenly_time.next_events.map(e => e.event)).toEqual([
            'spirit_tide', 'beast_calamity', 'immortal_assembly'
        ]);
        expect(status.heavenly_time.next_events.every(e => e.years_until > 0)).toBe(true);
    });

    test('配置未加载时兜底为空配置而非抛错', () => {
        DualTimeService.initialize(makeConfigLoader({}));
        const status = DualTimeService.getTimeSystemStatus();

        expect(status.heavenly_time.next_events).toEqual([]);
        expect(DualTimeService.getAvailableActivities(makePlayer())).toEqual([]);
    });
});

describe('红尘活动时间消耗只由服务端决定', () => {
    test('未配置的活动类型返回 null（路由据此拒绝）', () => {
        expect(DualTimeService.processMortalTimeConsumption(makePlayer(), 'not_exist', 1)).toBeNull();
        expect(DualTimeService.processMortalTimeConsumption(makePlayer(), '__proto__', 1)).toBeNull();
    });

    test('客户端放大年数被钳制到配置上限', () => {
        const result = DualTimeService.processMortalTimeConsumption(makePlayer(), 'seclusion', 99999);

        expect(result.time_cost_years).toBe(20);
        expect(result.age_increase).toBe(20);
        expect(result.wait_seconds).toBe(20 * 180);
    });

    test('脏年数入参回落到服务端默认年数', () => {
        for (const bad of ['abc', {}, -5, 0, null, undefined]) {
            const result = DualTimeService.processMortalTimeConsumption(makePlayer(), 'seclusion', bad);
            expect(result.time_cost_years).toBe(3);
        }
    });

    test('完成时点由服务器时钟生成，晚于当前时间', () => {
        const before = Date.now();
        const result = DualTimeService.processMortalTimeConsumption(makePlayer(), 'training', 2);

        expect(new Date(result.completion_time).getTime()).toBeGreaterThanOrEqual(before + 2 * 120 * 1000 - 1000);
    });

    test('同名活动不可叠加，进行中数量受上限约束', () => {
        const empty = makePlayer();
        expect(DualTimeService.getAvailableActivities(empty)).toEqual(['cultivation', 'training', 'seclusion']);

        const onePending = makePlayer({
            time_system_data: { pending_activities: [{ id: 'a', activity_type: 'seclusion' }] }
        });
        expect(DualTimeService.getAvailableActivities(onePending)).toEqual(['cultivation', 'training']);

        const threePending = makePlayer({
            time_system_data: {
                pending_activities: [
                    { id: 'a', activity_type: 'cultivation' },
                    { id: 'b', activity_type: 'training' },
                    { id: 'c', activity_type: 'seclusion' }
                ]
            }
        });
        expect(DualTimeService.getAvailableActivities(threePending)).toEqual([]);
    });

    test('脏 time_system_data 不会导致异常', () => {
        expect(DualTimeService.getPendingActivities(makePlayer({ time_system_data: null }))).toEqual([]);
        expect(DualTimeService.getPendingActivities(makePlayer({ time_system_data: { pending_activities: 'x' } }))).toEqual([]);
        expect(DualTimeService.getPendingActivities(undefined)).toEqual([]);
    });
});

describe('寿元结算', () => {
    test('剩余寿命取自玩家列，而非已废弃的 attributes 嵌套字段', () => {
        const player = makePlayer({ attributes: { lifespan_current: 999, lifespan_max: 1000 } });

        expect(DualTimeService.calculateRemainingLifespan(player)).toBe(40);
        expect(DualTimeService.getLifespanSummary(player).remaining_lifespan).toBe(40);
    });

    test('完成活动累加红尘年龄与寿元消耗', async () => {
        const player = makePlayer();
        const result = await DualTimeService.processActivityCompletion(player, {
            activity_type: 'seclusion',
            time_cost_years: 5
        });

        expect(player.mortal_age).toBe(5);
        expect(player.lifespan_current).toBe(25);
        expect(result.lifespan_exhausted).toBe(false);
        expect(mockHandleLifespanEnd).not.toHaveBeenCalled();
    });

    test('寿元耗尽时走统一死亡流程', async () => {
        const player = makePlayer({ lifespan_current: 58, lifespan_max: 60 });
        const result = await DualTimeService.processActivityCompletion(player, {
            activity_type: 'seclusion',
            time_cost_years: 5
        });

        expect(player.lifespan_current).toBe(60);
        expect(result.lifespan_exhausted).toBe(true);
        expect(mockHandleLifespanEnd).toHaveBeenCalledTimes(1);
    });

    test('活动记录缺少年数时拒绝结算，避免凭空发放', async () => {
        await expect(DualTimeService.processActivityCompletion(makePlayer(), { activity_type: 'seclusion' }))
            .rejects.toThrow();
        await expect(DualTimeService.processActivityCompletion(makePlayer(), { time_cost_years: -3 }))
            .rejects.toThrow();
    });
});

describe('坊市挂单价格锚定', () => {
    const MARKET_CONFIG = { game_balance: { market: { max_active_listings: 20, max_price_ratio: 5 } }, item_data: { items: [] } };

    beforeEach(() => {
        MarketService.initialize(makeConfigLoader(MARKET_CONFIG));
    });

    const item = (price) => ({ price });

    test('换取价值远低于出售价值时拒绝', () => {
        const result = MarketService.checkPriceAnchor(item(10000), 1, item(1), 1);

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('挂单换取价值过低');
    });

    test('在允许折价倍数内放行', () => {
        expect(MarketService.checkPriceAnchor(item(100), 1, item(20), 1).allowed).toBe(true);
        expect(MarketService.checkPriceAnchor(item(100), 1, item(20), 1).allowed).toBe(true);
    });

    test('无参考价的物品跳过锚定（任务道具/材料）', () => {
        expect(MarketService.checkPriceAnchor(item(0), 1, item(1), 1).allowed).toBe(true);
        expect(MarketService.checkPriceAnchor({}, 1, item(1), 1).allowed).toBe(true);
    });

    test('数量参与总价值比较', () => {
        expect(MarketService.checkPriceAnchor(item(100), 10, item(20), 10).allowed).toBe(true);
        expect(MarketService.checkPriceAnchor(item(100), 10, item(20), 1).allowed).toBe(false);
    });
});
