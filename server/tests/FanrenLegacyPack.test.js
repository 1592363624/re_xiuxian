/**
 * 资料片「凡人遗宝」端到端验收
 *
 * 这个文件就是本次架构改造的验收标准本身：
 * 只往 server/content/packs 里放数据，不碰任何 Service / 路由 / 前端标签表，
 * 新属性与新内容就应该自动出现在面板、加点、丹药、战力、战斗公式与掉落校验里。
 * 任何一处不生效，说明扩展性承诺没有兑现。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry, ensureStatRegistryLoaded } = require('../game/stats');
const { StatRegistry } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const AttributeMaxService = require('../game/core/AttributeMaxService');
const CombatResolver = require('../game/combat/CombatResolver');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

let content;
const registry = statRegistry;

beforeAll(() => {
    // 与生产启动流程一致：内容层把"基础 + 资料片"的合并词表装进全局注册中心，
    // AttributeService / AttributeMaxService / CombatResolver 之后取到的都是这一份
    content = loadRealContent(statRegistry);
});

afterEach(() => {
    AttributeService._engine = null;
});

describe('资料片内容被发现', () => {
    test('fanren_legacy 被目录扫描自动发现并启用', () => {
        const pack = content.status().packs.find(p => p.id === 'fanren_legacy');
        expect(pack).toMatchObject({ enabled: true, version: '1.0.0' });
        expect(pack.datasets).toEqual(expect.arrayContaining([
            'combat_formulas', 'drop_data', 'item_data', 'spirit_beast_data', 'stat_definitions', 'technique_data'
        ]));
    });

    test('新属性进入注册表：面板/加点/丹药/祭炼/战力/战斗角色一次全有', () => {
        expect(registry.has('sword_intent')).toBe(true);
        expect(registry.has('element_resist')).toBe(true);

        const panel = registry.panelStats();
        expect(panel.find(s => s.key === 'sword_intent')).toMatchObject({ label: '剑意', icon: '🗡️' });
        expect(panel.find(s => s.key === 'element_resist').suffix).toBe('%');

        expect(registry.allocatableMap().sword_intent).toBe('sword_intent_bonus');
        expect(registry.pillEffectMap().sword_intent).toBe('sword_intent_bonus');
        expect(registry.refineRateMap().sword_intent).toBe(0.05);
        expect(registry.battleRoleIndex().damage_sword).toEqual(['sword_intent']);
        // 百分比型属性不参与"全属性加成"通配，避免一件装备白送百分点抗性
        expect(registry.get('element_resist').unit).toBe('percent');
    });

    test('新物品与新功法/灵兽/掉落被合并进配置视图', () => {
        const items = content.dataset('item_data').items;
        const sword = items.find(i => i.id === 'qingzhu_fengyun_sword');
        expect(sword.effect).toMatchObject({ atk: 120, matk: 60, sword_intent: 45, crit: 6 });

        expect(content.dataset('technique_data').techniques.hunyun_jianyi_jue).toBeTruthy();
        expect(content.dataset('spirit_beast_data').beast_types.map(b => b.beast_key)).toEqual(
            expect.arrayContaining(['yue_jiao', 'ti_hun'])
        );
        // 掉落表必须挂在地图上真会刷的怪上（以前这里挂的是自造的 shijin_gu_swarm / yue_jiao，
        // 玩家永远打不到，物品也就永远拿不到 —— _validateDropMonsters 现在会拦这种事）
        const demonKing = content.dataset('drop_data').drops.find(d => d.monster_id === 'demon_king');
        expect(demonKing).toBeTruthy();
        expect(demonKing.drops.map(d => d.item_id)).toEqual(
            expect.arrayContaining(['shijin_gu', 'qingzhu_fengyun_sword', 'qibao_jiayi', 'ningcui_dan'])
        );
    });

    test('已有物品被 override 补字段：木剑现在带法攻，且原有 atk 未被抹掉', () => {
        const sword = content.dataset('item_data').items.find(i => i.id === 'wooden_sword');
        expect(sword.effect).toEqual({ atk: 5, matk: 3 });
    });

    test('资料片还能加神通：technique_data__skills.json 写进第二个集合，档位指向本资料片的属性', () => {
        const merged = content.dataset('technique_data');
        const skills = merged.skills;
        expect(skills.sword_qi_slash).toMatchObject({ element: 'none', damage_profile: 'player_sword_intent' });
        expect(skills.qingyuan_sword_light).toMatchObject({ element: 'metal', damage_profile: 'player_sword_intent' });
        // 基础神通不能因为资料片加了同名数据集文件就被顶掉
        expect(skills.flame_burst).toBeTruthy();
        // 档位与它依赖的属性都来自本资料片：关掉 pack 这两条会一起消失，不留空引用
        expect(content.dataset('combat_formulas').profiles.player_sword_intent)
            .toMatchObject({ attack_stat: 'sword_intent', attack_fallback_stat: 'atk' });
        expect(content.dataset('combat_formulas').profiles.player_basic).toBeTruthy();
    });

    test('真实配置 + 资料片整体装配不抛错（掉落引用、效果键名、属性声明都过了启动期校验）', () => {
        expect(() => loadRealContent(new StatRegistry())).not.toThrow();
    });
});

describe('资料片属性真的参与计算', () => {
    const player = (over = {}) => ({
        id: 7,
        realm: '元婴初期',
        realm_rank: 21,
        spirit_root: '金',
        talent_id: null,
        equipped_title_id: null,
        attributes: { luck: 20, wisdom: 20 },
        ...over
    });

    // 单元测试不连库：把所有需要查库的来源都显式给定（空的或指定的），
    // 这样测试测的是"属性怎么算"，而不是"能不能连上 MySQL"
    const sources = (extra = {}) => ({
        equipment: {}, spirit_beast: {}, technique: {}, puppet: null,
        artifact_deep_line: { is_active: false, absolute: {}, percent: {}, effects: {}, breakdown: {} },
        ...extra
    });

    const resolve = (ply, extra = {}) =>
        AttributeService.calculateFullAttributesAsync(ply, { sourceOverrides: sources(extra) });

    beforeEach(() => {
        AttributeService.initialize(makeRealConfigLoader(content));
        CombatResolver.initialize(makeRealConfigLoader(content));
        AttributeService._engine = null;
    });

    test('装上青竹蜂云剑后，剑意/法攻/暴击同时进入面板、明细与战力', async () => {
        const sword = content.dataset('item_data').items.find(i => i.id === 'qingzhu_fengyun_sword');
        const before = await resolve(player());

        // 装备加成形状与 EquipmentService.getEquipmentBonus 的产出一致：它对 effect 的属性键是泛化的
        const after = await resolve(player(), { equipment: sword.effect });

        expect(after.final.sword_intent).toBe(45);
        expect(after.final.matk).toBe(60);
        expect(after.final.crit_rate).toBe(11);          // 基础 5% + 装备 6 个百分点
        expect(after.breakdown.equipment.sword_intent).toBe(45);
        expect(after.final.atk).toBeGreaterThan(before.final.atk);

        const powerBefore = CombatResolver.computePower(before.final, 21);
        const powerAfter = CombatResolver.computePower(after.final, 21);
        expect(powerAfter).toBeGreaterThan(powerBefore);
    });

    test('剑意伤害公式由 combat_formulas 声明，不需要新增战斗代码', async () => {
        const sword = content.dataset('item_data').items.find(i => i.id === 'qingzhu_fengyun_sword');
        const { final: stats } = await resolve(player(), { equipment: sword.effect });

        const strike = CombatResolver.computeDamage('player_sword_intent', {
            attackerStats: stats,
            defenderStats: { def: 40 },
            random: 0.5,
            // 解析出的属性里带真实暴击率（默认 5%），不注入随机源这条断言就会偶发失败
            roll: () => 0.9999
        });
        // 45 * 1.2 - 40 * 0.5 + 7 - 7 = 34
        expect(strike.attack).toBe(45);
        expect(strike.damage).toBe(34);
        expect(strike.crit).toBe(false);

        // 面板上的暴击率现在真的会放大这一记：暴击伤害默认 +50%
        const crit = CombatResolver.computeDamage('player_sword_intent', {
            attackerStats: stats,
            defenderStats: { def: 40 },
            random: 0.5,
            roll: () => 0
        });
        expect(crit.crit).toBe(true);
        expect(crit.damage).toBe(51);   // 34 × (1 + 50/100)

        // 没有剑意的角色走 attack_fallback_stat，退回物理攻击而不是打出 0 伤害
        const plain = CombatResolver.computeDamage('player_sword_intent', {
            attackerStats: { atk: 100 },
            defenderStats: { def: 0 },
            random: 0
        });
        expect(plain.damage).toBe(113);   // 100 * 1.2 - 7
    });

    test('凝翠丹的 matk 永久加成被丹药白名单接受（白名单来自注册表，不是一处硬编码）', () => {
        const pill = content.dataset('item_data').items.find(i => i.id === 'ningcui_dan');
        AttributeMaxService.initialize(makeRealConfigLoader(content));

        const effect = AttributeMaxService.getPillMaxIncreaseEffect(pill.id);
        expect(effect).toEqual({
            type: 'permanent_max_increase',
            attributes: { matk_bonus: 60, mp_bonus: 400, hp_bonus: 200 }
        });

        const next = AttributeMaxService.applyPillBonusToAttributes({}, effect);
        expect(next.matk_bonus).toBe(60);
    });

    test('剑心丹直接提升剑意，且剑意加成会进面板', () => {
        AttributeMaxService.initialize(makeRealConfigLoader(content));
        const effect = AttributeMaxService.getPillMaxIncreaseEffect('jianxin_dan');
        expect(effect.attributes).toEqual({ sword_intent_bonus: 120, atk_bonus: 80 });

        const next = AttributeMaxService.applyPillBonusToAttributes({}, effect);
        const resolved = AttributeService.calculateFullAttributes(player({ attributes: next }));
        expect(resolved.final.sword_intent).toBe(120);
    });

    test('混元剑意诀的每层加成键都被属性系统认识', () => {
        const technique = content.dataset('technique_data').techniques.hunyun_jianyi_jue;
        for (const key of Object.keys(technique.bonuses)) {
            expect([key, registry.resolveStatKey(key) !== null]).toEqual([key, true]);
        }
    });
});
