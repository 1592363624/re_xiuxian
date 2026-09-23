/**
 * 世界动态日志：模板插值、白名单映射、限流
 *
 * 起因：修仙日志「全部」以前只有自己 + 系统，单人挂机像单机。
 * 其他道友的关键结果（突破/陨落/闭关/历练…）要能播进来，
 * 但必须走配置白名单 + 限流，不能把每一次操作都刷成聊天室。
 */
const WorldActivityService = require('../game/services/WorldActivityService');

describe('WorldActivityService', () => {
    beforeEach(() => {
        WorldActivityService.lastByActor.clear();
        WorldActivityService.recentGlobal = [];
        WorldActivityService.nameCache.clear();
    });

    describe('renderTemplate', () => {
        test('占位符被 changes 替换', () => {
            expect(WorldActivityService.renderTemplate('突破成功，踏入{new_realm}！', { new_realm: '筑基期' }))
                .toBe('突破成功，踏入筑基期！');
        });

        test('缺字段时放弃整条，不输出 {key} 原文', () => {
            expect(WorldActivityService.renderTemplate('踏入{new_realm}！', {})).toBeNull();
        });

        test('无占位符的静态文案直接过', () => {
            expect(WorldActivityService.renderTemplate('进入闭关，潜心修炼。', {}))
                .toBe('进入闭关，潜心修炼。');
        });
    });

    describe('allow（限流）', () => {
        const cfg = {
            rate_limit: { per_actor_ms: 10_000, global_per_minute: 60, important_bypass: true }
        };

        test('同一人连续非重要动态被冷却挡住', () => {
            expect(WorldActivityService.allow('1', false, cfg)).toBe(true);
            expect(WorldActivityService.allow('1', false, cfg)).toBe(false);
        });

        test('重要动态穿透按人冷却', () => {
            expect(WorldActivityService.allow('1', false, cfg)).toBe(true);
            expect(WorldActivityService.allow('1', true, cfg)).toBe(true);
        });

        test('不同人互不影响', () => {
            expect(WorldActivityService.allow('1', false, cfg)).toBe(true);
            expect(WorldActivityService.allow('2', false, cfg)).toBe(true);
        });
    });

    describe('fromPlayerUpdate', () => {
        test('白名单外的 updateType 不发', async () => {
            const published = jest.spyOn(WorldActivityService, 'publish').mockResolvedValue(true);
            await WorldActivityService.fromPlayerUpdate(9, 'gm_give_item', {});
            expect(published).not.toHaveBeenCalled();
            published.mockRestore();
        });

        test('白名单内且文案完整时走 publish', async () => {
            const published = jest.spyOn(WorldActivityService, 'publish').mockResolvedValue(true);
            await WorldActivityService.fromPlayerUpdate(9, 'player_breakthrough_success', {
                new_realm: '筑基期'
            });
            expect(published).toHaveBeenCalledWith(expect.objectContaining({
                playerId: 9,
                content: '突破成功，踏入筑基期！',
                type: 'breakthrough',
                isImportant: true
            }));
            published.mockRestore();
        });
    });
});
