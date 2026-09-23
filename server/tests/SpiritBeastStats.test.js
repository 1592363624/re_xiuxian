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
 * 2026-09-21 补上最后一块：没有专属列的属性不再被丢掉，而是落在 spirit_beasts.stat_block 属性块里
 * （migration_0088），读取端一律经 SpiritBeastService.statBlockOf 合并列 + 属性块 ——
 * 于是"给灵兽加一档新属性"从"改表 + 改 5 处赋值"变成"注册表登记 + 内容写 base_<属性>"。
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

    test('非属性的 base_* 安静跳过；注册表认识但没有专属列的属性进 stat_block 属性块', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(SpiritBeastService.computeStats({ beast_key: 'x', base_yield_per_hour: 5 }, 1, 1)).toEqual({});
        expect(warn).not.toHaveBeenCalled();

        const stats = SpiritBeastService.computeStats({ beast_key: 'x', base_crit_damage: 40 }, 7, 2);
        // 这条断言在 2026-09-21 之前是 `toEqual({})` + 期望一句 warn：
        // 当时 spirit_beasts 只有四个属性列，注册表认识的新属性算出来没地方放，只能丢掉。
        // 现在它落在 stat_block 属性块里（migration_0088），所以既不该丢、也不该再报"没列存放"。
        expect(stats).toEqual({ stat_block: { crit_damage: legacyAttr(40, 7, 2) } });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('专属列优先：同名既在列上又在属性块里时，取列上的值', () => {
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', element: 'metal', rarity: 'common',
            level: 5, star_level: 1, hp_max: 1234, atk: 77, def: 10, speed: 10,
            stat_block: { atk: 99999, crit_damage: 40 }
        });
        const block = SpiritBeastService.statBlockOf(beast);
        expect(block.atk).toBe(77);               // 列上的值赢，属性块里的诱饵不许顶掉它
        expect(block.crit_damage).toBe(40);       // 没有列的那一档从属性块里读到
    });

    test('applyComputedStats：内容撤掉那一档属性后，旧属性块必须被清空（别留下过期数字）', () => {
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', element: 'metal', rarity: 'common',
            level: 1, star_level: 1, hp_max: 100, atk: 10, def: 10, speed: 10,
            stat_block: { crit_damage: 40 }
        });
        // 重算时用的种类内容里没有 base_crit_damage（相当于资料片撤了那一档）
        SpiritBeastService.applyComputedStats(beast, SpiritBeastService.computeStats(
            { beast_key: 'qingyun_wolf', base_atk: 100 }, 1, 1
        ));
        expect(beast.atk).toBe(100);
        expect(beast.stat_block).toBe(null);
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

    test('属性块里的新属性也折算给玩家（真实例形状，不是手搭的 toJSON 替身）', async () => {
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', beast_name: '小灰', element: 'metal', rarity: 'rare',
            level: 10, star_level: 3, hp_max: 5000, atk: 300, def: 200, speed: 80, loyalty: 60,
            stat_block: { crit_damage: 40 }
        });
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(beast);
        const bonus = await SpiritBeastService.getActiveBeastBonus(1);
        findOne.mockRestore();

        expect(bonus.crit_damage).toBe(Math.floor(40 * 0.3));   // stat_factors 没写这一档 → 全额
        expect(bonus.atk).toBe(Math.floor(300 * 0.3 * bonusCfg.stat_factors.atk));
    });

    test('没有出战灵兽时仍然只返回 beast_info:null', async () => {
        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(null);
        await expect(SpiritBeastService.getActiveBeastBonus(1)).resolves.toEqual({ beast_info: null });
        findOne.mockRestore();
    });

    test('_formatBeast 把属性块连标签一起外发，并且不列 0 值的那几档', () => {
        const registry = ensureStatRegistryLoaded();
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'qingyun_wolf', element: 'metal', rarity: 'common',
            level: 7, star_level: 2, hp_max: 1600, atk: 256, def: 160, speed: 288,
            stat_block: { crit_damage: 40, dodge_rate: 0 }
        });
        const formatted = SpiritBeastService._formatBeast(beast, new Map(), {}, {});
        expect(formatted.extra_stats.map(e => e.key)).toEqual(['crit_damage']);   // 0 值不占卡片位置
        const entry = formatted.extra_stats[0];
        // 标签与单位从注册表现读，别在测试里抄一份中文名（抄了就会跟着词表漂移）
        const def = registry.resolveStatKey('crit_damage');
        expect(entry.label).toBe(def.label);
        expect(entry.unit).toBe(def.unit);
        expect(entry.value).toBe(40);
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
