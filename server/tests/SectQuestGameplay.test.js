/**
 * 宗门日常任务：玩法类型结算的纯逻辑钉子
 *
 * 覆盖四件事（对应「不要等时间到了就白拿贡献+修为」那次重做）：
 *   1. 任务不再带 free exp_reward，修为只可能来自试炼大成 / 巡守机缘
 *   2. 上交类要扣物资，劳作类要扣灵力 —— 代价是配置驱动的，不是换个名字
 *   3. 巡守按权重掷事件；试炼按概率掷大成/小成/勉强/失败
 *   4. 配置写错 type 时退回 labor_mp，不至于整条变成白拿
 *
 * 这些方法刻意做成不连库的纯函数，测试不需要 MySQL。
 */
'use strict';

const SectService = require('../game/services/SectService');

describe('宗门任务玩法类型与结算', () => {
    const baseQuest = {
        id: 'q_test',
        name: '测试任务',
        contribution: 40,
        daily: true
    };

    test('四类玩法都被识别，未知 type 退回 labor_mp', () => {
        expect(SectService._questType({ type: 'labor_mp' })).toBe('labor_mp');
        expect(SectService._questType({ type: 'submit_items' })).toBe('submit_items');
        expect(SectService._questType({ type: 'patrol' })).toBe('patrol');
        expect(SectService._questType({ type: 'trial' })).toBe('trial');
        expect(SectService._questType({ type: '白拿' })).toBe('labor_mp');
        expect(SectService._questType({})).toBe('labor_mp');
    });

    test('耗时优先任务自带 duration_minutes，缺省退回全局 5 分钟', () => {
        expect(SectService._questDurationMinutes({ duration_minutes: 12 })).toBe(12);
        expect(SectService._questDurationMinutes({})).toBe(5);
    });

    test('代价摘要把灵力/气血/灵石/上交物资都列出来', () => {
        const quest = {
            cost: {
                mp: 40,
                hp: 15,
                spirit_stones: 80,
                items: [{ item_key: 'spirit_herb', quantity: 3 }]
            }
        };
        const parts = SectService._costSummary(quest);
        expect(parts).toEqual(expect.arrayContaining([
            '灵力 -40',
            '气血 -15',
            '灵石 -80',
            expect.stringContaining('spirit_herb')
        ]));
    });

    test('巡守按权重抽出事件；trigger_chance=0 时平安交差', () => {
        const quest = {
            events: {
                trigger_chance: 0,
                pool: [{ id: 'x', name: 'X', weight: 1, kind: 'combat' }]
            }
        };
        expect(SectService._rollPatrolEvent(quest)).toBeNull();

        const always = {
            events: {
                trigger_chance: 1,
                pool: [{ id: 'only', name: '唯一', weight: 10, kind: 'combat', contribution_bonus: 5 }]
            }
        };
        const hit = SectService._rollPatrolEvent(always);
        expect(hit && hit.id).toBe('only');
    });

    test('试炼结果落在四种档次之一，概率边界可复现', () => {
        // 构造全概率配置：great=1 → 必大成
        const alwaysGreat = {
            trial: {
                great_success_chance: 1,
                success_chance: 0,
                partial_chance: 0,
                great_success: { contribution_mult: 1.5, exp: 60, label: '大成' }
            }
        };
        const r1 = SectService._rollTrialOutcome(alwaysGreat);
        expect(r1.id).toBe('great_success');
        expect(r1.config.contribution_mult).toBe(1.5);

        // great=0 success=0 partial=0 → 必失败
        const alwaysFail = {
            trial: {
                great_success_chance: 0,
                success_chance: 0,
                partial_chance: 0,
                fail: { contribution_mult: 0, hp_loss: 20, label: '失败' }
            }
        };
        const r2 = SectService._rollTrialOutcome(alwaysFail);
        expect(r2.id).toBe('fail');
        expect(r2.config.hp_loss).toBe(20);
    });

    test('sect_data 里每条任务都有 type 与代价，且不再写 exp_reward', () => {
        const data = require('../config/sect_data.json');
        const types = new Set();
        for (const sect of data.sects) {
            expect(sect.quests.length).toBeGreaterThanOrEqual(8);
            for (const q of sect.quests) {
                expect(q.type).toBeTruthy();
                types.add(q.type);
                const cost = q.cost || {};
                const hasCost = (cost.mp > 0) || (cost.hp > 0) || (cost.spirit_stones > 0)
                    || ((cost.items || []).length > 0);
                expect(hasCost).toBe(true);
                expect(q.exp_reward).toBeUndefined();
                expect(q.contribution).toBeGreaterThan(0);
            }
        }
        expect(types.has('labor_mp')).toBe(true);
        expect(types.has('submit_items')).toBe(true);
        expect(types.has('patrol')).toBe(true);
        expect(types.has('trial')).toBe(true);
    });

    test('每日轮值从池子抽固定件数，且保证类型多样与入门差事', () => {
        const data = require('../config/sect_data.json');
        for (const sect of data.sects) {
            const pool = sect.quests;
            const slate = SectService._pickDailySlate(pool, sect.id, new Date('2026-07-03T12:00:00'));
            expect(slate.length).toBe(5);
            const again = SectService._pickDailySlate(pool, sect.id, new Date('2026-07-03T18:30:00'));
            expect(again.map(q => q.id).sort()).toEqual(slate.map(q => q.id).sort());
            const types = new Set(slate.map(q => SectService._questType(q)));
            expect(types.size).toBeGreaterThanOrEqual(3);
            const entry = slate.filter(q => (Number(q.min_contribution) || 0) <= 30);
            expect(entry.length).toBeGreaterThanOrEqual(2);
            for (const q of slate) {
                expect(pool.find(x => x.id === q.id)).toBeTruthy();
            }
            expect(pool.length).toBeGreaterThan(5);
            const next = SectService._pickDailySlate(pool, sect.id, new Date('2026-07-04T12:00:00'));
            expect(next.length).toBe(5);
        }
    });

    test('巡守/劳作事件池足够丰富，权重为正', () => {
        const data = require('../config/sect_data.json');
        let withEvents = 0;
        for (const sect of data.sects) {
            for (const q of sect.quests) {
                if (q.events?.pool?.length) {
                    withEvents += 1;
                    expect(q.events.pool.length).toBeGreaterThanOrEqual(4);
                    for (const e of q.events.pool) {
                        expect(Number(e.weight)).toBeGreaterThan(0);
                        expect(e.name).toBeTruthy();
                        expect(e.description).toBeTruthy();
                    }
                }
            }
        }
        expect(withEvents).toBeGreaterThanOrEqual(8);
    });

    test('巡守任务必须带事件池，试炼任务必须带成败配置', () => {
        const data = require('../config/sect_data.json');
        for (const sect of data.sects) {
            for (const q of sect.quests) {
                if (q.type === 'patrol') {
                    expect(q.events?.pool?.length).toBeGreaterThanOrEqual(6);
                }
                if (q.type === 'trial') {
                    expect(q.trial).toBeTruthy();
                    expect(q.trial.great_success).toBeTruthy();
                    expect(q.trial.fail).toBeTruthy();
                }
                if (q.type === 'submit_items') {
                    expect(q.cost?.items?.length).toBeGreaterThan(0);
                }
            }
        }
    });
});
