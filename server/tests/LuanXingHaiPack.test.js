/**
 * 资料片「乱星海市舶」端到端验收
 *
 * 与前两片不同的验收点：这一片**不依赖任何资料片**，用来证明"单独一个目录、纯数据、
 * 不引用别人的属性也能自成一片"；同时它填的是现网真实空档——
 * 暴击伤害 / 闪避 / 吸血 / 悟性 / 突破加成这些属性早就登记在注册表里，
 * 但没有任何内容给出过，玩家堆不到（这一条是 scripts/validate_content.js 的"属性消费面"报告直接指出来的）。
 * 还要验这些属性不只是进了面板，而是真的在战斗结算里被用上。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const CombatResolver = require('../game/combat/CombatResolver');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

const PACK_DIR = path.join(serverRoot, 'content', 'packs', 'luan_xing_hai');
let content;

beforeAll(() => {
    content = loadRealContent(statRegistry);
});

afterEach(() => {
    AttributeService._engine = null;
});

const player = (over = {}) => ({
    id: 91,
    realm: '筑基中期',
    realm_rank: 13,
    spirit_root: null,
    talent_id: null,
    equipped_title_id: null,
    attributes: { luck: 10, wisdom: 10 },
    ...over
});

const sources = (extra = {}) => ({
    equipment: {}, spirit_beast: {}, technique: {}, puppet: null,
    artifact_deep_line: { is_active: false, absolute: {}, percent: {}, effects: {}, breakdown: {} },
    ...extra
});

const resolve = (ply, extra = {}) =>
    AttributeService.calculateFullAttributesAsync(ply, { sourceOverrides: sources(extra) });

const itemOf = (id) => content.dataset('item_data').items.find(i => i.id === id);

describe('乱星海市舶：独立成片', () => {
    test('manifest 不声明依赖，且整个 pack 没用到别的资料片才登记的属性', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
        expect(manifest.id).toBe('luan_xing_hai');
        expect(manifest.depends || []).toEqual([]);

        const foreignStats = ['sword_intent', 'element_resist', 'five_element_power'];
        const used = [];
        for (const file of fs.readdirSync(PACK_DIR).filter(f => f !== 'pack.json')) {
            const parsed = JSON.parse(fs.readFileSync(path.join(PACK_DIR, file), 'utf8'));
            const text = JSON.stringify(parsed);
            for (const stat of foreignStats) if (text.includes(stat)) used.push(`${file}:${stat}`);
        }
        expect(used).toEqual([]);
    });

    test('内容确实被合并进视图（新增 10 件物品、2 部功法、2 门神通、2 张配方、2 张掉落表）', () => {
        expect(content.dataset('item_data').items.filter(i =>
            ['yueguang_jian', 'xuanyu_shan', 'yinsha_ling', 'jupo_pei', 'xingchen_fu',
                'wuzhen_dan', 'juyue_dan', 'xingsha', 'yuehun_shi', 'luanxing_tu_can'].includes(i.id)
        )).toHaveLength(10);
        const techniques = content.dataset('technique_data').techniques;
        expect(techniques.xingdun_jue).toBeTruthy();
        expect(techniques.yuepo_zhenjue).toBeTruthy();
        expect(content.dataset('technique_data').skills.xingchen_yin).toBeTruthy();
        expect(content.dataset('crafting_data').refining_recipes.some(r => r.id === 'craft_xingchen_fu')).toBe(true);
        expect(content.dataset('crafting_data').alchemy_recipes.some(r => r.id === 'craft_wuzhen_dan')).toBe(true);
    });
});

describe('乱星海市舶：给已有内容补属性（只改数据）', () => {
    test('override 过的青莲剑同时保有基础攻击与新加的防御/闪避', () => {
        const base = JSON.parse(
            fs.readFileSync(path.join(serverRoot, 'config', 'item_data.json'), 'utf8')
        ).items.find(i => i.id === 'qinglian_sword');
        const merged = itemOf('qinglian_sword');

        expect(Number(base.effect.atk)).toBeGreaterThan(0);
        expect(Number(merged.effect.atk)).toBe(Number(base.effect.atk));   // 一层深合并，不抹旧字段
        expect(Number(merged.effect.def)).toBe(6);
        expect(Number(merged.effect.dodge)).toBe(2);
    });

    test('override 过的掉落表把基础掉落留下了（数组是整块替换，抄漏一条就是玩家凭空少一份掉落）', () => {
        const base = JSON.parse(
            fs.readFileSync(path.join(serverRoot, 'config', 'drop_data.json'), 'utf8')
        ).drops.find(d => d.monster_id === 'shark');
        const merged = content.dataset('drop_data').drops.find(d => d.monster_id === 'shark');
        const baseItems = base.drops.map(d => d.item_id);
        const mergedItems = merged.drops.map(d => d.item_id);

        for (const item of baseItems) expect(mergedItems).toContain(item);
        expect(mergedItems).toContain('xingsha');
        expect(mergedItems).toContain('yinsha_ling');
    });

    test('两片资料片的掉落都挂在地图上真会刷的怪上（_validateDropMonsters 的正面断言）', () => {
        const spawnable = new Set();
        for (const map of Object.values(content.dataset('map_data').maps)) {
            for (const monster of (map.monsters || [])) spawnable.add(monster.id);
        }
        const orphanTables = content.dataset('drop_data').drops
            .filter(d => d.monster_id && !spawnable.has(d.monster_id))
            .map(d => d.monster_id);
        expect(orphanTables).toEqual([]);
    });
});

describe('乱星海市舶：属性真的进入面板、战力与战斗', () => {
    test('月华剑把暴击率与暴击伤害同时送进解析结果，并抬高战力', async () => {
        const sword = itemOf('yueguang_jian');
        const before = await resolve(player());
        const after = await resolve(player(), { equipment: sword.effect });

        expect(after.final.crit_rate).toBe(12);        // 注册表默认 5 + 装备 7 个百分点
        expect(after.final.crit_damage).toBe(72);      // 默认 50 + 22
        expect(after.breakdown.equipment.crit_damage).toBe(22);
        CombatResolver.initialize(makeRealConfigLoader(content));
        expect(CombatResolver.computePower(after.final, 13))
            .toBeGreaterThan(CombatResolver.computePower(before.final, 13));
    });

    test('装备给的闪避在战斗里真的会闪掉（不是只显示在面板上）', async () => {
        const armor = itemOf('yinsha_ling');
        const { final: defenderStats } = await resolve(player(), { equipment: armor.effect });
        expect(defenderStats.dodge_rate).toBe(7);

        CombatResolver.initialize(makeRealConfigLoader(content));
        const dodged = CombatResolver.computeDamage('player_basic', {
            attackerStats: { atk: 300 }, defenderStats, random: 0.5, roll: () => 0
        });
        expect(dodged.missed).toBe(true);
        expect(dodged.damage).toBe(0);

        const landed = CombatResolver.computeDamage('player_basic', {
            attackerStats: { atk: 300 }, defenderStats, random: 0.5, roll: () => 0.9999
        });
        expect(landed.missed).toBe(false);
        expect(landed.damage).toBeGreaterThan(0);
    });

    test('装备给的暴击伤害按注册表口径进结算（伤害 ×1.72 而不是写死的 1.5×）', async () => {
        const sword = itemOf('yueguang_jian');
        const { final: stats } = await resolve(player(), { equipment: sword.effect });
        CombatResolver.initialize(makeRealConfigLoader(content));

        const inputs = { attackerStats: { atk: 1000, crit_rate: stats.crit_rate, crit_damage: stats.crit_damage },
            defenderStats: { def: 0 }, random: 0.5 };
        const crit = CombatResolver.computeDamage('player_basic', { ...inputs, roll: () => 0 });
        const plain = CombatResolver.computeDamage('player_basic', { ...inputs, roll: () => 0.9999 });

        expect(crit.crit).toBe(true);
        expect(plain.damage).toBe(1000);                                  // 普攻档位：atk - def + 7 - 7
        expect(crit.damage).toBe(Math.floor(1000 * (1 + stats.crit_damage / 100)));
        expect(stats.crit_damage).toBeGreaterThan(50);                    // 装备确实抬高了暴伤，而不是沿写死的 1.5×
    });

    test('资料片神通的格挡与减伤走的是同一张特效词表', () => {
        const skill = content.dataset('technique_data').skills.xingchen_yin;
        CombatResolver.initialize(makeRealConfigLoader(content));

        const blocked = CombatResolver.computeDamage('player_basic', {
            attackerStats: { atk: 400 }, defenderStats: {}, random: 0.5, roll: () => 0,
            defenderSkills: [skill]
        });
        expect(blocked.blocked).toBe(true);
        expect(blocked.damage).toBe(0);

        // 特效键必须都在这张唯一词表里（拼错的键会在启动期就被 _validateSkillEffects 拒绝）
        const skillEffects = require('../game/combat/skillEffects');
        for (const key of Object.keys(skill.effects)) {
            expect(skillEffects.isKnownSkillEffectKey(key)).toBe(true);
        }
        expect(skill.effects.damage_reduction).toBeGreaterThan(0);
        expect(skill.effects.block_chance).toBeGreaterThan(0);
    });

    test('悟真丹给的突破加成落在注册表那条隐藏属性上，面板与突破预览同源', async () => {
        const pill = itemOf('wuzhen_dan');
        expect(pill.effect.breakthrough_bonus).toBe(3);
        const def = statRegistry.resolveStatKey('breakthrough_bonus');
        expect(def).toBeTruthy();
        expect(def.panel.visible).toBe(false);                 // 刻意不进面板，只给突破用
        const before = await resolve(player());
        const { final } = await resolve(player(), { equipment: pill.effect });
        expect(final.breakthrough_bonus - before.final.breakthrough_bonus).toBe(3);
        expect(final.wisdom - before.final.wisdom).toBe(12);   // 装备/丹药给的量原样进到解析结果
    });
});
