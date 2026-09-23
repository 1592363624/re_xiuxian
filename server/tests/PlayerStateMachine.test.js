/**
 * 玩家状态机拦截文案测试（不连库）
 *
 * 重点：canStart 被拒时，reason 必须带上「还剩多久」——
 * 玩家只看到「静思悟道中，无法开始此操作」却不知道等多久，只能反复点。
 */
'use strict';

jest.mock('../config/database', () => ({}));
jest.mock('../models/player', () => ({ findByPk: jest.fn() }));

const StateRegistry = require('../game/state/StateRegistry');
const PlayerStateMachine = require('../game/state/PlayerStateMachine');

describe('canStart 拦截文案带剩余时间', () => {
    beforeEach(() => {
        // 清掉注册表里可能残留的测试 handler
        for (const { stateType } of StateRegistry.list()) {
            if (stateType.startsWith('test_')) {
                try { StateRegistry.unregister?.(stateType); } catch { /* 某些版本无 unregister */ }
            }
        }
    });

    test('getSnapshot 返回 remaining_seconds 时，reason 附带还剩多久', async () => {
        StateRegistry.register('test_meditation', {
            metadata: { displayName: '静思悟道', stateEnum: 'MEDITATING', exclusive: true },
            async getActiveState() { return 'MEDITATING'; },
            async getSnapshot() {
                return { is_meditating: true, remaining_seconds: 45 };
            },
            async cleanExpired() { return { scanned: 0, settled: 0, failed: 0 }; }
        });

        const check = await PlayerStateMachine.canStart(1, 'SECLUDED');
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('静思悟道');
        expect(check.reason).toContain('还剩 45秒');
    });

    test('剩余分钟级时长格式化为「N分钟」', async () => {
        StateRegistry.register('test_seclusion', {
            metadata: { displayName: '闭关', stateEnum: 'SECLUDED', exclusive: true },
            async getActiveState() { return 'SECLUDED'; },
            async getSnapshot() {
                return { is_secluded: true, remaining_seconds: 300 };
            },
            async cleanExpired() { return { scanned: 0, settled: 0, failed: 0 }; }
        });

        const check = await PlayerStateMachine.canStart(1, 'MEDITATING');
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('还剩 5分钟');
    });

    test('无 remaining_seconds 时保持原拦截文案（不硬拼 0 秒）', async () => {
        StateRegistry.register('test_pvp', {
            metadata: { displayName: '斗法', stateEnum: 'IN_PVP_BATTLE', exclusive: true },
            async getActiveState() { return 'IN_PVP_BATTLE'; },
            async getSnapshot() {
                return { /* 战斗无固定剩余 */ };
            },
            async cleanExpired() { return { scanned: 0, settled: 0, failed: 0 }; }
        });

        const check = await PlayerStateMachine.canStart(1, 'SECLUDED');
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('斗法');
        expect(check.reason).not.toContain('还剩');
    });

    test('自定义 canTransitionTo 的 reason 同样会被补上剩余时间', async () => {
        StateRegistry.register('test_custom', {
            metadata: { displayName: '妖兽入侵斩妖', stateEnum: 'IN_BEAST_INVASION', exclusive: true },
            async getActiveState() { return 'IN_BEAST_INVASION'; },
            async getSnapshot() {
                return { remaining_seconds: 90 };
            },
            async cleanExpired() { return { scanned: 0, settled: 0, failed: 0 }; },
            canTransitionTo() {
                return { allowed: false, reason: '正在妖兽入侵斩妖中，无法开始此操作（请先撤退）' };
            }
        });

        const check = await PlayerStateMachine.canStart(1, 'SECLUDED');
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('请先撤退');
        expect(check.reason).toContain('还剩 1分钟');
    });
});
