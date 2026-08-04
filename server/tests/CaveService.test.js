/**
 * 洞府服务单元测试
 *
 * 覆盖范围（建议②：修复配置断链）：
 *   - getCaveSeclusionBonus：静室闭关收益加成，受 cave_bonus.seclusion.max_bonus 钳制
 *   - getCaveDefenseBonus：大阵防御减伤比例，受 cave_bonus.defense.max_bonus 钳制
 *   - 开关关闭（enabled=false）时降级为 0
 *   - 洞府未开启/异常时降级为 0
 *
 * 测试策略：纯逻辑，mock PlayerCave 与 configLoader，无 MySQL 依赖。
 */

jest.mock('../models/playerCave', () => ({
    findOne: jest.fn()
}));

const CaveService = require('../game/services/CaveService');
const PlayerCave = require('../models/playerCave');

/** 测试用平衡配置 */
const balanceConfig = {
    cave_bonus: {
        enabled: true,
        seclusion: { enabled: true, max_bonus: 1.0 },
        defense: { enabled: true, max_bonus: 0.5 }
    }
};

/** 测试用洞府设施配置（结构需与 cave_data.json: cave.facilities 一致） */
const caveDataConfig = {
    cave: {
        facilities: {
            quiet_room: { bonus_per_level: 0.1 },
            grand_formation: { defense_per_level: 0.05 }
        }
    }
};

function buildConfigLoader() {
    return {
        getConfig: (name) => {
            if (name === 'game_balance') return balanceConfig;
            if (name === 'cave_data') return caveDataConfig;
            return {};
        }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    CaveService.initialize(buildConfigLoader());
});

describe('getCaveSeclusionBonus 闭关收益加成（断链接通）', () => {
    test('静室等级提供线性加成，未超上限时按实际值返回', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, quiet_room_level: 3 });
        // 3 级 × 0.1 = 0.3，未超 max_bonus(1.0)
        await expect(CaveService.getCaveSeclusionBonus(1)).resolves.toBeCloseTo(0.3, 5);
    });

    test('加成超过 max_bonus 时被钳制在上限', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, quiet_room_level: 20 });
        // 20 × 0.1 = 2.0，但 max_bonus=1.0，应被钳制
        await expect(CaveService.getCaveSeclusionBonus(1)).resolves.toBe(1.0);
    });

    test('开关关闭时降级为 0（灰度关闭能力）', async () => {
        balanceConfig.cave_bonus.seclusion.enabled = false;
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, quiet_room_level: 5 });
        await expect(CaveService.getCaveSeclusionBonus(1)).resolves.toBe(0);
        balanceConfig.cave_bonus.seclusion.enabled = true; // 还原，避免影响后续
    });

    test('洞府未开启时返回 0', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: false, quiet_room_level: 5 });
        await expect(CaveService.getCaveSeclusionBonus(1)).resolves.toBe(0);
    });
});

describe('getCaveDefenseBonus 大阵防御减伤（断链接通）', () => {
    test('大阵等级提供线性减伤，未超上限时按实际值返回', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, grand_formation_level: 4 });
        // 4 × 0.05 = 0.2，未超 max_bonus(0.5)
        await expect(CaveService.getCaveDefenseBonus(1)).resolves.toBeCloseTo(0.2, 5);
    });

    test('减伤比例超过 max_bonus 时被钳制在上限', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, grand_formation_level: 30 });
        // 30 × 0.05 = 1.5，但 max_bonus=0.5，应被钳制
        await expect(CaveService.getCaveDefenseBonus(1)).resolves.toBe(0.5);
    });

    test('开关关闭时降级为 0', async () => {
        balanceConfig.cave_bonus.defense.enabled = false;
        PlayerCave.findOne.mockResolvedValue({ is_opened: true, grand_formation_level: 5 });
        await expect(CaveService.getCaveDefenseBonus(1)).resolves.toBe(0);
        balanceConfig.cave_bonus.defense.enabled = true;
    });

    test('洞府未开启时返回 0', async () => {
        PlayerCave.findOne.mockResolvedValue({ is_opened: false, grand_formation_level: 5 });
        await expect(CaveService.getCaveDefenseBonus(1)).resolves.toBe(0);
    });
});
