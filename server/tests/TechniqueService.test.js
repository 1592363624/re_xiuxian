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
// 属性系统配置：功法的 element 必须是这里定义的真实灵根，否则五行匹配永远不会命中
const attributeSystem = require('../config/attribute_system.json');

/**
 * 从 attribute_system.json 动态推导合法的功法属性集合
 * 说明：不硬编码五行列表——本游戏存在 thunder/ice 变异灵根，
 *       硬编码会导致测试与实际灵根体系脱节。'none' 表示无属性功法。
 */
const VALID_ELEMENTS = [
    ...Object.keys(attributeSystem.attribute_bonuses.spirit_root_bonus),
    'none'
];

/**
 * 构造测试用配置加载器
 * @param {Object} cfg - 要返回的 technique_data 配置
 */
function buildConfigLoader(cfg) {
    return {
        getConfig: (name) => {
            if (name === 'technique_data') return cfg;
            return {};
        }
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
            gold: ['wood'], wood: ['earth'], earth: ['water'],
            water: ['fire'], fire: ['gold']
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
        fire_ball: { name: '烈火球', element: 'fire', effects: { damage_pct: 30 } },
        common_shield: { name: '护体罡气', element: 'none', effects: { def_pct: 20 } }
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

    test('功法引用的属性均为真实存在的灵根', () => {
        for (const [id, cfg] of Object.entries(realConfig.techniques)) {
            if (id.startsWith('_')) continue;
            expect(VALID_ELEMENTS).toContain(cfg.element);
        }
    });

    test('相克表中的灵根键名均真实存在（金应为 gold 而非 metal）', () => {
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
        for (const el of ['gold', 'wood', 'water', 'fire', 'earth']) {
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
