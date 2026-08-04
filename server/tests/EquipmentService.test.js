/**
 * 装备服务单元测试
 *
 * 覆盖范围：
 *   - 装备属性加成计算（getEquipmentBonus）：验证炼制品质系数 attr_multiplier
 *     会按"祭炼系数 × 炼制品质系数"放大装备基础属性
 *   - 穿戴流程（equip）：验证从背包物品 metadata.attr_multiplier 读取炼制品质系数，
 *     并写入 PlayerEquipment 记录的 attr_multiplier 字段（断链接通）
 *   - 边界条件：非炼制装备（无 metadata）默认 1.0 不放大；attr_multiplier 缺失/非法兜底
 *
 * 测试策略：
 *   本套件只测试**纯逻辑**，不接触数据库。
 *   通过 mock config database/models 与延迟依赖 InventoryService 隔离持久层，
 *   使测试可在无 MySQL 环境下稳定运行。
 */

// 在 require 被测模块前先 mock 掉所有会触发数据库连接的依赖
jest.mock('../config/database', () => ({
    // 返回一个可被回滚/提交的 mock 事务对象；finished 标记防止重复回滚崩溃
    // LOCK.UPDATE 用于 equip 流程中的行锁（sequelize 实际枚举值）
    transaction: jest.fn().mockResolvedValue({
        finished: false,
        rollback: jest.fn(async () => { /* noop */ }),
        commit: jest.fn(async () => { /* noop */ }),
        save: jest.fn(async () => { /* noop */ }),
        LOCK: { UPDATE: 'UPDATE' }
    }),
    // 兼容直接 sequelize.query 的迁移调用（本测试不触发）
    query: jest.fn()
}));
jest.mock('../models/playerEquipment', () => ({
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    destroy: jest.fn()
}));
jest.mock('../models/player', () => ({
    findByPk: jest.fn()
}));
jest.mock('../models/item', () => ({
    findOne: jest.fn(),
    create: jest.fn()
}));
jest.mock('../game/services/InventoryService', () => ({
    addItem: jest.fn().mockResolvedValue(true),
    removeItem: jest.fn().mockResolvedValue(true),
    hasItem: jest.fn().mockResolvedValue(true)
}));

const EquipmentService = require('../game/services/EquipmentService');
const PlayerEquipment = require('../models/playerEquipment');
const Player = require('../models/player');
const Item = require('../models/item');
const InventoryService = require('../game/services/InventoryService');

/** 测试用装备平衡配置，与 game_balance.json 的 equipment 结构保持一致 */
const balanceEquipment = {
    valid_slots: ['weapon', 'armor', 'accessory', 'boots', 'dharma'],
    slot_names: {
        weapon: '武器', armor: '护甲', accessory: '饰品', boots: '靴子', dharma: '法器'
    },
    durability: { initial_max: 100 },
    refine: {
        max_level: 15,
        bonus_per_level: { atk: 0.05, def: 0.05, hp_max: 0.03 }
    }
};

/** 构造 mock 配置加载器 */
function buildConfigLoader() {
    return {
        getConfig: (name) => {
            if (name === 'game_balance') return { equipment: balanceEquipment };
            if (name === 'item_data') {
                return {
                    items: [
                        {
                            id: 'sword_steel',
                            name: '精钢剑',
                            type: 'equipment',
                            subtype: 'weapon',
                            quality: 'common',
                            effect: { atk: 10, def: 2 }
                        }
                    ]
                };
            }
            return null;
        }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    EquipmentService.initialize(buildConfigLoader());
});

describe('装备品质系数接入 - getEquipmentBonus', () => {
    test('炼制品质系数会放大装备基础属性', async () => {
        // 模拟一件已穿戴的精钢剑，炼制品质系数为 1.6（完美品质）
        PlayerEquipment.findAll.mockResolvedValue([
            {
                durability: 100,
                item_key: 'sword_steel',
                refine_level: 0,
                attr_multiplier: 1.6
            }
        ]);

        const bonus = await EquipmentService.getEquipmentBonus(1);
        // atk = floor(10 * (1 + 0*0.05) * 1.6) = 16
        expect(bonus.atk).toBe(16);
        // def = floor(2 * 1.6) = 3
        expect(bonus.def).toBe(3);
    });

    test('普通装备（attr_multiplier=1.0）不放大数据', async () => {
        PlayerEquipment.findAll.mockResolvedValue([
            {
                durability: 100,
                item_key: 'sword_steel',
                refine_level: 0,
                attr_multiplier: 1.0
            }
        ]);

        const bonus = await EquipmentService.getEquipmentBonus(1);
        expect(bonus.atk).toBe(10);
        expect(bonus.def).toBe(2);
    });

    test('祭炼系数与炼制品质系数相乘叠加', async () => {
        // refine_level=10（atk 系数 1+10*0.05=1.5），炼制品质 1.6 → atk=10*1.5*1.6=24
        PlayerEquipment.findAll.mockResolvedValue([
            {
                durability: 100,
                item_key: 'sword_steel',
                refine_level: 10,
                attr_multiplier: 1.6
            }
        ]);

        const bonus = await EquipmentService.getEquipmentBonus(1);
        expect(bonus.atk).toBe(24);
    });

    test('attr_multiplier 缺失或非法时兜底为 1.0', async () => {
        PlayerEquipment.findAll.mockResolvedValue([
            {
                durability: 100,
                item_key: 'sword_steel',
                refine_level: 0,
                attr_multiplier: undefined
            }
        ]);

        const bonus = await EquipmentService.getEquipmentBonus(1);
        expect(bonus.atk).toBe(10);
    });

    test('破碎装备（耐久=0）不提供任何加成', async () => {
        PlayerEquipment.findAll.mockResolvedValue([
            {
                durability: 0,
                item_key: 'sword_steel',
                refine_level: 0,
                attr_multiplier: 1.6
            }
        ]);

        const bonus = await EquipmentService.getEquipmentBonus(1);
        expect(bonus.atk).toBeUndefined();
    });
});

describe('装备品质系数接入 - equip 写入', () => {
    test('从背包 metadata.attr_multiplier 读取并写入 PlayerEquipment', async () => {
        Player.findByPk.mockResolvedValue({ id: 1, is_dead: false, realm_rank: 5 });
        Item.findOne.mockResolvedValue({
            quantity: 1,
            metadata: { attr_multiplier: 1.6, quality: 'epic' }
        });
        PlayerEquipment.findOne.mockResolvedValue(null); // 槽位无旧装备
        InventoryService.removeItem.mockResolvedValue(true);
        PlayerEquipment.create.mockResolvedValue({});

        const result = await EquipmentService.equip(1, 'sword_steel');

        // 验证 PlayerEquipment.create 被调用且携带正确的 attr_multiplier
        expect(PlayerEquipment.create).toHaveBeenCalledTimes(1);
        const createdArg = PlayerEquipment.create.mock.calls[0][0];
        expect(Number(createdArg.attr_multiplier)).toBe(1.6);
        // 返回结果也应暴露该倍率
        expect(result.item.attr_multiplier).toBe(1.6);
    });

    test('非炼制装备无 metadata 时默认 1.0', async () => {
        Player.findByPk.mockResolvedValue({ id: 1, is_dead: false, realm_rank: 5 });
        Item.findOne.mockResolvedValue({ quantity: 1, metadata: null });
        PlayerEquipment.findOne.mockResolvedValue(null);
        InventoryService.removeItem.mockResolvedValue(true);
        PlayerEquipment.create.mockResolvedValue({});

        const result = await EquipmentService.equip(1, 'sword_steel');

        const createdArg = PlayerEquipment.create.mock.calls[0][0];
        expect(Number(createdArg.attr_multiplier)).toBe(1.0);
        expect(result.item.attr_multiplier).toBe(1.0);
    });

    test('attr_multiplier 非法（<=0）时兜底为 1.0', async () => {
        Player.findByPk.mockResolvedValue({ id: 1, is_dead: false, realm_rank: 5 });
        Item.findOne.mockResolvedValue({ quantity: 1, metadata: { attr_multiplier: -2 } });
        PlayerEquipment.findOne.mockResolvedValue(null);
        InventoryService.removeItem.mockResolvedValue(true);
        PlayerEquipment.create.mockResolvedValue({});

        await EquipmentService.equip(1, 'sword_steel');

        const createdArg = PlayerEquipment.create.mock.calls[0][0];
        expect(Number(createdArg.attr_multiplier)).toBe(1.0);
    });

    test('背包中数量不足时抛错且不创建记录', async () => {
        Player.findByPk.mockResolvedValue({ id: 1, is_dead: false, realm_rank: 5 });
        Item.findOne.mockResolvedValue({ quantity: 0, metadata: null });

        await expect(EquipmentService.equip(1, 'sword_steel')).rejects.toThrow('背包中没有该装备');
        expect(PlayerEquipment.create).not.toHaveBeenCalled();
    });
});
