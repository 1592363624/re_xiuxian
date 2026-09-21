/**
 * 副本专属变量改成内容驱动之后的等价性门禁（2026-09-20）
 *
 * MultiDungeonService 原来有 14 处 `if (dungeonKey === '<副本>')` 分支，分散在"创建实例""队长入队""队员加入"
 * 三处，初始化 41 个专属列。加一个带自己变量的副本要改三个地方、还要记得列名与 init 键名的对应关系。
 * 现在变量清单声明在 `multi_dungeon_data.dungeons[<key>].instance_vars / .member_vars`，一处写法。
 *
 * 本套件钉三件事：
 *   1) 与改造前**逐列等值**（期望表是从被删掉的 14 处分支里抄出来的）；
 *   2) 初值仍然来自内容：改 `init_mountain_seal` 会跟着变，配置里的值优先于声明里的默认值；
 *   3) 那三个"必须留 null"的占位列不会被配置里的 init 键抢先填上 —— 虚天殿用 `init_void_soul_hp` 当最终幕
 *      主魂初值，但建实例时它必须是 null（null=还没进第六幕，0=主魂已死），这条一旦写错就是玩法坏掉。
 */
'use strict';

const MultiDungeonService = require('../game/services/MultiDungeonService');
const MultiDungeonInstance = require('../models/multiDungeonInstance');
const MultiDungeonMember = require('../models/multiDungeonMember');
const config = require('../config/multi_dungeon_data.json');

const instanceColumns = new Set(Object.keys(MultiDungeonInstance.rawAttributes));
const memberColumns = new Set(Object.keys(MultiDungeonMember.rawAttributes));

const apply = (dungeonKey, declared, target, prefix, columns) =>
    MultiDungeonService._applyDeclaredVars(
        target,
        config.dungeons[dungeonKey],
        config.dungeons[dungeonKey][declared],
        { prefix, columns, label: dungeonKey }
    );

/** 改造前 8 处分支的实际效果（值取自当轮 config 的 init_* 与代码里的 ?? 默认值） */
const EXPECTED_INSTANCE_VARS = {
    kunwu: {
        demonic_qi: 0, mountain_seal: 30, treasure_pressure: 0,
        linglong: 50, tower_shadow_hp: 1000000, seal_progress: 50
    },
    xutian: {
        path_choice: 0, formation_power: 30, treasure_pressure: 0, void_soul_hp: null
    },
    xiaoji: {
        curse_disorder: 0, ice_seal_power: 50, flame_power: 0, yinluo_banner_qi: 0
    },
    luoyun: {
        spirit_vein_power: 60, root_stability: 80, branch_vigor: 50,
        spirit_plant_aura: 30, act3_choice: null
    },
    cangkun: {
        forbidden_rift: 0, scroll_clue: 0, escape_difficulty: 30,
        escape_choice: null, cangkun_guardian_hp: null
    },
    xuese: {
        blood_qi_avg: 100, blood_fury: 0, eliminations: 0,
        survivor_count: 0, xuese_boss_hp: null
    },
    zhuimo: { avg_heart_demon: 0, avg_dao_heart: 100, demon_boss_hp: null },
    huanglong: {
        huanglong_formation_power: 0, huanglong_resonance_count: 0, huanglong_boss_hp: null
    }
};

const EXPECTED_MEMBER_VARS = {
    xuese: { blood_qi: 100, kill_score: 0, is_eliminated: 0 },
    zhuimo: { heart_demon: 0, dao_heart: 100, is_fallen: 0 },
    huanglong: {
        huanglong_eye_position: 'unassigned', huanglong_contribution_score: 0, huanglong_is_defecting: 0
    }
};

describe('副本专属变量：内容声明 == 改造前的分支', () => {
    test.each(Object.entries(EXPECTED_INSTANCE_VARS))('%s 的实例变量与改造前逐列相同', (key, expected) => {
        const target = apply(key, 'instance_vars', {}, 'init_', instanceColumns);
        expect(target).toEqual(expected);
    });

    test.each(Object.entries(EXPECTED_MEMBER_VARS))('%s 的成员变量与改造前逐列相同', (key, expected) => {
        const target = apply(key, 'member_vars', {}, 'member_init_', memberColumns);
        expect(target).toEqual(expected);
    });

    test('声明的列必须真实存在（资料片写错列名要在测试里就红，而不是被 create 静默丢掉）', () => {
        const bad = [];
        for (const [key, dungeon] of Object.entries(config.dungeons)) {
            for (const [declared, columns] of [['instance_vars', instanceColumns], ['member_vars', memberColumns]]) {
                for (const column of Object.keys(dungeon[declared] || {})) {
                    if (!columns.has(column)) bad.push(`${key}.${declared}.${column}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    test('没有专属变量的副本（燕月/端午）不写任何列', () => {
        for (const key of ['yanyue', 'duanwu']) {
            expect(apply(key, 'instance_vars', { morale: 100 }, 'init_', instanceColumns)).toEqual({ morale: 100 });
        }
    });
});

describe('副本专属变量：仍然由内容驱动', () => {
    test('配置里的 init_* 优先于声明里的默认值', () => {
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { init_mountain_seal: 99 },
            { mountain_seal: 30 },
            { prefix: 'init_', columns: instanceColumns, label: 'test' }
        );
        expect(target.mountain_seal).toBe(99);
    });

    test('from:null 的列不被同名 init 键抢先填上（虚天殿主魂 HP 必须是 null）', () => {
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { init_void_soul_hp: 1500000 },
            { void_soul_hp: { from: null, default: null } },
            { prefix: 'init_', columns: instanceColumns, label: 'test' }
        );
        expect(target).toEqual({ void_soul_hp: null });
    });

    test('from 可以指向不同名的键（黄龙山的列带 huanglong_ 前缀）', () => {
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { init_formation_power: 7 },
            { huanglong_formation_power: { from: 'init_formation_power', default: 0 } },
            { prefix: 'init_', columns: instanceColumns, label: 'test' }
        );
        expect(target.huanglong_formation_power).toBe(7);
    });

    test('配置写 true/false 落库是 1/0（这些标记列是 TINYINT）', () => {
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { member_init_is_defecting: true },
            { huanglong_is_defecting: { from: 'member_init_is_defecting', default: 0 } },
            { prefix: 'member_init_', columns: memberColumns, label: 'test' }
        );
        expect(target.huanglong_is_defecting).toBe(1);
    });

    test('不存在的列被跳过且告警，不会污染行数据', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { init_typo_col: 5 },
            { typo_col: 1 },
            { prefix: 'init_', columns: instanceColumns, label: 'test' }
        );
        expect(target).toEqual({});
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('typo_col'));
        warn.mockRestore();
    });

    test('资料片覆盖 init_* 就能改初值，不必碰服务代码', () => {
        const target = MultiDungeonService._applyDeclaredVars(
            {},
            { init_demonic_qi: 12, init_mountain_seal: 40 },
            config.dungeons.kunwu.instance_vars,
            { prefix: 'init_', columns: instanceColumns, label: 'kunwu' }
        );
        expect(target.demonic_qi).toBe(12);
        expect(target.mountain_seal).toBe(40);
        expect(target.linglong).toBe(50);
    });
});

describe('抉择变量键：短名补齐 + 无人认领时的通用兜底', () => {
    // _canonicalizeVarKeys / _varBounds 都是"读当前合并后的内容"，所以要先跑一遍模块装配
    beforeAll(async () => {
        await require('../modules').initializeModules();
    });

    test('黄龙山用短名写的键补齐成列名（两边对不上时抉择会静默不生效）', () => {
        const choice = {
            key: 'forward', text: '前锋阵眼',
            vigilance_change: -10,                 // 通用变量：原样
            formation_power_change: 8,             // 短名 → huanglong_formation_power_change
            eye_position: 'forward',               // 直接赋值型
            contribution_score_self_change: 10,    // 成员级 + _self_change 后缀
            is_defecting_self: true
        };
        const out = MultiDungeonService._canonicalizeVarKeys(choice, 'huanglong');
        expect(out.vigilance_change).toBe(-10);
        expect(out.huanglong_formation_power_change).toBe(8);
        expect(out.huanglong_eye_position).toBe('forward');
        expect(out.huanglong_contribution_score_self_change).toBe(10);
        expect(out.huanglong_is_defecting_self).toBe(true);
        // 短名必须被换掉，不能同时存在：否则黄龙山的"阵法强度"会顺手改到虚天殿那个同名字段上
        expect(out.formation_power_change).toBeUndefined();
        expect(out.eye_position).toBeUndefined();
    });

    test('变量名本来就不带副本前缀的副本（坠魔谷）原样通过', () => {
        const choice = { heart_demon_self_change: 5, dao_heart_self_change: -3, seal_stability_change: 2 };
        expect(MultiDungeonService._canonicalizeVarKeys(choice, 'zhuimo')).toEqual(choice);
    });

    test('内容新增副本变量：没人认领的 <列名>_change 也会被通用兜底累加并夹边界', () => {
        const realColumns = MultiDungeonService._instanceColumns;
        MultiDungeonService._instanceColumns = () => new Set(['demo_soul_shards']);
        try {
            const applied = {};
            const instance = { instance_key: 'demo', demo_soul_shards: 90 };
            MultiDungeonService._applyRemainingVarChanges(instance, { demo_soul_shards_change: 50 }, applied);
            expect(instance.demo_soul_shards).toBe(100);       // 默认边界 0-100
            expect(applied.demo_soul_shards).toBe(100);
        } finally {
            MultiDungeonService._instanceColumns = realColumns;
        }
    });

    test('专门分支已经认领的变量不被兜底重复累加', () => {
        const instance = { instance_key: 'yanyue', morale: 60 };
        MultiDungeonService._applyRemainingVarChanges(instance, { morale_change: 30 }, { morale: 60 });
        expect(instance.morale).toBe(60);
    });

    test('边界可以写在内容里（全局 variable_bounds 与副本 var_bounds），代码那份只是兜底', () => {
        const bounds = MultiDungeonService._varBounds('huanglong', 'huanglong_formation_power');
        expect(bounds).toEqual({ min: 0, max: 200 });          // 黄龙山阵法强度 0-200（虚天殿的同名变量是 0-100）
        expect(MultiDungeonService._varBounds('xutian', 'formation_power')).toEqual({ min: 0, max: 100 });
        expect(MultiDungeonService._varBounds('demo', 'never_heard_of_it')).toEqual({ min: 0, max: 100 });
    });
});

describe('面板变量块：一份内容清单替掉 5 份手抄本', () => {
    // 改造前 getStatus 里那份 `morale: instance.morale, …` 的键清单（逐条抄下来当基准）
    const OLD_STATUS_KEYS = ['morale', 'vigilance', 'demon_corruption', 'seal_stability', 'soul_stability',
        'harvest_multiplier', 'demonic_qi', 'mountain_seal', 'treasure_pressure', 'linglong', 'seal_progress',
        'tower_shadow_hp', 'path_choice', 'formation_power', 'void_soul_hp', 'curse_disorder', 'ice_seal_power',
        'flame_power', 'yinluo_banner_qi', 'spirit_vein_power', 'root_stability', 'branch_vigor',
        'spirit_plant_aura', 'act3_choice', 'forbidden_rift', 'scroll_clue', 'escape_difficulty', 'escape_choice',
        'cangkun_guardian_hp', 'blood_qi_avg', 'blood_fury', 'eliminations', 'survivor_count', 'xuese_boss_hp',
        'avg_heart_demon', 'avg_dao_heart', 'demon_boss_hp', 'huanglong_formation_power',
        'huanglong_resonance_count', 'huanglong_boss_hp'];

    test('_variablesOf 外发的键与改造前那份手抄本一字不差', async () => {
        await require('../modules').initializeModules();
        const fake = Object.fromEntries(OLD_STATUS_KEYS.map(key => [key, 7]));
        const out = MultiDungeonService._variablesOf(fake);
        expect(Object.keys(out).sort()).toEqual([...OLD_STATUS_KEYS].sort());
        expect(out.morale).toBe(7);
    });

    test('BIGINT 血量列沿用历史契约：0 与 null 都外发 null', async () => {
        await require('../modules').initializeModules();
        const out = MultiDungeonService._variablesOf({
            morale: 5, tower_shadow_hp: '1000000', huanglong_boss_hp: 0, void_soul_hp: null
        });
        expect(out.tower_shadow_hp).toBe('1000000');
        expect(out.huanglong_boss_hp).toBeNull();
        expect(out.void_soul_hp).toBeNull();
        expect(MultiDungeonService._isBigIntColumn('huanglong_boss_hp')).toBe(true);
        expect(MultiDungeonService._isBigIntColumn('morale')).toBe(false);
    });

    test('variable_meta 带标签与归属，客户端不再自己写死字典', async () => {
        await require('../modules').initializeModules();
        const meta = MultiDungeonService._variableMeta();
        expect(meta.huanglong_formation_power).toEqual({ dungeons: ['huanglong'], label: '阵法强度' });
        expect(meta.morale.dungeons).toBeNull();                       // 六个通用变量：所有副本可见
        expect(meta.morale.label).toBe('士气');
        expect(meta.treasure_pressure.dungeons.sort()).toEqual(['kunwu', 'xutian']);
    });
});
