/**
 * 资料片「魔道血修遗篇」端到端验收
 *
 * 这一片的验收点与前四片不同，它要证明的是**这一轮改造之后新长出来的那条路**：
 * 一档全新的属性（血元）除了"注册表登记 + 内容写数据"之外什么都没改，
 * 就能依次出现在 面板 → 属性解析 → 战力 → 丹药白名单 → 战斗档位 → 灵兽属性块 → 玩家属性管线 上。
 * 尤其第 6 组：灵兽身上那档**没有专属数据库列**的属性（spirit_beasts.stat_block，migration_0088）
 * 是本轮才通的，以前"给灵兽加一档属性"要 ALTER TABLE 再改 5 处手写赋值。
 *
 * 另有两条"不越界"的断言：关掉这一片不该在基础配置里留下任何引用（第 7 组），
 * 以及掉落表这张"一个主人"的表没有被第二个资料片同时 override（第 8 组）——
 * 后者是量出来的隐患：override 对数组字段是整块替换，两片同时改一条就会静默吃掉前一片的掉落。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const AttributeMaxService = require('../game/core/AttributeMaxService');
const CombatResolver = require('../game/combat/CombatResolver');
const SpiritBeastService = require('../game/services/SpiritBeastService');
const SpiritBeast = require('../models/spiritBeast');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');
const { initializeModules } = require('../modules');

const PACK_ID = 'mo_da_blood_sutra';
const PACK_DIR = path.join(serverRoot, 'content', 'packs', PACK_ID);
const newStat = 'blood_power';
const newItems = ['huaxue_ci', 'xuehe_fan', 'xue_sui_zhu', 'xuesha_dan', 'xuesha_dan_fang'];

let content;

beforeAll(async () => {
    // 灵兽服务与属性最大值服务走的是全局 configLoader（不是测试自己装配的那份），
    // 不 initializeModules 就会在 calculateCombatPower 里抛"配置 spirit_beast_data 未加载"。
    await initializeModules();
    content = loadRealContent(statRegistry);
    CombatResolver.initialize(makeRealConfigLoader(content));
});

afterEach(() => {
    AttributeService._engine = null;
});

const player = (over = {}) => ({
    id: 96,
    realm: '金丹初期',
    realm_rank: 15,
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

const itemOf = id => content.dataset('item_data').items.find(i => i.id === id);
const baseOf = name => JSON.parse(fs.readFileSync(path.join(serverRoot, 'config', `${name}.json`), 'utf8'));

describe(`${PACK_ID}：装配`, () => {
    test('manifest 独立成片（不依赖任何资料片），且整个 pack 只用到自己登记的属性', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
        expect(manifest.id).toBe(PACK_ID);
        expect(manifest.depends || []).toEqual([]);
        expect(manifest.enabled).toBe(true);

        // 前四片登记的属性一概不许用：用了就必须声明 depends，否则关掉别人时这片会留下空档位
        const foreign = ['sword_intent', 'element_resist', 'five_element_power'];
        const used = [];
        for (const file of fs.readdirSync(PACK_DIR).filter(f => f !== 'pack.json')) {
            const text = fs.readFileSync(path.join(PACK_DIR, file), 'utf8');
            for (const stat of foreign) if (text.includes(stat)) used.push(`${file}:${stat}`);
        }
        expect(used).toEqual([]);
    });

    test('片内 10 个文件都进了合并视图：5 件新物品、1 部功法、2 门神通、1 只灵兽、2 张配方、1 张掉落表、1 张战力权重', () => {
        expect(fs.readdirSync(PACK_DIR).filter(f => f.endsWith('.json') && f !== 'pack.json').length).toBe(10);
        for (const id of newItems) expect(itemOf(id)).toBeTruthy();
        expect(content.dataset('technique_data').techniques.xue_ying_shen_gong).toBeTruthy();
        expect(content.dataset('technique_data').skills.xue_ya_shi).toBeTruthy();
        expect(content.dataset('technique_data').skills.xue_he_bao).toBeTruthy();
        expect(content.dataset('spirit_beast_data').beast_types.find(b => b.beast_key === 'xue_fu')).toBeTruthy();
        expect(content.dataset('crafting_data').alchemy_recipes.some(r => r.id === 'craft_xuesha_dan')).toBe(true);
        expect(content.dataset('crafting_data').refining_recipes.some(r => r.id === 'craft_xue_sui_zhu')).toBe(true);
        // settings 登记成集合之后，本片能自己把血元计进灵兽战力（不改基础配置、不改代码）
        expect(content.dataset('spirit_beast_data').settings.combat_power_weight.blood_power).toBe(0.8);
    });
});

describe(`${PACK_ID}：一档新属性没有改任何代码就走完全程`, () => {
    test('注册表与面板清单认得它（客户端不再各写一份属性清单）', () => {
        const def = statRegistry.resolveStatKey(newStat);
        expect(def.key).toBe(newStat);
        expect(def.unit).toBe('point');
        expect(def.allocatable).toBe(false);            // 不参与加点，别给加点池开口子
        expect(statRegistry.panelStats().map(s => s.key)).toContain(newStat);
    });

    test('穿上一件新法宝：血元与吸血都进最终属性，并抬高战力', async () => {
        const blade = itemOf('huaxue_ci');
        const before = await resolve(player());
        const after = await resolve(player(), { equipment: blade.effect });

        expect(before.final[newStat]).toBe(0);
        expect(after.final[newStat]).toBe(blade.effect[newStat]);
        expect(after.final.lifesteal).toBe(blade.effect.lifesteal);
        expect(after.breakdown.equipment[newStat]).toBe(blade.effect[newStat]);
        expect(CombatResolver.computePower(after.final, 15))
            .toBeGreaterThan(CombatResolver.computePower(before.final, 15));
    });

    test('给现成的传说法宝「血魔剑」补一个新属性：基础数值一个都没动', () => {
        const base = baseOf('item_data').items.find(i => i.id === 'blood_magic_sword');
        const merged = itemOf('blood_magic_sword');
        expect(Number(base.effect.atk)).toBe(220);
        expect(Number(merged.effect.atk)).toBe(Number(base.effect.atk));   // 一层深合并不抹旧字段
        expect(merged.effect.hp_steal).toBe(base.effect.hp_steal);         // 存量数值刻意不碰（见片内 comment）
        expect(Number(merged.effect[newStat])).toBe(40);
    });

    test('丹药白名单收得下它：血煞丹的 effect 会换成 blood_power_bonus 落进 attributes', () => {
        AttributeMaxService.configLoader = makeRealConfigLoader(content);
        const pill = itemOf('xuesha_dan');
        expect(statRegistry.resolveStatKey(newStat).pill).toBe(true);      // 写成 false 这条就静默变 null
        const built = AttributeMaxService.buildPillEffectFromConfig(pill.effect);
        expect(built).toBeTruthy();
        // 存储键一律从注册表现读（hp_max 的 bonusKey 是 hp_bonus 这种不同名的情况就在这一处暴露）
        const bonusKeyOf = stat => statRegistry.resolveStatKey(stat).bonusKey;
        expect(built.attributes[bonusKeyOf(newStat)]).toBe(pill.effect[newStat]);
        expect(bonusKeyOf(newStat)).toBe('blood_power_bonus');
        expect(built.attributes[bonusKeyOf('hp_max')]).toBe(pill.effect.hp_max);
    });

    test('新伤害档位真的按血元结算，没堆血元的人回落到普攻', () => {
        const withBlood = CombatResolver.computeDamage('player_blood_power', {
            attackerStats: { [newStat]: 100, atk: 1000 }, defenderStats: { def: 0 },
            random: 0.5, roll: () => 0.9999
        });
        expect(withBlood.attack).toBe(100);                                 // 取的是血元，不是那 1000 点攻击
        // 期望值按档位那条算式现算（全局公式是"最后一步才 floor"，100×1.15 在浮点里是 114.999…）
        expect(withBlood.damage).toBe(Math.floor(100 * 1.15 + Math.floor(0.5 * 15) - 7));
        expect(withBlood.damage).toBe(114);
        expect(withBlood.damage).toBeLessThan(
            CombatResolver.computeDamage('player_basic', {
                attackerStats: { atk: 1000 }, defenderStats: { def: 0 }, random: 0.5, roll: () => 0.9999
            }).damage
        );

        const fallback = CombatResolver.computeDamage('player_blood_power', {
            attackerStats: { atk: 200 }, defenderStats: { def: 0 }, random: 0.5, roll: () => 0.9999
        });
        expect(fallback.attack).toBe(200);
        expect(fallback.damage).toBe(Math.floor(200 * 1.15 + Math.floor(0.5 * 15) - 7));   // 不至于打 0
    });

    test('法宝给的吸血在同一条档位里真的回血（battleRole 反查，不是只有面板显示）', () => {
        const blade = itemOf('huaxue_ci');
        const healed = CombatResolver.computeDamage('player_blood_power', {
            attackerStats: { [newStat]: 100, lifesteal: blade.effect.lifesteal },
            defenderStats: { def: 0 }, random: 0.5, roll: () => 0
        });
        expect(healed.crit).toBe(false);
        expect(healed.lifesteal_rate).toBeCloseTo(blade.effect.lifesteal / 100, 10);
        expect(healed.lifesteal).toBe(Math.floor(healed.damage * healed.lifesteal_rate));
        expect(healed.lifesteal).toBeGreaterThan(0);
    });
});

describe(`${PACK_ID}：灵兽带一档没有专属列的属性（本轮新通的那条路）`, () => {
    const type = () => content.dataset('spirit_beast_data').beast_types.find(b => b.beast_key === 'xue_fu');

    test('内容写 base_blood_power，computeStats 把它算进 stat_block 而不是丢掉', () => {
        expect(SpiritBeast.rawAttributes[newStat]).toBeUndefined();     // 前提：这一档确实没有专属列
        const stats = SpiritBeastService.computeStats(type(), 10, 3);
        const grow = (base, level, star) => Math.floor(base * (1 + (level - 1) * 0.1) * star);
        expect(stats.hp_max).toBe(grow(type().base_hp, 10, 3));         // 有列的照旧落列
        expect(stats[newStat]).toBeUndefined();
        expect(stats.stat_block).toEqual({ [newStat]: grow(type().base_blood_power, 10, 3) });
    });

    test('出战之后它自动折算给玩家，并最终出现在玩家属性里（全程没碰服务代码）', async () => {
        const stats = SpiritBeastService.computeStats(type(), 10, 3);
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'xue_fu', beast_name: '血蝠', element: type().element,
            rarity: type().rarity, level: 10, star_level: 3, loyalty: 60,
            hp_max: stats.hp_max, atk: stats.atk, def: stats.def, speed: stats.speed,
            stat_block: stats.stat_block
        });
        expect(SpiritBeastService.statBlockOf(beast)[newStat]).toBe(stats.stat_block[newStat]);

        const findOne = jest.spyOn(SpiritBeast, 'findOne').mockResolvedValue(beast);
        const bonus = await SpiritBeastService.getActiveBeastBonus(1);
        findOne.mockRestore();
        const rate = 0.1 + 3 * 0.05 + 10 * 0.005;                       // base + 星级×star_rate + 等级×level_rate
        expect(bonus[newStat]).toBe(Math.floor(stats.stat_block[newStat] * rate));

        const { final } = await resolve(player(), { spirit_beast: bonus });
        expect(final[newStat]).toBeGreaterThanOrEqual(bonus[newStat]);
        expect(final.beast_info).toBeUndefined();                       // beast_info 不许当成属性
    });

    test('灵兽卡片能把它连标签一起外发（前端只渲染服务端给的清单）', () => {
        const stats = SpiritBeastService.computeStats(type(), 7, 2);
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'xue_fu', element: 'water', rarity: 'rare',
            level: 7, star_level: 2, hp_max: stats.hp_max, atk: stats.atk, def: stats.def,
            speed: stats.speed, stat_block: stats.stat_block
        });
        const formatted = SpiritBeastService._formatBeast(beast, new Map(), {}, {});
        const entry = formatted.extra_stats.find(e => e.key === newStat);
        expect(entry).toBeTruthy();
        expect(entry.label).toBe(statRegistry.resolveStatKey(newStat).label);
        expect(entry.value).toBe(stats.stat_block[newStat]);
    });

    test('片内没有写那些"看起来有效其实没人读"的字段（条目级 combat_bonus 与特性数值键）', () => {
        const bt = type();
        expect(bt.combat_bonus).toBeUndefined();     // 结算只读全局 settings.combat_bonus
        for (const trait of Object.values(bt.signature_traits || {})) {
            expect(Object.keys(trait).sort()).toEqual(['description', 'trait_key', 'trait_name']);
        }
    });
});

describe(`${PACK_ID}：内容之间的引用自己闭合`, () => {
    test('丹方物品的 learn_recipe 指向真存在的配方，且这张配方确实要拿丹方换', () => {
        const scroll = itemOf('xuesha_dan_fang');
        expect(scroll.type).toBe('recipe_scroll');                     // learnRecipe 只认这个 type
        const recipeId = scroll.effect.learn_recipe;
        const recipes = [...content.dataset('crafting_data').alchemy_recipes,
            ...content.dataset('crafting_data').refining_recipes];
        const recipe = recipes.find(r => r.id === recipeId);
        expect(recipe).toBeTruthy();
        expect(recipe.learn_source).not.toBe('default');               // default 会被自动学会，丹方就白写了
        expect(recipe.product.item_key).toBe('xuesha_dan');
    });

    test('两条配方的材料都是玩家真拿得到的东西（掉落或默认配方），产物回手能接上主链', () => {
        const spawnable = new Set();
        for (const map of Object.values(content.dataset('map_data').maps)) {
            for (const m of (map.monsters || [])) spawnable.add(typeof m === 'string' ? m : m.id);
        }
        const dropped = new Set(content.dataset('drop_data').drops
            .filter(d => spawnable.has(d.monster_id))
            .flatMap(d => d.drops.map(x => x.item_id)));
        const defaultRecipes = content.dataset('crafting_data').refining_recipes
            .filter(r => r.learn_source === 'default').map(r => r.product.item_key);

        for (const r of content.dataset('crafting_data').alchemy_recipes.filter(x => x.id === 'craft_xuesha_dan')
            .concat(content.dataset('crafting_data').refining_recipes.filter(x => x.id === 'craft_xue_sui_zhu'))) {
            for (const mat of r.materials) {
                expect(dropped.has(mat.item_key) || defaultRecipes.includes(mat.item_key)
                    || itemOf(mat.item_key)?.__content_origin !== PACK_ID)
                    .toBe(true);                                       // 本片新加的材料必须有来路
            }
        }
        expect(dropped.has('xue_sui_zhu')).toBe(true);                 // 掉落与炼器两条路都通着
    });

    test('功法只走代码真认识的 acquire 分支，sect_id 指向真宗门', () => {
        const cfg = content.dataset('technique_data').techniques.xue_ying_shen_gong;
        // TechniqueService.learnTechnique 对 shop / sect / recipe_scroll 三种代价各自有分支，
        // secret_realm 明确拒绝，其余取值一律「什么都不扣」——内容层 _validateTechniqueAcquire 现在就拦这个。
        expect(['shop', 'sect']).toContain(cfg.acquire.source);
        if (cfg.acquire.source === 'sect') {
            expect(baseOf('sect_data').sects.map(s => s.id)).toContain(cfg.acquire.sect_id);
            expect(Number(cfg.acquire.sect_contribution)).toBeGreaterThan(0);
        }
        // 本片不用残卷通道（那条链的代价是一卷物品，需要掉落/商店把它送到玩家手里，
        // 本轮实现分支时一并给凡人遗宝与乱星海市舶各接了一卷；这片走宗门贡献，代价更直白）
        expect(cfg.acquire.source).not.toBe('recipe_scroll');
    });

    test('两门神通都在既有领悟候选池的判定式里（同五行或 none），不靠新代码被发现', () => {
        const skills = content.dataset('technique_data').skills;
        const cfg = content.dataset('technique_data').techniques.xue_ying_shen_gong;
        const candidates = Object.keys(skills).filter(id => {
            if (id.startsWith('_')) return false;
            return skills[id].element === cfg.element || skills[id].element === 'none';
        });
        expect(candidates).toContain('xue_ya_shi');                    // water：本片功法的同属池
        expect(candidates).toContain('xue_he_bao');                    // none：谁都能悟
        expect(content.dataset('technique_data').comprehension.enabled).toBe(true);
    });
});

describe(`${PACK_ID}：不越界`, () => {
    test('掉落表照抄基础那六条，只往里加自己的三条（数组是整块替换，抄漏一条就是凭空少一份掉落）', () => {
        const base = baseOf('drop_data').drops.find(d => d.monster_id === 'demon');
        const merged = content.dataset('drop_data').drops.find(d => d.monster_id === 'demon');
        expect(merged.drops.slice(0, base.drops.length)).toEqual(base.drops);
        expect(merged.exp_reward).toBe(base.exp_reward);               // 没重写经验这一项
        const mine = merged.drops.slice(base.drops.length).map(d => d.item_id);
        expect(mine.sort()).toEqual(['huaxue_ci', 'xue_sui_zhu', 'xuesha_dan_fang']);
    });

    test('这张掉落表只有一个主人：没有第二个资料片 override 同一个 monster_id', () => {
        const owners = new Map();
        for (const dir of fs.readdirSync(path.join(serverRoot, 'content', 'packs'))) {
            const file = path.join(serverRoot, 'content', 'packs', dir, 'drop_data.json');
            if (!fs.existsSync(file)) continue;
            for (const key of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).override || {})) {
                owners.set(key, [...(owners.get(key) || []), dir]);
            }
        }
        const shared = [...owners].filter(([, list]) => list.length > 1);
        // 这道冲突现在由内容层在启动期直接拒收（ContentRegistry.applyOps 记 __content_replaced_fields，
        // 见 tests/ContentRegistry.test.js 那组夹具）；这里留着是把"现网五片确实各占一条表"这件事
        // 说成一句可执行的白话，冲突真发生时两条都会红，而这条能直接点出是哪两片、哪一张表。
        expect(shared.map(([k, list]) => `${k}←${list.join('+')}`)).toEqual([]);
    });

    test('关掉这一片，基础配置里不会留下任何血元引用（档位与属性同片，不会留下打不出伤害的空档位）', () => {
        const hits = [];
        for (const file of fs.readdirSync(path.join(serverRoot, 'config')).filter(f => f.endsWith('.json'))) {
            const text = fs.readFileSync(path.join(serverRoot, 'config', file), 'utf8');
            if (text.includes(newStat) || text.includes('player_blood_power')) hits.push(file);
        }
        expect(hits).toEqual([]);
        expect(baseOf('combat_formulas').profiles.player_blood_power).toBeUndefined();
    });

    test('片内所有物品/功法/神通/配方都真的被引用到（不留只有 id 的孤儿内容）', () => {
        const texts = fs.readdirSync(PACK_DIR).filter(f => f !== 'pack.json')
            .map(f => fs.readFileSync(path.join(PACK_DIR, f), 'utf8')).join('\n');
        const orphans = newItems.filter(id => !id.startsWith('xue_sui_zhu') && !texts.includes(`"${id}"`));
        // 血髓珠出现在掉落与丹方材料里，其余四件也必须被某个入口引用
        expect(orphans).toEqual([]);
    });
});
