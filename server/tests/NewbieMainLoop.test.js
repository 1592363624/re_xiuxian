/**
 * 主循环新手线契约（spec docs/compose/spec/newbie-main-loop.md）
 * 不连库：钉住修为进度模型与静思基础收益，防止回退到「连破 / 0 修为打坐无收益」。
 */
'use strict';

jest.mock('../game/services/zhiguiHooks', () => () => {});

const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const ExperienceService = require('../game/core/ExperienceService');
const MeditationService = require('../game/services/MeditationService');
const RealmService = require('../game/core/RealmService');

describe('newbie main loop contracts', () => {
    beforeAll(async () => {
        if (typeof configLoader.initialize === 'function') {
            await configLoader.initialize();
        }
        ExperienceService.initialize(configLoader);
    });

    test('getNextRealmExpCap 读下一境界 exp_cap，不用 1000*rank³ 公式', () => {
        const realms = configLoader.getConfig('realm_breakthrough').realms;
        const mortal = realms.find(r => r.name === '凡人');
        const qi1 = realms.find(r => r.rank === (mortal.rank + 1));
        const cap = ExperienceService.getNextRealmExpCap({ realm: '凡人' });
        expect(Number(cap)).toBe(Number(qi1.exp_cap));
        // 公式兜底会给出 1000*1³=1000；凡人下一档在配置里是小数值
        expect(Number(cap)).toBeLessThan(1000);
    });

    test('已是最高境界时下一档上限为 0', () => {
        const realms = configLoader.getConfig('realm_breakthrough').realms;
        const top = realms.reduce((a, b) => ((a.rank ?? 0) > (b.rank ?? 0) ? a : b));
        expect(Number(ExperienceService.getNextRealmExpCap({ realm: top.name }))).toBe(0);
    });

    test('canBreakthrough：修为达到本境界 exp_cap 才可突破（阶段内进度）', () => {
        const realms = configLoader.getConfig('realm_breakthrough').realms;
        const mortal = realms.find(r => r.name === '凡人');
        const cap = Number(mortal.exp_cap);
        expect(ExperienceService.canBreakthrough({ realm: '凡人', exp: cap - 1 }).canBreak).toBe(false);
        expect(ExperienceService.canBreakthrough({ realm: '凡人', exp: cap }).canBreak).toBe(true);
    });

    test('凡人可进入 requiredRealm=凡人 的地图（rank 0 合法，不得当未配置）', () => {
        expect(RealmService.meetsRealmRequirement('凡人', '凡人').met).toBe(true);
        expect(RealmService.meetsRealmRequirement({ realm: '凡人', realm_rank: 0 }, '凡人').met).toBe(true);
        expect(RealmService.meetsRealmRequirement({ realm: '凡人' }, '凡人').met).toBe(true);
        // 真正未知的名字仍应拦下
        expect(RealmService.meetsRealmRequirement('不存在的境界', '凡人').met).toBe(false);
    });

    test('突破路由源码：成功路径必须清零 exp（与 RealmService.breakthrough 同一口径）', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../routes/breakthrough.js'),
            'utf8'
        );
        expect(src).toMatch(/player\.exp\s*=\s*0n/);
        expect(src).toMatch(/clearPendingBreakthroughBonus/);
    });

    test('RealmService.breakthrough 成功路径仍清零 exp', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../game/core/RealmService.js'),
            'utf8'
        );
        expect(src).toMatch(/player\.exp\s*=\s*0n/);
    });

    test('静思结算：0 修为也按 base_exp_per_minute 得基础修为', async () => {
        const cfg = {
            duration_types: {
                short: { duration: 60, insight_base: 5, insight_random: 0, exp_reward_rate: 0.01 }
            },
            base_exp_per_minute: 2,
            max_exp_reward_per_session: 100000,
            bottleneck_enabled: false
        };
        const locked = {
            exp: 0n,
            meditation_mode: 'normal',
            meditation_duration: 60,
            meditation_start_time: new Date(Date.now() - 60 * 1000),
            meditation_insight: 0,
            bottleneck_state: 'none',
            is_meditating: true
        };
        locked.save = async () => {};
        const PlayerStateStore = require('../game/persistence/PlayerStateStore');
        const bump = jest.spyOn(PlayerStateStore, 'bumpStat').mockResolvedValue(undefined);

        const result = await MeditationService._settleMeditation(locked, cfg, {});
        // 1 分钟 × 2 点 + 0×rate = 2（不再乘 completion_ratio）
        expect(result.exp_gain).toBeGreaterThanOrEqual(2);
        expect(Number(locked.exp)).toBe(result.exp_gain);
        bump.mockRestore();
    });

    test('静思中断 50% 时长：基础修为按实际时长线性，不得平方衰减', async () => {
        const cfg = {
            duration_types: {
                short: { duration: 60, insight_base: 5, insight_random: 0, exp_reward_rate: 0.01 }
            },
            base_exp_per_minute: 2,
            max_exp_reward_per_session: 100000,
            bottleneck_enabled: false
        };
        const locked = {
            exp: 0n,
            meditation_mode: 'normal',
            meditation_duration: 60,
            meditation_start_time: new Date(Date.now() - 30 * 1000),
            meditation_insight: 0,
            bottleneck_state: 'none',
            is_meditating: true
        };
        locked.save = async () => {};
        const PlayerStateStore = require('../game/persistence/PlayerStateStore');
        const bump = jest.spyOn(PlayerStateStore, 'bumpStat').mockResolvedValue(undefined);

        const result = await MeditationService._settleMeditation(locked, cfg, {});
        // 30s → 0.5 分钟 × 2 = 1；错误写法（×completion 0.5）会得 0
        expect(result.exp_gain).toBeGreaterThanOrEqual(1);
        bump.mockRestore();
    });

    test('静思配置带 base_exp_per_minute（设计约 2 点/分钟）', () => {
        const cfg = configLoader.getConfig('game_balance')?.meditation;
        expect(Number(cfg?.base_exp_per_minute)).toBe(2);
    });
});
