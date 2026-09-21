/**
 * 功法服务单元测试
 *
 * 覆盖范围：
 *   - 配置容错：未初始化 / 配置抛异常时的降级行为
 *   - 五行匹配系数：契合加成、相冲衰减、无灵根、无属性功法
 *   - 熟练度阈值与修炼消耗的阶梯递增
 *   - 突破成功率公式：层数衰减、瓶颈层惩罚、悟性加成、上下限钳制
 *   - 神通槽位解锁与解锁层判定
 *   - 单本功法加成计算（含负值加成的符号保留）
 *   - getTechniqueBonus 聚合：主辅修折算、脏数据跳过、异常降级、系统关闭
 *   - 真实配置文件的结构与数值自洽性校验
 *
 * 测试策略：mock 掉 database / 模型 / errorHandler，只测纯逻辑，无需 MySQL。
 */

// —— Mock 数据库与模型（避免建立真实连接）——
jest.mock('../config/database', () => ({
    transaction: jest.fn()
}));

jest.mock('../models/player', () => ({ findByPk: jest.fn() }));
jest.mock('../models/realm', () => ({ findOne: jest.fn() }));
jest.mock('../models/playerSect', () => ({ findOne: jest.fn() }));
jest.mock('../models/playerTechnique', () => ({
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    count: jest.fn()
}));

const TechniqueService = require('../game/services/TechniqueService');
const PlayerTechnique = require('../models/playerTechnique');

// 真实配置文件：用于校验随代码交付的数值是否自洽
const realConfig = require('../config/technique_data.json');
const attributeSystem = require('../config/attribute_system.json');
const realRoleInit = require('../config/role_init.json');

/**
 * 玩家侧真正能拿到的灵根 type —— 全游戏只有一张灵根表：role_init.spirit_roots。
 * 功法 element、相克表的键与值、attribute_system 的镜像表都必须以它为基准，
 * 曾经 attribute_system 写 gold 而 role_init/战斗侧写 metal，相克表永远匹配不上。
 */
const VALID_ROOT_TYPES = realRoleInit.spirit_roots.map(r => r.type);

/** 合法的功法属性集合：'none' 表示无属性功法；本游戏存在 thunder/ice/wind 变异灵根，故不硬编码五行 */
const VALID_ELEMENTS = [...VALID_ROOT_TYPES, 'none'];

/**
 * 构造测试用配置加载器
 * 灵根解析走 SpiritRoot → role_init，所以必须一并投喂真实的 role_init，
 * 否则 getElementMultiplier 拿不到灵根、整块五行匹配会退化成恒 1.0。
 * @param {Object} cfg - 要返回的 technique_data 配置
 */
function buildConfigLoader(cfg) {
    return {
        getConfig: (name) => {
            if (name === 'technique_data') return cfg;
            if (name === 'role_init') return realRoleInit;
            return {};
        },
        hasConfig: (name) => name === 'technique_data' || name === 'role_init'
    };
}

/** 精简的测试专用配置，便于精确断言数值 */
const testConfig = {
    settings: {
        enabled: true,
        max_equipped_main: 1,
        max_equipped_auxiliary: 2,
        auxiliary_ratio: 0.5,
        daily_practice_limit: 20,
        practice_cooldown_seconds: 10,
        switch_main_cost_spirit_stone: 1000,
        switch_main_cooldown_hours: 24,
        proficiency_decay_on_switch_pct: 20
    },
    grades: {
        huang: { name: '黄阶', color: '#a0a0a0', max_layer: 9, attr_coefficient: 1.0, proficiency_per_layer: 100, breakthrough_base_rate: 0.85 },
        tian: { name: '天阶', color: '#ff8c00', max_layer: 12, attr_coefficient: 4.0, proficiency_per_layer: 1800, breakthrough_base_rate: 0.35 }
    },
    breakthrough: {
        layer_penalty_per_level: 0.045,
        bottleneck_layers: [3, 6, 9, 12],
        bottleneck_extra_penalty: 0.12,
        wisdom_bonus_factor: 0.002,
        min_success_rate: 0.08,
        max_success_rate: 0.95,
        failure_proficiency_loss_pct: 30,
        failure_protection_count: 3,
        spirit_stone_cost_multiplier: 5
    },
    practice: {
        base_spirit_stone_cost: 50,
        cost_growth_per_layer: 0.35,
        base_proficiency_gain: 12,
        proficiency_gain_variance: 0.25,
        comprehension_bonus_per_wisdom: 0.008,
        mp_cost_ratio: 0.15,
        exp_reward_ratio: 3
    },
    comprehension: {
        enabled: true,
        unlock_layers: [3, 6, 9],
        base_comprehend_rate: 0.4,
        wisdom_bonus_factor: 0.003,
        cooldown_hours: 12,
        spirit_stone_cost: 500
    },
    element_match: {
        match_bonus_pct: 20,
        conflict_penalty_pct: 15,
        conflicts: {
            metal: ['wood'], wood: ['earth'], earth: ['water'],
            water: ['fire'], fire: ['metal']
        }
    },
    techniques: {
        basic_qi: {
            name: '引气诀', grade: 'huang', element: 'none',
            bonuses: { hp_max: 20, mp_max: 15, atk: 3 },
            cultivate_speed_pct_per_layer: 1.0
        },
        fire_art: {
            name: '炎阳功', grade: 'huang', element: 'fire',
            bonuses: { hp_max: 30, atk: 8 },
            cultivate_speed_pct_per_layer: 1.5
        },
        blood_art: {
            name: '血魔炼形诀', grade: 'tian', element: 'none',
            bonuses: { hp_max: -40, atk: 50 },
            cultivate_speed_pct_per_layer: 2.0
        }
    },
    skills: {
        // effects 键必须落在 game/combat/skillEffects.js 的词表里（启动期会校验真实配置），
        // 属性类键会被折进 getTechniqueBonus 的数值产出
        fire_ball: { name: '烈火球', element: 'fire', effects: { extra_damage_rate: 0.3, trigger_chance: 0.5 } },
        common_shield: { name: '护体罡气', element: 'none', effects: { def_bonus_pct: 0.2 } },
        sharp_intent: { name: '锐念', element: 'none', effects: { crit_rate_bonus: 0.12, breakthrough_rate_bonus: 0.05 } }
    }
};

beforeEach(() => {
    jest.clearAllMocks();
    TechniqueService.initialize(buildConfigLoader(testConfig));
});

// ==================== 配置容错 ====================

describe('配置容错', () => {
    test('未初始化时 getConfig 返回空对象且系统判定为未启用', () => {
        TechniqueService.initialize(undefined);
        expect(TechniqueService.getConfig()).toEqual({});
        expect(TechniqueService.isEnabled()).toBe(false);
    });

    test('configLoader 抛异常时降级为空对象，不向上抛出', () => {
        TechniqueService.initialize({
            getConfig: () => { throw new Error('配置未加载'); }
        });
        expect(() => TechniqueService.getConfig()).not.toThrow();
        expect(TechniqueService.getConfig()).toEqual({});
        expect(TechniqueService.isEnabled()).toBe(false);
    });

    test('enabled 为 false 时系统判定为未启用', () => {
        TechniqueService.initialize(buildConfigLoader({
            ...testConfig,
            settings: { ...testConfig.settings, enabled: false }
        }));
        expect(TechniqueService.isEnabled()).toBe(false);
    });

    test('查询不存在的功法/品阶/神通均返回 null', () => {
        expect(TechniqueService.getTechniqueConfig('not_exist')).toBeNull();
        expect(TechniqueService.getGradeConfig('not_exist')).toBeNull();
        expect(TechniqueService.getSkillConfig('not_exist')).toBeNull();
    });
});

// ==================== 悟性取值 ====================

describe('getWisdom 悟性代理属性', () => {
    test('正常读取 attributes.sense', () => {
        expect(TechniqueService.getWisdom({ attributes: { sense: 50 } })).toBe(50);
    });

    test('attributes 缺失 / sense 缺失 / 非法值均返回 0', () => {
        expect(TechniqueService.getWisdom({})).toBe(0);
        expect(TechniqueService.getWisdom({ attributes: {} })).toBe(0);
        expect(TechniqueService.getWisdom({ attributes: { sense: 'abc' } })).toBe(0);
        expect(TechniqueService.getWisdom({ attributes: { sense: -10 } })).toBe(0);
        expect(TechniqueService.getWisdom(null)).toBe(0);
    });
});

// ==================== 五行匹配 ====================

describe('getElementMultiplier 五行匹配系数', () => {
    test('功法无属性时无修正', () => {
        const player = { spirit_roots: { fire: 80 } };
        expect(TechniqueService.getElementMultiplier(player, 'none')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier(player, null)).toBe(1.0);
    });

    test('灵根与功法同属性时获得契合加成', () => {
        const player = { spirit_roots: { fire: 80 } };
        expect(TechniqueService.getElementMultiplier(player, 'fire')).toBeCloseTo(1.2);
    });

    test('灵根克制功法属性时产生相冲衰减（水克火）', () => {
        const player = { spirit_roots: { water: 70 } };
        expect(TechniqueService.getElementMultiplier(player, 'fire')).toBeCloseTo(0.85);
    });

    test('灵根既不契合也不相克时无修正（木 vs 火）', () => {
        const player = { spirit_roots: { wood: 60 } };
        expect(TechniqueService.getElementMultiplier(player, 'fire')).toBe(1.0);
    });

    test('无灵根数据 / 灵根值为 0 时无修正', () => {
        expect(TechniqueService.getElementMultiplier({ spirit_roots: {} }, 'fire')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier({ spirit_roots: { fire: 0 } }, 'fire')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier({}, 'fire')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier(null, 'fire')).toBe(1.0);
    });

    test('多灵根时契合优先于相冲（同时拥有火与水灵根，修炼火功法）', () => {
        const player = { spirit_roots: { fire: 50, water: 50 } };
        expect(TechniqueService.getElementMultiplier(player, 'fire')).toBeCloseTo(1.2);
    });
});

// ==================== 熟练度与消耗 ====================

describe('getRequiredProficiency 熟练度阈值', () => {
    test('第1层为品阶基础值，随层数线性递增', () => {
        expect(TechniqueService.getRequiredProficiency('huang', 1)).toBe(100);
        expect(TechniqueService.getRequiredProficiency('huang', 2)).toBe(150);
        expect(TechniqueService.getRequiredProficiency('huang', 5)).toBe(300);
    });

    test('高阶功法阈值显著高于低阶（阶梯式难度）', () => {
        const huang = TechniqueService.getRequiredProficiency('huang', 1);
        const tian = TechniqueService.getRequiredProficiency('tian', 1);
        expect(tian).toBeGreaterThan(huang * 10);
    });

    test('品阶不存在时返回 Infinity（防止被绕过）', () => {
        expect(TechniqueService.getRequiredProficiency('not_exist', 1)).toBe(Infinity);
    });
});

describe('getPracticeCost 修炼消耗', () => {
    test('消耗随层数递增', () => {
        const l1 = TechniqueService.getPracticeCost('huang', 1);
        const l5 = TechniqueService.getPracticeCost('huang', 5);
        expect(l5).toBeGreaterThan(l1);
    });

    test('高阶功法消耗更高（品阶系数放大）', () => {
        expect(TechniqueService.getPracticeCost('tian', 1))
            .toBeGreaterThan(TechniqueService.getPracticeCost('huang', 1));
    });

    test('品阶不存在时按系数 1 计算，不产生 NaN', () => {
        const cost = TechniqueService.getPracticeCost('not_exist', 1);
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThanOrEqual(0);
    });
});

// ==================== 突破成功率 ====================

describe('calcBreakthroughRate 突破成功率公式', () => {
    test('第1层非瓶颈：基础率 - 层惩罚 + 悟性加成', () => {
        // 0.85 - 1*0.045 + 0 = 0.805
        expect(TechniqueService.calcBreakthroughRate('huang', 1, 0)).toBeCloseTo(0.805);
    });

    test('成功率随层数递减（纵向瓶颈）', () => {
        const l1 = TechniqueService.calcBreakthroughRate('huang', 1, 0);
        const l5 = TechniqueService.calcBreakthroughRate('huang', 5, 0);
        expect(l5).toBeLessThan(l1);
    });

    test('目标层为瓶颈层时追加惩罚', () => {
        // layer=2 → 目标层 3，属瓶颈层
        const toBottleneck = TechniqueService.calcBreakthroughRate('huang', 2, 0);
        // 0.85 - 0.09 - 0.12 = 0.64
        expect(toBottleneck).toBeCloseTo(0.64);
        // 对比非瓶颈的 layer=1
        expect(toBottleneck).toBeLessThan(TechniqueService.calcBreakthroughRate('huang', 1, 0));
    });

    test('悟性提升成功率', () => {
        const low = TechniqueService.calcBreakthroughRate('huang', 5, 0);
        const high = TechniqueService.calcBreakthroughRate('huang', 5, 100);
        expect(high).toBeGreaterThan(low);
        expect(high - low).toBeCloseTo(0.2); // 100 * 0.002
    });

    test('高阶功法成功率显著低于低阶（横向难度）', () => {
        expect(TechniqueService.calcBreakthroughRate('tian', 1, 0))
            .toBeLessThan(TechniqueService.calcBreakthroughRate('huang', 1, 0));
    });

    test('极高层数被下限钳制，不会出现负概率', () => {
        const rate = TechniqueService.calcBreakthroughRate('tian', 999, 0);
        expect(rate).toBe(0.08);
        expect(rate).toBeGreaterThan(0);
    });

    test('极高悟性被上限钳制，不会必定成功', () => {
        const rate = TechniqueService.calcBreakthroughRate('huang', 1, 999999);
        expect(rate).toBe(0.95);
        expect(rate).toBeLessThan(1);
    });

    test('品阶不存在时使用兜底基础率，不产生 NaN', () => {
        const rate = TechniqueService.calcBreakthroughRate('not_exist', 1, 0);
        expect(Number.isNaN(rate)).toBe(false);
        expect(rate).toBeGreaterThanOrEqual(0.08);
        expect(rate).toBeLessThanOrEqual(0.95);
    });
});

// ==================== 神通槽位 ====================

describe('神通槽位解锁', () => {
    test('按解锁层递增槽位数量', () => {
        expect(TechniqueService._getSkillSlots(1)).toBe(0);
        expect(TechniqueService._getSkillSlots(3)).toBe(1);
        expect(TechniqueService._getSkillSlots(6)).toBe(2);
        expect(TechniqueService._getSkillSlots(9)).toBe(3);
        expect(TechniqueService._getSkillSlots(12)).toBe(3); // 超出最大解锁层不再增加
    });

    test('正确识别解锁层', () => {
        expect(TechniqueService._isComprehendUnlockLayer(3)).toBe(true);
        expect(TechniqueService._isComprehendUnlockLayer(4)).toBe(false);
    });
});

// ==================== 单本功法加成 ====================

describe('_calcSingleBonus 单本功法加成', () => {
    test('加成 = 每层值 × 层数 × 品阶系数 × 五行系数', () => {
        const player = { spirit_roots: {} };
        const cfg = testConfig.techniques.basic_qi;
        const bonus = TechniqueService._calcSingleBonus(player, cfg, 3);
        // hp_max: 20 * 3 * 1.0 * 1.0 = 60
        expect(bonus.hp_max).toBe(60);
        expect(bonus.atk).toBe(9);
    });

    test('五行契合放大加成', () => {
        const player = { spirit_roots: { fire: 80 } };
        const cfg = testConfig.techniques.fire_art;
        const bonus = TechniqueService._calcSingleBonus(player, cfg, 1);
        // atk: 8 * 1 * 1.0 * 1.2 = 9.6 → round → 10
        expect(bonus.atk).toBe(10);
    });

    test('负值加成保留符号（魔功反噬），不因取整放大惩罚', () => {
        const player = { spirit_roots: {} };
        const cfg = testConfig.techniques.blood_art;
        const bonus = TechniqueService._calcSingleBonus(player, cfg, 1);
        // hp_max: -40 * 1 * 4.0 = -160
        expect(bonus.hp_max).toBe(-160);
        expect(bonus.atk).toBe(200);
    });
});

// ==================== 加成聚合 ====================

describe('getTechniqueBonus 属性加成聚合', () => {
    const player = { id: 1, spirit_roots: {}, attributes: { sense: 10 } };

    test('系统未启用时返回全零加成', async () => {
        TechniqueService.initialize(buildConfigLoader({
            ...testConfig,
            settings: { ...testConfig.settings, enabled: false }
        }));
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        expect(bonus).toEqual({
            hp_max: 0, mp_max: 0, atk: 0, def: 0, speed: 0,
            cultivate_speed_pct: 0, skills: []
        });
        expect(PlayerTechnique.findAll).not.toHaveBeenCalled();
    });

    test('未装备任何功法时返回全零加成', async () => {
        PlayerTechnique.findAll.mockResolvedValue([]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        expect(bonus.hp_max).toBe(0);
        expect(bonus.skills).toEqual([]);
    });

    test('主修功法提供全额加成', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'basic_qi', layer: 2, equip_slot: 'main', comprehended_skills: [] }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // hp_max: 20 * 2 * 1.0 = 40
        expect(bonus.hp_max).toBe(40);
        // cultivate_speed_pct: 1.0 * 2 * 1.0 * 1 = 2
        expect(bonus.cultivate_speed_pct).toBeCloseTo(2);
    });

    test('辅修功法按 auxiliary_ratio 折算', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'basic_qi', layer: 2, equip_slot: 'auxiliary', comprehended_skills: [] }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // 40 * 0.5 = 20
        expect(bonus.hp_max).toBe(20);
        expect(bonus.cultivate_speed_pct).toBeCloseTo(1);
    });

    test('主修与辅修加成正确累加', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'basic_qi', layer: 2, equip_slot: 'main', comprehended_skills: [] },
            { technique_id: 'fire_art', layer: 2, equip_slot: 'auxiliary', comprehended_skills: [] }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // 主修 basic_qi hp_max 40 + 辅修 fire_art (30*2*1.0)=60 * 0.5 = 30 → 共 70
        expect(bonus.hp_max).toBe(70);
    });

    test('配置已删除的脏数据被跳过，不影响其余功法', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'removed_technique', layer: 5, equip_slot: 'main', comprehended_skills: [] },
            { technique_id: 'basic_qi', layer: 1, equip_slot: 'auxiliary', comprehended_skills: [] }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // 只有 basic_qi 生效：20 * 1 * 1.0 * 0.5 = 10
        expect(bonus.hp_max).toBe(10);
    });

    test('汇总已领悟神通并标注来源', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            {
                technique_id: 'fire_art', layer: 3, equip_slot: 'main',
                comprehended_skills: ['fire_ball', 'not_exist_skill']
            }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // 不存在的神通被过滤
        expect(bonus.skills).toHaveLength(1);
        expect(bonus.skills[0]).toMatchObject({
            id: 'fire_ball', name: '烈火球', from: '炎阳功'
        });
    });

    test('神通的属性类特效折进功法加成（面板/战力/战斗/突破一次全有）', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            {
                technique_id: 'fire_art', layer: 1, equip_slot: 'main',
                comprehended_skills: ['sharp_intent']
            }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        // effects 里写 0.12（小数），面板口径是百分点
        expect(bonus.crit_rate).toBeCloseTo(12);
        expect(bonus.breakthrough_bonus).toBeCloseTo(5);
        // 神通仍然原样透出，供战斗侧读战斗特效
        expect(bonus.skills[0].effects).toMatchObject({ crit_rate_bonus: 0.12 });
    });

    test('现网每一门神通的 effects 键都在特效词表内（拼错不会再来一次静默失效）', () => {
        const { isKnownSkillEffectKey } = require('../game/combat/skillEffects');
        const realSkills = require('../config/technique_data.json').skills;
        const offenders = [];
        for (const [id, cfg] of Object.entries(realSkills)) {
            if (id.startsWith('_') || !cfg || typeof cfg !== 'object') continue;
            for (const key of Object.keys(cfg.effects || {})) {
                if (!isKnownSkillEffectKey(key)) offenders.push(`${id}.${key}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('comprehended_skills 为 null 时不报错', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'basic_qi', layer: 1, equip_slot: 'main', comprehended_skills: null }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        expect(bonus.skills).toEqual([]);
    });

    test('数据库异常时降级为全零加成而非抛出（保护属性计算主链路）', async () => {
        PlayerTechnique.findAll.mockRejectedValue(new Error('DB connection lost'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        expect(bonus.hp_max).toBe(0);
        expect(bonus.skills).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
    });

    test('负值加成正确参与聚合（魔功主修）', async () => {
        PlayerTechnique.findAll.mockResolvedValue([
            { technique_id: 'blood_art', layer: 1, equip_slot: 'main', comprehended_skills: [] }
        ]);
        const bonus = await TechniqueService.getTechniqueBonus(1, player);
        expect(bonus.hp_max).toBe(-160);
        expect(bonus.atk).toBe(200);
    });
});

// ==================== 真实配置自洽性 ====================

describe('technique_data.json 真实配置校验', () => {
    beforeEach(() => {
        TechniqueService.initialize(buildConfigLoader(realConfig));
    });

    test('必需的顶层节点齐全', () => {
        for (const key of ['settings', 'grades', 'breakthrough', 'practice', 'comprehension', 'element_match', 'techniques', 'skills']) {
            expect(realConfig[key]).toBeDefined();
        }
    });

    test('每本功法引用的品阶都真实存在', () => {
        for (const [id, cfg] of Object.entries(realConfig.techniques)) {
            if (id.startsWith('_')) continue;
            expect(realConfig.grades[cfg.grade]).toBeDefined();
        }
    });

    test('品阶系数随品阶递增、突破基础率递减（阶梯式难度曲线）', () => {
        const order = ['huang', 'xuan', 'di', 'tian', 'shen'];
        const grades = order.filter(g => realConfig.grades[g]);
        for (let i = 1; i < grades.length; i++) {
            const prev = realConfig.grades[grades[i - 1]];
            const cur = realConfig.grades[grades[i]];
            // 高阶收益更高
            expect(cur.attr_coefficient).toBeGreaterThan(prev.attr_coefficient);
            // 高阶更难突破
            expect(cur.breakthrough_base_rate).toBeLessThan(prev.breakthrough_base_rate);
            // 高阶所需熟练度更多
            expect(cur.proficiency_per_layer).toBeGreaterThan(prev.proficiency_per_layer);
        }
    });

    test('所有品阶在第1层的突破率均在合法区间内', () => {
        for (const grade of Object.keys(realConfig.grades)) {
            if (grade.startsWith('_')) continue;
            const rate = TechniqueService.calcBreakthroughRate(grade, 1, 0);
            expect(rate).toBeGreaterThanOrEqual(realConfig.breakthrough.min_success_rate);
            expect(rate).toBeLessThanOrEqual(realConfig.breakthrough.max_success_rate);
        }
    });

    test('各品阶在满层时突破率仍为正（不会出现无法完成的死局）', () => {
        for (const [grade, cfg] of Object.entries(realConfig.grades)) {
            if (grade.startsWith('_')) continue;
            const rate = TechniqueService.calcBreakthroughRate(grade, cfg.max_layer - 1, 0);
            expect(rate).toBeGreaterThan(0);
        }
    });

    test('神通引用的属性均为真实存在的灵根（防止属性拼写脱节导致永不匹配）', () => {
        for (const [id, skill] of Object.entries(realConfig.skills)) {
            if (id.startsWith('_')) continue;
            expect(VALID_ELEMENTS).toContain(skill.element);
        }
    });

    test('相克表的键与值都是真实灵根名（否则那条克制永远不会触发）', () => {
        const conflicts = (realConfig.element_match || {}).conflicts || {};
        // 键 = 玩家可能拥有的灵根 type；值 = 功法可能拥有的属性。
        // 值允许指向"现网还没有功法在用"的属性（例如 metal）：那是给后续内容预留的，
        // 但绝不允许拼错——一旦拼成 gold 这类不存在的键，整条克制就是死配置。
        expect(Object.keys(conflicts).filter(k => !k.startsWith('_') && !VALID_ROOT_TYPES.includes(k))).toEqual([]);
        const badValues = Object.entries(conflicts)
            .filter(([root]) => !root.startsWith('_'))
            .flatMap(([root, list]) => list.filter(e => !VALID_ROOT_TYPES.includes(e)).map(e => `${root}→${e}`));
        expect(badValues).toEqual([]);
    });

    test('灵根词表只有一张权威表，镜像表不得自造拼写', () => {
        // 权威表：role_init.spirit_roots[].type —— SpiritRoot 解析、战斗五行、功法契合都读它
        expect(VALID_ROOT_TYPES).toContain('metal');
        expect(VALID_ROOT_TYPES).not.toContain('gold');
        // attribute_system 里那份 spirit_root_bonus 是同一张表的镜像（当前无代码读取），
        // 允许它落后于权威表，但不能出现权威表里没有的拼写——那才是这次 bug 的成因。
        const mirror = Object.keys(attributeSystem.attribute_bonuses.spirit_root_bonus);
        expect(mirror.filter(k => !VALID_ROOT_TYPES.includes(k))).toEqual([]);
    });

    test('功法引用的属性均为真实存在的灵根', () => {
        for (const [id, cfg] of Object.entries(realConfig.techniques)) {
            if (id.startsWith('_')) continue;
            expect(VALID_ELEMENTS).toContain(cfg.element);
        }
    });

    test('相克表中的灵根键名均真实存在（金为 metal，不是 gold）', () => {
        for (const root of Object.keys(realConfig.element_match.conflicts)) {
            if (root.startsWith('_')) continue;
            expect(VALID_ELEMENTS).toContain(root);
        }
    });

    test('相克表中被克制的属性也均真实存在', () => {
        for (const [root, targets] of Object.entries(realConfig.element_match.conflicts)) {
            if (root.startsWith('_')) continue;
            for (const target of targets) {
                expect(VALID_ELEMENTS).toContain(target);
            }
        }
    });

    test('每本功法都能找到至少一个可领悟的神通（避免槽位无内容可填）', () => {
        for (const [id, cfg] of Object.entries(realConfig.techniques)) {
            if (id.startsWith('_')) continue;
            const candidates = Object.entries(realConfig.skills).filter(([sid, s]) =>
                !sid.startsWith('_') && (s.element === cfg.element || s.element === 'none')
            );
            expect(candidates.length).toBeGreaterThan(0);
        }
    });

    test('五行相克表构成完整循环（金木水火土各克至少一个）', () => {
        const conflicts = realConfig.element_match.conflicts;
        for (const el of ['metal', 'wood', 'water', 'fire', 'earth']) {
            expect(Array.isArray(conflicts[el])).toBe(true);
            expect(conflicts[el].length).toBeGreaterThan(0);
        }
    });

    test('辅修折算比例在合理区间（0,1)，保证主修核心地位', () => {
        const ratio = realConfig.settings.auxiliary_ratio;
        expect(ratio).toBeGreaterThan(0);
        expect(ratio).toBeLessThan(1);
    });
});

/**
 * 灵根 × 功法五行匹配系数。
 * 这条机制曾经恒返回 1.0：实现按 { gold: 0.2 } 这种"权重表"形状读 spirit_roots，
 * 而真实数据是 { type: 'thunder' } 或 { '金灵根': { level, affinity } }，
 * Number(...) > 0 全为 false，rootKeys 恒空。下面这些用例就是为了让它不能再悄悄躺平。
 */
describe('getElementMultiplier（灵根契合/相克真的生效）', () => {
    const realTechnique = realConfig;

    // beforeEach 而非 beforeAll：文件顶层的 beforeEach 会给每个用例重置成 testConfig，
    // 放在 beforeAll 会被它覆盖掉，真实配置根本没机会生效。
    beforeEach(() => {
        TechniqueService.initialize(buildConfigLoader(realTechnique));
    });

    const playerWith = (spiritRoots) => ({ id: 1, realm: '炼气3层', spirit_roots: spiritRoots, attributes: {} });
    const matchPct = 1 + (realTechnique.element_match.match_bonus_pct || 0) / 100;
    const penaltyPct = 1 - (realTechnique.element_match.conflict_penalty_pct || 0) / 100;

    test('老形状 { type } 能匹配：火灵根修火系功法拿契合加成', () => {
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'fire' }), 'fire')).toBe(matchPct);
    });

    test('老形状能相克：火克金、雷克木都按表衰减', () => {
        // 现网还没有 metal 系功法，但相克表按五行循环预留了火克金——
        // 一旦后续内容（或 DLC）加一本金系功法，这条克制要立刻生效，不需要改代码。
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'fire' }), 'metal')).toBe(penaltyPct);
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'thunder' }), 'wood')).toBe(penaltyPct);
        // 反向不成立：金灵根修火系功法不会被"火克金"惩罚，表是有方向的
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'metal' }), 'fire')).toBe(1.0);
    });

    test('新建角色形状 { "金灵根": {...} } 同样生效', () => {
        expect(TechniqueService.getElementMultiplier(playerWith({ '火灵根': { level: '基础', affinity: 90 } }), 'fire'))
            .toBe(matchPct);
    });

    test('无属性功法与无灵根玩家都是 1.0（不打折也不误伤）', () => {
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'fire' }), 'none')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier(playerWith({}), 'fire')).toBe(1.0);
        expect(TechniqueService.getElementMultiplier(playerWith({ type: 'chaos' }), 'fire')).toBe(1.0);
    });

    test('至少存在一条会真正触发的相克（防止相克表整张变成死配置）', () => {
        const conflicts = realTechnique.element_match.conflicts || {};
        const techniqueElements = new Set(
            Object.values(realTechnique.techniques).filter(t => t && t.element).map(t => t.element)
        );
        const rootTypes = new Set(realRoleInit.spirit_roots.map(r => r.type));
        const live = Object.entries(conflicts)
            .filter(([root, list]) => rootTypes.has(root))
            .flatMap(([root, list]) => list.filter(e => techniqueElements.has(e)).map(e => `${root}→${e}`));
        expect(live.length).toBeGreaterThan(0);
    });
});
