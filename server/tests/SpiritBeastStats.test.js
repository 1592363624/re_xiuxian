/**
 * 灵兽属性链路：内容声明 → 实例行 → 玩家属性（不连库）
 *
 * 盯的缺陷形状正是"一把刀只算了攻击"那一类：灵兽的属性赋值原本手写四行、散在 5 个地方
 * （捕获 / 升级 / 升星 / GM 发放 / GM 改等级），而且 routes/admin_spirit_beast.js 还复制了一份
 * calcAttr（注释写着"与 SpiritBeastService.calcAttr 保持一致"）。给灵兽加一个新属性要改完这些位置才生效，
 * 漏掉的地方不报错，只是永远不算。折算给玩家那一层同样手写：只认 atk/def/hp_max/speed 四个键，
 * 还给灵兽根本没有的 mp_max/sense 写死 0，配置里的 mp_factor/sense_factor 从来没人读。
 *
 * 现在：computeStats 按内容里声明的每个 base_<属性> 算，getActiveBeastBonus 按注册表把行上的属性整块折算。
 */
'use strict';

const SpiritBeastService = require('../game/services/SpiritBeastService');
const SpiritBeast = require('../models/spiritBeast');
const beastConfig = require('../config/spirit_beast_data.json');
const { ensureStatRegistryLoaded } = require('../game/stats');
const { initializeModules } = require('../modules');

/** 与改造前逐字相同的那条算式，用来证明没有把数值偷偷改掉 */
function legacyAttr(baseValue, level, starLevel) {
    return Math.floor(Number(baseValue) * (1 + (level - 1) * 0.1) * starLevel);
}

beforeAll(async () => {
    await initializeModules();
    ensureStatRegistryLoaded();
});

describe('computeStats：属性清单来自内容', () => {
    test.each(beastConfig.beast_types.map(bt => [bt.beast_key, bt]))('%s 四项属性与改造前逐格相同', (key, bt) => {
        for (const [level, star] of [[1, 1], [7, 2], [33, 5], [100, 10]]) {
            expect(SpiritBeastService.computeStats(bt, level, star)).toEqual({
                hp_max: legacyAttr(bt.base_hp, level, star),
                atk: legacyAttr(bt.base_atk, level, star),
                def: legacyAttr(bt.base_def, level, star),
                speed: legacyAttr(bt.base_speed, level, star)
            });
        }
    });

    test('内容里 base_hp 落到 hp_max 列（唯一不同名的那一处）', () => {
        const stats = SpiritBeastService.computeStats({ beast_key: 'x', base_hp: 100 }, 1, 1);
        expect(stats).toEqual({ hp_max: 100 });
        expect('hp' in stats).toBe(false);
    });

    test('非属性的 base_* 安静跳过；注册表认识但灵兽表没有列的属性告警并跳过', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(SpiritBeastService.computeStats({ beast_key: 'x', base_yield_per_hour: 5 }, 1, 1)).toEqual({});
        expect(warn).not.toHaveBeenCalled();

        const stats = SpiritBeastService.computeStats({ beast_key: 'x', base_crit_damage: 40 }, 1, 1);
        expect(stats).toEqual({});                 // 没有列可存放，绝不能凭空造字段
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('base_crit_damage'));
        warn.mockRestore();
    });
});

describe('出战灵兽折算给玩家：整块走注册表', () => {
    const bonusCfg = beastConfig.settings.combat_bonus;

    test('四项系数与改造前一致（atk/def 全额、hp_max 0.5、speed 0.3）', async () => {
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', element: 'metal', rarity: 'rare',
            level: 10, star_level: 3, hp_max: 5000, atk: 300, def: 200, speed: 80, loyalty: 60
        });
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(beast);
        const bonus = await SpiritBeastService.getActiveBeastBonus(1);
        findOne.mockRestore();

        // 加成比例 = base_rate + 星级×star_rate + 等级×level_rate（0.1+0.15+0.05=0.3，上限 max_rate）
        const rate = bonusCfg.base_rate + 3 * bonusCfg.star_rate + 10 * bonusCfg.level_rate;
        expect(rate).toBeCloseTo(0.3, 10);
        expect(bonus.atk).toBe(Math.floor(300 * rate * bonusCfg.stat_factors.atk));
        expect(bonus.def).toBe(Math.floor(200 * rate * bonusCfg.stat_factors.def));
        expect(bonus.hp_max).toBe(Math.floor(5000 * rate * bonusCfg.stat_factors.hp_max));
        expect(bonus.speed).toBe(Math.floor(80 * rate * bonusCfg.stat_factors.speed));
        expect(bonus.beast_info.bonus_rate).toBe(30);
    });

    test('灵兽行上新增一个注册属性，不必改服务就会折算给玩家（系数没写按全额）', async () => {
        const fake = {
            id: 9, player_id: 1, beast_key: 'qingyun_wolf', beast_name: '小灰', element: 'metal',
            rarity: 'rare', level: 10, star_level: 3, loyalty: 60,
            toJSON: () => ({ hp_max: 5000, atk: 300, def: 200, speed: 80, dodge_rate: 40 })
        };
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(fake);
        const bonus = await SpiritBeastService.getActiveBeastBonus(1);
        findOne.mockRestore();

        expect(bonus.dodge_rate).toBe(Math.floor(40 * 0.3));
        expect(bonus.beast_info.beast_name).toBe('小灰');
    });

    test('不再返回灵兽根本没有的 mp_max/sense 假零（配置里那两个孤儿 factor 也已删掉）', async () => {
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', element: 'metal', rarity: 'common',
            level: 1, star_level: 1, hp_max: 100, atk: 10, def: 10, speed: 10
        }));
        const bonus = await SpiritBeastService.getActiveBeastBonus(1);
        findOne.mockRestore();

        expect(Object.keys(bonus).sort()).toEqual(['atk', 'beast_info', 'def', 'hp_max', 'speed']);
        expect(bonusCfg.mp_factor).toBeUndefined();
        expect(bonusCfg.sense_factor).toBeUndefined();
    });

    test('没有出战灵兽时仍然只返回 beast_info:null', async () => {
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(null);
        await expect(SpiritBeastService.getActiveBeastBonus(1)).resolves.toEqual({ beast_info: null });
        findOne.mockRestore();
    });
});

describe('防复发：灵兽属性算式只有一处', () => {
    const fs = require('fs');
    const path = require('path');
    const codeOf = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '');

    test('calcAttr 全仓只有一份定义，且只在 computeStats 里调用', () => {
        const defs = ['game/services/SpiritBeastService.js', 'routes/admin_spirit_beast.js']
            .reduce((n, rel) => n + (codeOf(rel).match(/function calcAttr\(/g) || []).length, 0);
        expect(defs).toBe(1);
    });

    test('谁都不许再"点着字段名"从 base_* 算属性（图鉴展示 base 值、返还公式用 base_hp 都不算）', () => {
        // 只拦这个形状：hp_max: beastType.base_hp / beast.atk = calcAttr(bt.base_atk, …)
        const perFieldAssign = /\b(hp_max|atk|def|speed)\s*[:=]\s*[^\n,]*base_/g;
        for (const rel of ['game/services/SpiritBeastService.js', 'routes/admin_spirit_beast.js']) {
            expect(codeOf(rel).match(perFieldAssign)).toBe(null);
        }
    });
});
