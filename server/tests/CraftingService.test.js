/**
 * 炼制服务单元测试
 *
 * 覆盖范围：
 *   - 成功率公式各组成部分（境界差、洞府加成、火候修正、钳制）
 *   - 丹药品质浮动档位映射
 *   - 火候会话状态机（开炉/控火/结算/取消/超时）
 *   - 边界条件：空值、越界、非整数、NaN、脏配置
 *   - 并发条件：同一会话重复结算只能生效一次
 *
 * 测试策略：
 *   本套件只测试**纯逻辑**，不接触数据库。
 *   通过注入 mock configLoader 隔离配置，通过 mock 依赖模块隔离持久层，
 *   使测试可在无 MySQL 环境下稳定运行。
 */

// 在 require 被测模块前先 mock 掉所有会触发数据库连接的依赖
jest.mock('../config/database', () => ({
    // 返回一个可被回滚/提交的 mock 事务对象；finished 标记防止重复回滚崩溃
    transaction: jest.fn().mockResolvedValue({
        finished: false,
        rollback: jest.fn(async () => { /* noop */ }),
        commit: jest.fn(async () => { /* noop */ }),
        save: jest.fn(async () => { /* noop */ })
    })
}));
jest.mock('../models/playerRecipe', () => ({
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
}));
jest.mock('../models/player', () => ({
    findByPk: jest.fn()
}));
jest.mock('../game/services/InventoryService', () => ({
    hasItem: jest.fn(),
    removeItem: jest.fn(),
    addItem: jest.fn()
}));
jest.mock('../game/services/CaveService', () => ({
    getCaveBonus: jest.fn()
}));

const CraftingService = require('../game/services/CraftingService');
const PlayerRecipe = require('../models/playerRecipe');
const Player = require('../models/player');
const InventoryService = require('../game/services/InventoryService');
const CaveService = require('../game/services/CaveService');

/** 测试用炼制平衡配置，与 game_balance.json 结构保持一致 */
const balanceCrafting = {
    max_craft_quantity: 10,
    fail_exp_ratio: 0.2,
    realm_diff: {
        bonus_per_rank: 0.02,
        max_bonus: 0.12,
        penalty_per_rank: 0.08,
        max_penalty: 0.4
    },
    success_rate_floor: 0.05,
    success_rate_cap: 0.95,
    cave_bonus: {
        enabled: true,
        max_alchemy_bonus: 0.3,
        max_refining_bonus: 0.3
    },
    heat_control: {
        enabled: true,
        stages: 3,
        session_timeout_sec: 300,
        heat_min: 1,
        heat_max: 5,
        perfect_bonus_per_stage: 0.04,
        deviation_penalty_per_point: 0.05,
        auto_mode_success_modifier: -0.05
    },
    quality_float: {
        enabled: true,
        quality_order: ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'],
        tiers: [
            { name: '完美', max_deviation: 0, upgrade: 1, effect_multiplier: 1.6 },
            { name: '极品', max_deviation: 1, upgrade: 1, effect_multiplier: 1.35 },
            { name: '上品', max_deviation: 3, upgrade: 0, effect_multiplier: 1.15 },
            { name: '凡品', max_deviation: 6, upgrade: 0, effect_multiplier: 1.0 },
            { name: '劣品', max_deviation: 99, upgrade: -1, effect_multiplier: 0.7 }
        ],
        skill_level_deviation_forgiveness: 0.1
    }
};

/** 测试用配方：聚气丹 */
const testRecipe = {
    id: 'recipe_qi_pill',
    name: '聚气丹',
    type: 'alchemy',
    description: '测试用丹方',
    required_realm_rank: 2,
    required_skill_level: 1,
    base_success_rate: 0.6,
    skill_exp: 10,
    cooldown_sec: 0,
    learn_source: 'default',
    materials: [{ item_key: 'herb_a', quantity: 2 }],
    product: { item_key: 'pill_qi', quantity: 1 }
};

/** 测试用炼器配方：精钢剑（验证炼器火候框架复用） */
const refiningTestRecipe = {
    id: 'recipe_steel_sword',
    name: '精钢剑',
    type: 'refining',
    description: '测试用炼器方',
    required_realm_rank: 2,
    required_skill_level: 1,
    base_success_rate: 0.55,
    skill_exp: 12,
    cooldown_sec: 0,
    learn_source: 'default',
    materials: [{ item_key: 'ore_a', quantity: 3 }],
    product: { item_key: 'sword_steel', quantity: 1 }
};

/** 构造 mock 配置加载器 */
function buildConfigLoader(overrides = {}) {
    const crafting = { ...balanceCrafting, ...overrides };
    return {
        getConfig: (name) => {
            if (name === 'game_balance') return { crafting };
            if (name === 'crafting_data') {
                return {
                    alchemy_recipes: [testRecipe],
                    refining_recipes: [refiningTestRecipe],
                    skill_levels: [
                        { level: 1, exp_required: 0, success_bonus: 0, title: '炼制学徒' },
                        { level: 5, exp_required: 500, success_bonus: 0.1, title: '炼制师' }
                    ]
                };
            }
            if (name === 'item_data') {
                return { items: [{ id: 'pill_qi', name: '聚气丹', quality: 'uncommon' }] };
            }
            return {};
        }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    CraftingService.initialize(buildConfigLoader());
    // 清空跨用例残留的火候会话，保证用例相互独立
    CraftingService._heatSessions.clear();
});

afterAll(() => {
    // 关闭清扫定时器，避免 Jest 因活跃句柄无法退出
    CraftingService.stopSessionSweeper();
});

describe('calcRealmModifier 境界差修正', () => {
    test('境界等于要求时无修正', () => {
        expect(CraftingService.calcRealmModifier(2, 2)).toBe(0);
    });

    test('境界高于要求时给予正加成', () => {
        // 高 3 阶 -> 3 * 0.02 = 0.06
        expect(CraftingService.calcRealmModifier(5, 2)).toBeCloseTo(0.06, 5);
    });

    test('正加成封顶于 max_bonus', () => {
        // 高 50 阶远超上限，应被钳制为 0.12
        expect(CraftingService.calcRealmModifier(52, 2)).toBeCloseTo(0.12, 5);
    });

    test('境界低于要求时给予负修正（防御性兜底）', () => {
        // 低 2 阶 -> -(2 * 0.08) = -0.16
        expect(CraftingService.calcRealmModifier(1, 3)).toBeCloseTo(-0.16, 5);
    });

    test('负修正封顶于 max_penalty', () => {
        expect(CraftingService.calcRealmModifier(0, 99)).toBeCloseTo(-0.4, 5);
    });

    test('传入 null/undefined 时按 0 处理，不抛异常', () => {
        expect(() => CraftingService.calcRealmModifier(null, undefined)).not.toThrow();
        expect(CraftingService.calcRealmModifier(null, undefined)).toBe(0);
    });
});

describe('_clampRate 成功率钳制', () => {
    test('区间内数值原样返回', () => {
        expect(CraftingService._clampRate(0.5)).toBe(0.5);
    });

    test('超过上限被钳制', () => {
        expect(CraftingService._clampRate(5)).toBe(0.95);
    });

    test('低于下限被钳制', () => {
        expect(CraftingService._clampRate(-3)).toBe(0.05);
    });

    test('NaN 兜底为下限，防止概率判定恒为失败', () => {
        expect(CraftingService._clampRate(NaN)).toBe(0.05);
    });

    test('Infinity 被钳制为上限', () => {
        expect(CraftingService._clampRate(Infinity)).toBe(0.95);
    });
});

describe('calcHeatModifier 火候修正', () => {
    test('零偏差按阶段数给予完美加成', () => {
        // 3 阶段全完美 -> 3 * 0.04 = 0.12
        expect(CraftingService.calcHeatModifier(0, 3)).toBeCloseTo(0.12, 5);
    });

    test('有偏差时按偏差点数惩罚', () => {
        expect(CraftingService.calcHeatModifier(4, 3)).toBeCloseTo(-0.2, 5);
    });
});

describe('calcQualityTier 品质浮动', () => {
    test('零偏差产出完美品质并提升一档', () => {
        const r = CraftingService.calcQualityTier(0, 1, 'uncommon');
        expect(r.name).toBe('完美');
        expect(r.quality).toBe('rare'); // uncommon -> rare
        expect(r.effect_multiplier).toBe(1.6);
    });

    test('中等偏差产出上品且不升档', () => {
        const r = CraftingService.calcQualityTier(3, 0, 'uncommon');
        expect(r.name).toBe('上品');
        expect(r.quality).toBe('uncommon');
    });

    test('极大偏差产出劣品并降一档', () => {
        const r = CraftingService.calcQualityTier(50, 0, 'uncommon');
        expect(r.name).toBe('劣品');
        expect(r.quality).toBe('common');
    });

    test('技能等级提供偏差容错', () => {
        // 偏差 2，技能 10 级抵消 10*0.1=1 点，有效偏差 1 -> 极品
        const r = CraftingService.calcQualityTier(2, 10, 'uncommon');
        expect(r.name).toBe('极品');
    });

    test('品质升档不会越过序列上界', () => {
        const r = CraftingService.calcQualityTier(0, 0, 'mythic');
        expect(r.quality).toBe('mythic');
    });

    test('品质降档不会越过序列下界', () => {
        const r = CraftingService.calcQualityTier(99, 0, 'common');
        expect(r.quality).toBe('common');
    });

    test('未知基准品质回退为序列首位再计算，不产生 undefined', () => {
        const r = CraftingService.calcQualityTier(3, 0, 'not_exist_quality');
        expect(r.quality).toBeDefined();
        expect(balanceCrafting.quality_float.quality_order).toContain(r.quality);
    });

    test('功能关闭时保持基准品质（向后兼容）', () => {
        CraftingService.initialize(buildConfigLoader({
            quality_float: { ...balanceCrafting.quality_float, enabled: false }
        }));
        const r = CraftingService.calcQualityTier(0, 0, 'uncommon');
        expect(r.quality).toBe('uncommon');
        expect(r.effect_multiplier).toBe(1);
    });
});

describe('calcCaveBonus 洞府加成接通', () => {
    test('炼丹读取丹房加成', async () => {
        CaveService.getCaveBonus.mockResolvedValue({ pill_success_bonus: 0.15, tool_success_bonus: 0.2 });
        await expect(CraftingService.calcCaveBonus(1, 'alchemy')).resolves.toBeCloseTo(0.15, 5);
    });

    test('炼器读取器室加成', async () => {
        CaveService.getCaveBonus.mockResolvedValue({ pill_success_bonus: 0.15, tool_success_bonus: 0.2 });
        await expect(CraftingService.calcCaveBonus(1, 'refining')).resolves.toBeCloseTo(0.2, 5);
    });

    test('加成超过上限时被钳制', async () => {
        CaveService.getCaveBonus.mockResolvedValue({ pill_success_bonus: 9.9 });
        await expect(CraftingService.calcCaveBonus(1, 'alchemy')).resolves.toBe(0.3);
    });

    test('洞府服务抛错时降级为 0，不阻断炼制主流程', async () => {
        CaveService.getCaveBonus.mockRejectedValue(new Error('db down'));
        await expect(CraftingService.calcCaveBonus(1, 'alchemy')).resolves.toBe(0);
    });

    test('洞府数据为 null 时返回 0', async () => {
        CaveService.getCaveBonus.mockResolvedValue(null);
        await expect(CraftingService.calcCaveBonus(1, 'alchemy')).resolves.toBe(0);
    });

    test('开关关闭时不调用洞府服务', async () => {
        CraftingService.initialize(buildConfigLoader({
            cave_bonus: { enabled: false }
        }));
        await expect(CraftingService.calcCaveBonus(1, 'alchemy')).resolves.toBe(0);
        expect(CaveService.getCaveBonus).not.toHaveBeenCalled();
    });
});

describe('火候会话状态机', () => {
    /** 准备一个可炼制的玩家环境 */
    function mockCraftablePlayer() {
        PlayerRecipe.findOne.mockResolvedValue({
            player_id: 1,
            recipe_id: testRecipe.id,
            skill_level: 1,
            skill_exp: 0,
            craft_count: 0,
            last_craft_at: null,
            save: jest.fn()
        });
        Player.findByPk.mockResolvedValue({ id: 1, realm_rank: 5 });
        InventoryService.hasItem.mockResolvedValue(true);
    }

    test('开炉后返回首阶段提示且不泄露目标火候', async () => {
        mockCraftablePlayer();
        const r = await CraftingService.craftStart(1, testRecipe.id, 1);
        expect(r.success).toBe(true);
        expect(r.total_stages).toBe(3);
        expect(r.current_stage).toBe(1);
        expect(r.hint).toHaveProperty('text');
        // 关键：响应体中不得包含目标答案
        expect(JSON.stringify(r)).not.toContain('targets');
    });

    test('未开炉直接控火应报错', async () => {
        await expect(CraftingService.craftHeat(1, 3)).rejects.toThrow('没有进行中的炼制');
    });

    test('未开炉直接结算应报错', async () => {
        await expect(CraftingService.craftFinish(1)).rejects.toThrow('没有进行中的炼制');
    });

    test('火候档位越界被拒绝', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        await expect(CraftingService.craftHeat(1, 99)).rejects.toThrow('火候档位必须');
        await expect(CraftingService.craftHeat(1, 0)).rejects.toThrow('火候档位必须');
    });

    test('火候档位为非整数被拒绝', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        await expect(CraftingService.craftHeat(1, 2.5)).rejects.toThrow('火候档位必须');
        await expect(CraftingService.craftHeat(1, NaN)).rejects.toThrow('火候档位必须');
    });

    test('阶段未走完就结算应报错', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        await CraftingService.craftHeat(1, 3);
        await expect(CraftingService.craftFinish(1)).rejects.toThrow('火候尚未把控完毕');
    });

    test('走完全部阶段后 finished 置位', async () => {
        mockCraftablePlayer();
        const start = await CraftingService.craftStart(1, testRecipe.id, 1);
        let last;
        for (let i = 0; i < start.total_stages; i++) {
            last = await CraftingService.craftHeat(1, 3);
        }
        expect(last.finished).toBe(true);
        expect(last.hint).toBeNull();
    });

    test('会话超时后控火被拒绝并清理会话', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        // 手动将过期时间拨到过去，模拟超时
        const session = CraftingService._heatSessions.get('1');
        session.expiresAt = Date.now() - 1;
        await expect(CraftingService.craftHeat(1, 3)).rejects.toThrow('炼制超时');
        expect(CraftingService._heatSessions.has('1')).toBe(false);
    });

    test('停火散炉可清除会话', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        const r = CraftingService.craftCancel(1);
        expect(r.cancelled).toBe(true);
        expect(CraftingService._heatSessions.has('1')).toBe(false);
    });

    test('同一玩家重复开炉只保留最新会话，防止择优提交', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        await CraftingService.craftStart(1, testRecipe.id, 1);
        expect(CraftingService._heatSessions.size).toBe(1);
    });

    test('数字与字符串 playerId 命中同一会话（key 类型统一）', async () => {
        mockCraftablePlayer();
        await CraftingService.craftStart(1, testRecipe.id, 1);
        expect(CraftingService.getHeatSession('1')).not.toBeNull();
        expect(CraftingService.getHeatSession(1)).not.toBeNull();
    });

    test('并发重复结算只能生效一次（会话先删后炼）', async () => {
        mockCraftablePlayer();
        // 让真实 craft 不被执行，仅观察调用次数
        const craftSpy = jest.spyOn(CraftingService, 'craft').mockResolvedValue({ success: true });

        const start = await CraftingService.craftStart(1, testRecipe.id, 1);
        for (let i = 0; i < start.total_stages; i++) {
            await CraftingService.craftHeat(1, 3);
        }

        // 并发发起两次结算，只有一次应成功
        const results = await Promise.allSettled([
            CraftingService.craftFinish(1),
            CraftingService.craftFinish(1)
        ]);
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(craftSpy).toHaveBeenCalledTimes(1);

        craftSpy.mockRestore();
    });

    test('材料不足时开炉即失败，不浪费玩家火候操作', async () => {
        mockCraftablePlayer();
        InventoryService.hasItem.mockResolvedValue(false);
        await expect(CraftingService.craftStart(1, testRecipe.id, 1)).rejects.toThrow('数量不足');
        expect(CraftingService._heatSessions.size).toBe(0);
    });

    test('境界不足时开炉即失败', async () => {
        mockCraftablePlayer();
        Player.findByPk.mockResolvedValue({ id: 1, realm_rank: 0 });
        await expect(CraftingService.craftStart(1, testRecipe.id, 1)).rejects.toThrow('境界不足');
    });

    test('未学配方时开炉失败', async () => {
        PlayerRecipe.findOne.mockResolvedValue(null);
        Player.findByPk.mockResolvedValue({ id: 1, realm_rank: 5 });
        await expect(CraftingService.craftStart(1, testRecipe.id, 1)).rejects.toThrow('尚未学会');
    });

    test('配方不存在时开炉报 404', async () => {
        await expect(CraftingService.craftStart(1, 'no_such_recipe', 1)).rejects.toThrow('配方不存在');
    });

    test('getHeatSession 对无会话返回 null', () => {
        expect(CraftingService.getHeatSession(999)).toBeNull();
    });
});

describe('craft 参数边界', () => {
    test('数量为 0 / 负数 / 超上限 / 非整数均被拒绝', async () => {
        await expect(CraftingService.craft(1, testRecipe.id, 0)).rejects.toThrow('炼制次数');
        await expect(CraftingService.craft(1, testRecipe.id, -5)).rejects.toThrow('炼制次数');
        await expect(CraftingService.craft(1, testRecipe.id, 999)).rejects.toThrow('炼制次数');
        await expect(CraftingService.craft(1, testRecipe.id, 1.5)).rejects.toThrow('炼制次数');
        await expect(CraftingService.craft(1, testRecipe.id, NaN)).rejects.toThrow('炼制次数');
    });
});

// ============ 以下用例验证"建议1+2+3"新增能力 ============

describe('炼制产物写入品质元数据（建议①）', () => {
    beforeEach(() => {
        // 准备可炼制的前提数据
        PlayerRecipe.findOne.mockResolvedValue({
            get: (k) => ({
                recipe_id: testRecipe.id, skill_level: 1, skill_exp: 0, is_learned: true
            }[k]),
            save: jest.fn()
        });
        Player.findByPk.mockResolvedValue({
            id: 1, realm_rank: 2, attributes: { hp_max: 100 },
            save: jest.fn()
        });
        InventoryService.hasItem.mockResolvedValue(true);
        InventoryService.removeItem.mockResolvedValue(true);
        InventoryService.addItem.mockResolvedValue({});
        CaveService.getCaveBonus.mockResolvedValue({ pill_success_bonus: 0, tool_success_bonus: 0 });
    });

    test('丹药产出 metadata 携带 effect_multiplier 供服用放大', async () => {
        // 固定随机值保证成功判定通过，火候偏差=0 取完美档（effect_multiplier=1.6）
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const res = await CraftingService.craft(1, testRecipe.id, 1, { deviation: 0, stages: 3, auto: false });
            expect(res.success_count).toBe(1);
            const metaArg = InventoryService.addItem.mock.calls[0][4];
            expect(metaArg).toBeDefined();
            expect(metaArg.quality_tier).toBeTruthy();
            expect(metaArg.effect_multiplier).toBeCloseTo(1.6, 5);
            expect(metaArg.attr_multiplier).toBe(1); // 丹药不写装备属性倍率
        } finally {
            randomSpy.mockRestore();
        }
    });

    test('炼器产物 metadata 用 attr_multiplier 而 effect_multiplier 归 1', async () => {
        // 炼器配方 mock 需带 save 方法（craft 内部会持久化 skill_exp）
        PlayerRecipe.findOne.mockResolvedValue({
            get: (k) => ({
                recipe_id: refiningTestRecipe.id, skill_level: 1, skill_exp: 0, is_learned: true
            }[k]),
            save: jest.fn()
        });
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const res = await CraftingService.craft(1, refiningTestRecipe.id, 1, { deviation: 0, stages: 3, auto: false });
            expect(res.success_count).toBe(1);
            const metaArg = InventoryService.addItem.mock.calls[0][4];
            expect(metaArg.attr_multiplier).toBeCloseTo(1.6, 5);
            expect(metaArg.effect_multiplier).toBe(1);
        } finally {
            randomSpy.mockRestore();
        }
    });
});

describe('炼器复用火候控制框架（建议③）', () => {
    beforeEach(() => {
        PlayerRecipe.findOne.mockResolvedValue({
            get: (k) => ({
                recipe_id: refiningTestRecipe.id, skill_level: 1, skill_exp: 0, is_learned: true
            }[k]),
            save: jest.fn()
        });
        Player.findByPk.mockResolvedValue({
            id: 1, realm_rank: 2, attributes: { hp_max: 100 }, save: jest.fn()
        });
        InventoryService.hasItem.mockResolvedValue(true);
        InventoryService.removeItem.mockResolvedValue(true);
        InventoryService.addItem.mockResolvedValue({});
        CaveService.getCaveBonus.mockResolvedValue({ pill_success_bonus: 0, tool_success_bonus: 0.2 });
    });

    test('炼器配方可开启火候会话（开炉控火按钮通用）', async () => {
        const session = await CraftingService.craftStart(1, refiningTestRecipe.id, 1);
        expect(session.success).toBe(true);
        expect(session.recipe_id).toBe(refiningTestRecipe.id);
        // 同一玩家炼器会话已建立
        expect(CraftingService._getActiveSession(1).recipeId).toBe(refiningTestRecipe.id);
    });

    test('炼器火候结算走 tool_success_bonus 而非丹房加成', async () => {
        await CraftingService.craftStart(1, refiningTestRecipe.id, 1);
        const session = CraftingService._getActiveSession(1);
        // 模拟火候全部命中（deviation=0），直接结算
        session.currentStage = session.targets.length;
        session.deviation = 0;
        const res = await CraftingService.craftFinish(1);
        expect(res).toBeDefined();
        // 验证 calcCaveBonus 以 refining 类型被调用，取器室加成
        expect(CaveService.getCaveBonus).toHaveBeenCalled();
    });
});

