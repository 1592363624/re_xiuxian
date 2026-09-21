/**
 * 灵兽战力的权重必须真的由内容说话（objective 里那条"加一个属性要在各处都算得到"的落地检查）。
 *
 * 改造前：权重表在 spirit_beast_data.settings.combat_power_weight 里，但 `calculateCombatPower`
 * 把 hp/atk/def/speed 四项按名字各写一遍 —— 内容里加一档（或把键改个名）等于什么都没发生。
 * 本文件钉四件事：
 *   1) 现网权重下的战力与改造前逐值相等（搬家不许动数值）；
 *   2) 内容里多一档权重，战斗立刻算进去（这才叫内容驱动）；
 *   3) 内容声明的每个权重键都必须是"注册表认得的属性 + spirit_beasts 上真有这一列"，
 *      否则就是一条配了不生效的死权重（这正是本轮反复在堵的那类静默失效）；
 *   4) 代码里不许再把属性键抄成字面量清单。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { infrastructure, initializeModules } = require('../modules');
const SpiritBeastService = require('../game/services/SpiritBeastService');
const SpiritBeast = require('../models/spiritBeast');
const { ensureStatRegistryLoaded } = require('../game/stats');

const configLoader = infrastructure.ConfigLoader;
const serverRoot = path.join(__dirname, '..');

/**
 * 改造前那份算式，逐字照抄（含当时的权重值），只用来对值。
 * 权重在这里写死是刻意的：控制不能跟着被控对象一起改，否则改内容键名就把"值变了"遮掉了。
 */
function legacyPower(beast) {
    const weight = { hp: 0.1, atk: 2.0, def: 1.5, speed: 1.0 };
    const hp = Number(beast.hp_max || 0);
    const atk = Number(beast.atk || 0);
    const def = Number(beast.def || 0);
    const speed = Number(beast.speed || 0);
    const starBonus = 1 + (Number(beast.star_level) - 1) * 0.1;
    return Math.floor((hp * weight.hp + atk * weight.atk + def * weight.def + speed * weight.speed) * starBonus);
}

function withSettings(patch, run) {
    const original = configLoader.getConfig;
    configLoader.getConfig = (name) => {
        const base = original.call(configLoader, name);
        if (name !== 'spirit_beast_data' || !base) return base;
        return { ...base, settings: { ...base.settings, ...patch } };
    };
    try {
        return run();
    } finally {
        configLoader.getConfig = original;
    }
}

beforeAll(async () => {
    await initializeModules();
});

describe('灵兽战力由内容权重驱动', () => {
    test('现网权重下与改造前逐值相等（含 BigInt 字符串与 1 星）', () => {
        const beasts = [
            { hp_max: '3000', atk: 120, def: 80, speed: 55, star_level: 1 },
            { hp_max: 9000n, atk: 400, def: 260, speed: 130, star_level: 5 },
            { hp_max: 0, atk: 0, def: 0, speed: 0, star_level: 3 },
            { atk: 77, star_level: 9 }    // 缺列按 0 算
        ];
        for (const beast of beasts) {
            expect(SpiritBeastService.calculateCombatPower(beast)).toBe(legacyPower(beast));
        }
    });

    test('内容里多一档权重，战斗立刻算进去（不用改代码）', () => {
        const beast = { hp_max: 1000, atk: 100, def: 50, speed: 20, star_level: 1, loyalty: 60 };
        const before = SpiritBeastService.calculateCombatPower(beast);
        // 内容里多一档权重（列存在即可）→ 战力立刻变，不用碰代码
        const withLoyalty = withSettings(
            { combat_power_weight: { hp_max: 0.1, atk: 2, def: 1.5, speed: 1, loyalty: 10 } },
            () => SpiritBeastService.calculateCombatPower(beast)
        );
        expect(withLoyalty).toBeGreaterThan(before);

        // 注册了属性、但表上没有列 → 不报错也不参与（这一档由下面第 3 项当"死权重"拦下来）
        const withMdef = withSettings(
            { combat_power_weight: { hp_max: 0.1, atk: 2, def: 1.5, speed: 1, crit_rate: 5 } },
            () => SpiritBeastService.calculateCombatPower(beast)
        );
        expect(withMdef).toBe(before);

        // 内容里的说明键不能被当成一档属性
        const withNote = withSettings(
            { combat_power_weight: { _comment: '说明', hp_max: 0.1, atk: 2, def: 1.5, speed: 1 } },
            () => SpiritBeastService.calculateCombatPower(beast)
        );
        expect(withNote).toBe(before);
    });

    test('内容声明的每个权重键：注册表认得 + 表上有列（配了不生效的死权重不放行）', () => {
        const registry = ensureStatRegistryLoaded();
        const weights = configLoader.getConfig('spirit_beast_data').settings.combat_power_weight;
        const columns = Object.keys(SpiritBeast.rawAttributes);
        const dead = [];
        for (const key of Object.keys(weights)) {
            if (key.startsWith('_')) continue;   // 说明键
            const def = registry.resolveStatKey(key);
            if (!def) { dead.push(`${key}（不是注册属性）`); continue; }
            if (!columns.includes(def.key)) { dead.push(`${key} → ${def.key}（spirit_beasts 没这一列，加了也算不进战力）`); }
        }
        if (dead.length) {
            throw new Error('这些战力权重是死的：' + dead.join('；')
                + '\n要么把这档属性并进已有的列，要么给 spirit_beasts 加列（改表需授权），别留着当配置真相。');
        }
        expect(dead).toEqual([]);
    });

    test('GM 改灵兽属性的可改集合取自"注册表 ∩ 列"，不再抄字面量清单', () => {
        const src = fs.readFileSync(path.join(serverRoot, 'routes', 'admin_spirit_beast.js'), 'utf8');
        expect(src.includes('SpiritBeast.rawAttributes')).toBe(true);
        expect(src.includes('statRegistry.has')).toBe(true);
        const enumerated = /\[\s*'atk'\s*,\s*'def'/.test(src);
        if (enumerated) throw new Error('routes/admin_spirit_beast.js 又把属性键抄成字面量数组了');
        expect(enumerated).toBe(false);
    });
});
