/**
 * 「灵兽战力权重表能不能被资料片扩展」（2026-09-21）
 *
 * 起因是属性键点名普查里一条被我写错的结论：`SpiritBeastService.calculateCombatPower` 早就改成
 * 按 `spirit_beast_data.settings.combat_power_weight` 逐档遍历（内容声明哪档就算哪档），
 * 但我顺着命中行去读时把它当成了"只按四项加权"。读完函数体才发现真正的堵点不在这段代码，
 * 而在**那张表住着的 `settings` 没登记成集合** —— 于是资料片给灵兽加了一档属性（本片的血元），
 * 权重表里就是加不进去：链路只差最后一步，而那一步要求改基础配置文件。
 * 本轮把 `spirit_beast_data.settings` 登记成 map 集合，本片只往权重表补一个 `blood_power` 键。
 *
 * 三件事要证明：
 *   1. 合并是**按键补键**，基础四档一格都不能少（少了等于每只灵兽的战力被悄悄改掉）；
 *   2. 现网灵兽战力**一字不变**（它们没有这一档，取值 0），只有本片带血元的那只会变；
 *   3. 形状写错（把 map 的 override 写成数组）必须启动期点名，不能静默不合并。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry } = require('../game/stats');
const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const SpiritBeastService = require('../game/services/SpiritBeastService');
const { serverRoot } = require('./helpers/realContent');
const { initializeModules } = require('../modules');

const SETTINGS_FILE = path.join(serverRoot, 'content/packs/mo_da_blood_sutra/spirit_beast_data__settings.json');
const BASE_FILE = path.join(serverRoot, 'config/spirit_beast_data.json');

/** 按权重表算一遍战力（与 calculateCombatPower 同一口径：跳过说明键、别名交给注册表） */
function powerWith(weights, values) {
    let total = 0;
    for (const [stat, raw] of Object.entries(weights)) {
        if (stat.startsWith('_')) continue;
        const weight = Number(raw);
        if (!Number.isFinite(weight) || weight === 0) continue;
        const key = statRegistry.resolveStatKey(stat)?.key || stat;
        total += Number(values[key] ?? 0) * weight;
    }
    return Math.round(total);
}

let mergedWeights;
let baseWeights;
let beastTypes;

beforeAll(async () => {
    await initializeModules();          // calculateCombatPower 读的是全局 configLoader
    statRegistry.ensureLoaded?.();
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'),
        packDir: path.join(serverRoot, 'content/packs'),
        statRegistry
    });
    content.load();
    mergedWeights = content.dataset('spirit_beast_data').settings.combat_power_weight;
    baseWeights = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')).settings.combat_power_weight;
    const types = content.dataset('spirit_beast_data').beast_types;
    beastTypes = Array.isArray(types) ? types : Object.values(types);
});

describe('灵兽战力权重表现在能被资料片扩展', () => {
    test('settings 已登记成集合（不登记的话，片里写什么都不会合并）', () => {
        expect(DATASET_SPECS.spirit_beast_data.collections.settings).toEqual({ map: true });
    });

    test('合并是补键不是换表：基础四档一格不少，新档加进来', () => {
        expect(baseWeights).toEqual({ _comment: baseWeights._comment, hp_max: 0.1, atk: 2, def: 1.5, speed: 1 });
        for (const [stat, weight] of Object.entries(baseWeights)) {
            if (stat.startsWith('_')) continue;
            expect(mergedWeights[stat]).toBe(weight);
        }
        expect(mergedWeights.blood_power).toBe(0.8);
        expect(mergedWeights.__content_overridden_by).toEqual(['mo_da_blood_sutra']);
        // 可插拔：这一档只在片里，基础配置文件里一个字都没有
        expect(fs.readFileSync(BASE_FILE, 'utf8')).not.toMatch(/blood_power/);
    });

    test('settings 的其它条目没被顺手改掉（override 只落在 combat_power_weight 上）', () => {
        for (const key of Object.keys(baseWeights).concat(['max_level', 'max_star_level', 'battle_win_exp'])) {
            if (key === 'combat_power_weight' || key === 'blood_power') continue;
        }
        const content = new ContentRegistry({
            configPath: path.join(serverRoot, 'config'),
            packDir: path.join(serverRoot, 'content/packs'),
            statRegistry
        });
        content.load();
        const settings = content.dataset('spirit_beast_data').settings;
        const base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')).settings;
        for (const [key, value] of Object.entries(base)) {
            if (key === 'combat_power_weight') continue;
            expect(settings[key]).toEqual(value);
        }
    });

    test('每一只灵兽按表算的战力：只有本片带血元的那只变，其余一字不变', () => {
        expect(beastTypes.length).toBeGreaterThan(3);
        const changed = [];
        for (const beast of beastTypes) {
            const name = beast.beast_key || beast.id;
            const values = {};
            for (const [key, value] of Object.entries(beast)) {
                if (typeof value === 'number') values[key] = value;
                if (typeof value === 'number' && key.startsWith('base_')) values[key.slice(5)] = value;
            }
            const before = powerWith(baseWeights, values);
            const after = powerWith(mergedWeights, values);
            if (before !== after) changed.push({ name, before, after });
        }
        expect(changed.map(c => c.name)).toEqual(['xue_fu']);
        expect(changed[0].after - changed[0].before).toBe(48);        // base_blood_power 60 × 0.8
    });

    test('真走服务：把属性块里的血元抹掉，这只灵兽的战力就落下 48（证明它进了公式）', () => {
        const block = { hp_max: 700, atk: 120, def: 55, speed: 140, blood_power: 60 };
        const row = (stats) => ({
            beast_key: 'xue_fu', level: 1, star_level: 1, rarity: 'rare', element: 'water',
            hp_max: 700, atk: 120, def: 55, speed: 140,
            [SpiritBeastService.STAT_BLOB_COLUMN]: stats
        });
        const withBlood = SpiritBeastService.calculateCombatPower(row(block));
        const { blood_power, ...withoutBloodStats } = block;
        const without = SpiritBeastService.calculateCombatPower(row(withoutBloodStats));
        expect(withBlood - without).toBe(48);
        expect(blood_power).toBe(60);
    });

    test('控制跑：map 集合的 override 写成数组时，启动期当场点名（不会静默不合并）', () => {
        const real = fs.readFileSync(SETTINGS_FILE, 'utf8');
        try {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
                dataset: 'spirit_beast_data', into: 'settings',
                override: [{ id: 'combat_power_weight', blood_power: 0.8 }]
            }), 'utf8');
            const probe = new ContentRegistry({
                configPath: path.join(serverRoot, 'config'),
                packDir: path.join(serverRoot, 'content/packs'),
                statRegistry
            });
            let error = null;
            try { probe.load(); } catch (e) { error = e; }
            expect(error).not.toBeNull();
            expect(error.message).toMatch(/combat_power_weight|不存在/);
        } finally {
            fs.writeFileSync(SETTINGS_FILE, real, 'utf8');
        }
        expect(fs.readFileSync(SETTINGS_FILE, 'utf8')).toBe(real);
    });
});
