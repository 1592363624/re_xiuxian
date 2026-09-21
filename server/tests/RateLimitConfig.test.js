/**
 * 限流阈值"配了要真生效"的门禁
 *
 * 两条容易写错的路：
 *   1) 中间件在模块加载时就建好了（那时配置还没读进来），所以必须有一次配置就绪后的重建；
 *   2) 后台改完配置要有办法不换进程就生效 —— 依赖 ConfigLoader 的 configHotUpdated 事件。
 * 原先 index.js 把这条订阅挂在 infrastructure.EventBus 上，而事件是 ConfigLoader 发在自己身上的
 * （ConfigLoader extends EventEmitter，见它的 hotUpdateConfig），所以订阅从来没执行过。
 * 更要命的是 config/game_balance.json 里的 rate_limit 数值**和代码兜底值一模一样**，
 * 于是"配置根本没生效"这件事在响应头上完全看不出来 —— 这里用哨兵值把它变成可判定的断言。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const {
    getRateLimitConfig,
    getRuntimeRateLimitState,
    watchRateLimitConfig
} = require('../middleware/rateLimit');

const gameBalance = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'game_balance.json'), 'utf-8')
);
const DEFAULTS = {
    api: { limit: 600, window_seconds: 60 },
    action: { limit: 120, window_seconds: 60 },
    auth: { limit: 10, window_seconds: 900 },
    admin: { limit: 200, window_seconds: 60 }
};

/** 把一份 rate_limit 段塞进配置缓存（getConfig 与热更新后的重建都读这里） */
function withRateLimit(rateLimitSection) {
    configLoader.setMergedConfig('game_balance', { ...gameBalance, rate_limit: rateLimitSection });
}

afterAll(() => {
    // 还原成"本文件从没碰过"的样子，免得同 worker 里后面的测试看到哨兵值
    configLoader.configCache.delete('game_balance');
});

describe('限流阈值来自配置，且热更新能换进运行中的限流器', () => {
    test('哨兵值确实穿过了配置层进到生效阈值（不是永远吃代码兜底）', () => {
        withRateLimit({
            api: { limit: 7, window_seconds: 3 },
            action: { limit: 11, window_seconds: 41 },
            auth: DEFAULTS.auth,
            admin: DEFAULTS.admin
        });
        // 哨兵必须和兜底值不同，否则这条断言是空的
        expect(7).not.toBe(DEFAULTS.api.limit);
        expect(getRateLimitConfig().api).toEqual({ limit: 7, window_seconds: 3 });
        expect(getRateLimitConfig().action).toEqual({ limit: 11, window_seconds: 41 });
    });

    test('数值写错时逐字段退回兜底值，而不是把防护关掉', () => {
        withRateLimit({
            api: { limit: 0, window_seconds: -5 },
            action: { limit: '一百', window_seconds: 60 }
        });
        const cfg = getRateLimitConfig();
        expect(cfg.api).toEqual(DEFAULTS.api);
        expect(cfg.action.limit).toBe(DEFAULTS.action.limit);
        expect(cfg.auth).toEqual(DEFAULTS.auth);
    });

    test('改 game_balance 的热更新会重建限流器，改别的配置不会', () => {
        const stop = watchRateLimitConfig(configLoader);
        try {
            const before = getRuntimeRateLimitState().generation;
            configLoader.emit('configHotUpdated', { configName: 'item_data', timestamp: Date.now() });
            expect(getRuntimeRateLimitState().generation).toBe(before);

            configLoader.emit('configHotUpdated', { configName: 'game_balance', timestamp: Date.now() });
            expect(getRuntimeRateLimitState().generation).toBe(before + 1);

            // 退订之后不再重建（订阅者生命周期也要对）
            stop();
            configLoader.emit('configHotUpdated', { configName: 'game_balance', timestamp: Date.now() });
            expect(getRuntimeRateLimitState().generation).toBe(before + 1);
        } finally {
            stop();
        }
    });

    test('启动脚本挂的是事件的发送方，不再是 EventBus', () => {
        const boot = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
        expect(boot).toMatch(/watchRateLimitConfig\(configLoader\)/);
        expect(boot).not.toMatch(/EventBus\.subscribe\(\s*['"]configHotUpdated/);
        // 重建必须发生在配置加载之后，否则读到的还是兜底值
        expect(boot.indexOf('initializeConfigLoader()')).toBeLessThan(boot.indexOf('initializeRateLimiters()'));
    });
});
