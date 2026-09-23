/**
 * 境界有效 rank 解析（realm 名 vs realm_rank 字段）不连库、不起服务）
 *
 * 钉的是用户报告的穿戴 bug：
 *   界面按 player.realm 显示「炼虚初期」（配置 rank=27），
 *   穿戴却只读过期的 player.realm_rank=23，误报
 *   「境界不足，穿戴 大五行幻世轮 需要境界排名 27，当前 23」。
 *
 * 同时保留 B45 反向场景：realm 被误写成「凡人」、字段仍是 23 时不得降权。
 */
'use strict';

const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const RealmService = require('../game/core/RealmService');

describe('RealmService.getPlayerRank / meetsRealmRequirement', () => {
    beforeAll(async () => {
        if (typeof configLoader.initialize === 'function') {
            await configLoader.initialize();
        }
    });

    test('配置口径：炼虚初期 rank=27，化神初期 rank=23（与 REALM_ORDER 对齐）', () => {
        expect(RealmService.getRealmRank('炼虚初期')).toBe(27);
        expect(RealmService.getRealmRank('化神初期')).toBe(23);
    });

    test('名称新、字段旧：界面炼虚初期 + realm_rank=23 → 有效 rank 27（用户报告的穿戴场景）', () => {
        const player = { realm: '炼虚初期', realm_rank: 23 };
        expect(RealmService.getPlayerRank(player)).toBe(27);

        // 大五行幻世轮 required_realm_rank=27（=炼虚初期），不应被过期字段拦下
        const check = RealmService.meetsRealmRequirement(player, '炼虚初期');
        expect(check.met).toBe(true);
        expect(check.playerRank).toBe(27);
        expect(check.requiredRank).toBe(27);
    });

    test('字段新、名称旧：realm=凡人 + realm_rank=23 → 有效 rank 23（B45 不得降权）', () => {
        const player = { realm: '凡人', realm_rank: 23 };
        expect(RealmService.getPlayerRank(player)).toBe(23);
        expect(RealmService.meetsRealmRequirement(player, '筑基期').met).toBe(true);
    });

    test('两侧一致时取该值', () => {
        const player = { realm: '化神初期', realm_rank: 23 };
        expect(RealmService.getPlayerRank(player)).toBe(23);
        expect(RealmService.meetsRealmRequirement(player, '筑基期').met).toBe(true);
        expect(RealmService.meetsRealmRequirement(player, '炼虚初期').met).toBe(false);
    });

    test('字段缺失时按境界名解析', () => {
        expect(RealmService.getPlayerRank({ realm: '炼虚初期' })).toBe(27);
        expect(RealmService.getPlayerRank('化神初期')).toBe(23);
    });

    test('真正低境界仍会被拦下', () => {
        const player = { realm: '凡人', realm_rank: 1 };
        expect(RealmService.getPlayerRank(player)).toBe(1);
        expect(RealmService.meetsRealmRequirement(player, '筑基期').met).toBe(false);
    });
});
