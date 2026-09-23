/**
 * 「资料片那八件传说/神话装备，玩家今天真的炼得出来吗」的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么单独一条：`tests/ItemSourceCoverage.test.js` 判的是**内容层**有没有发放路径，
 * 而"配方写得对"与"服务真让玩家学、真扣材料、真发产物"是另一段链 —— 这段只有连库才断得出来：
 *   · `learn_source` 除 default 外没有任何代码读（CraftingService 只 auto-learn `=== 'default'`），
 *     这一轮之前本片把七件法宝写成 `"sect"`，看起来"宗门会教"，实际玩家永远学不会；
 *   · 学不会 → 材料齐了也炼不出 → 那件物品即使配了价格也只是摆设。
 * 所以这条探针量的就是"从内容到玩家背包"那一段，并顺手钉住失败/冷却这些真实约束。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_craft_source.js
 *       探针自建账号 craftprobe01，退出前走级联清理删号；不改仓库里的任何内容。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5099);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 本轮补来源的九张方子（八件资料片物品 + 剑心丹） */
const NEW_RECIPES = [
    'craft_dingkong_mifeng', 'craft_jupo_pei', 'craft_xuanyu_shan', 'craft_qiankun_ruler',
    'craft_yueguang_jian', 'craft_wuxing_banner', 'craft_xuantian_zhanling_sword',
    'craft_jianxin_dan', 'craft_five_qi_pill'
];

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const PlayerRecipe = require('../models/playerRecipe');
    const InventoryService = require('../game/services/InventoryService');
    const EquipmentService = require('../game/services/EquipmentService');
    const CraftingService = require('../game/services/CraftingService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    const content = require('../game/content').contentRegistry();
    const recipes = [...content.dataset('crafting_data').alchemy_recipes, ...content.dataset('crafting_data').refining_recipes];
    const byId = new Map(recipes.map(r => [String(r.id), r]));
    check('C1 九张新方子都在内容里，且 learn_source 全是 default（除 default 外没有代码会教它）',
        NEW_RECIPES.every(id => byId.get(id)?.learn_source === 'default'),
        NEW_RECIPES.map(id => `${id}=${byId.get(id)?.learn_source || '缺配方'}`).join(' | '));

    await PlayerCascadePurge.deleteByUsernames(['craftprobe01']);
    const player = await Player.create({
        username: 'craftprobe01', password: 'not-a-real-hash', nickname: '炼制探针',
        realm: '凡人', realm_rank: 24, exp: 0, spirit_stones: 0,
        hp_current: 5000, mp_current: 500, lifespan_current: 100, lifespan_max: 500,
        attributes: {}, spirit_roots: {}, token_version: 0
    });

    // 自动学默认配方：这一句就是"learn_source 只有 default 生效"的那条通道
    await CraftingService._ensureDefaultRecipes(player.id);
    const learned = new Set((await PlayerRecipe.findAll({ where: { player_id: player.id } })).map(r => r.recipe_id));
    const notLearned = NEW_RECIPES.filter(id => !learned.has(id));
    check('C2 玩家一上线就真的学会了这九张方子（PlayerRecipe 里真有行，不是接口假装）',
        notLearned.length === 0, `已学 ${learned.size} 张｜没学会：${notLearned.join(', ') || '无'}`);

    // 控制跑：靠图谱学的配方不该被自动学会 —— 否则 C2 的判据是空的（"自动学会一切"也能过）
    const scrollRecipe = recipes.find(r => String(r.learn_source || '').startsWith('scroll:'));
    check('C3 控制跑：scroll 类配方不会被自动学会（default 那道门是真的在挑，不是全都发）',
        !!scrollRecipe && !learned.has(scrollRecipe.id),
        `取样配方=${scrollRecipe?.id}｜learn_source=${scrollRecipe?.learn_source}｜已学=${learned.has(scrollRecipe?.id)}`);
    let rejected = null;
    try {
        await CraftingService.craft(player.id, scrollRecipe.id, 1);
    } catch (error) {
        rejected = error.message;
    }
    check('C3b 控制跑：真去点那张没学的配方 → 服务端就拒，理由写在返回里',
        /尚未学会/.test(rejected || ''), `拒绝理由=${rejected || '（竟然放行了）'}`);

    // 把炼制技能抬到 5 级：探针量的是"内容→服务→背包"这条链通不通，不是练级苦不苦。
    // 必须写 skill_exp 而不是直接写 skill_level —— craft 收尾会按 `_calculateSkillLevel(exp)`
    // 重算并把等级同步到该玩家所有配方行（技能是共享的），只写 level 会在第一次炼制后被打回原形
    // （第一版探针就是这样：稀有档炼成之后神话档报"技能等级不足 5 级"）。
    const levelFiveExp = (content.dataset('crafting_data').skill_levels.find(l => l.level === 5) || {}).exp_required;
    check('C3c 抬级用的经验门槛从内容里现读（不写死 700）', Number(levelFiveExp) > 0, `5 级需要 skill_exp=${levelFiveExp}`);
    await PlayerRecipe.update(
        { skill_exp: levelFiveExp, skill_level: 5 },
        { where: { player_id: player.id } }
    );

    const targets = ['craft_dingkong_mifeng', 'craft_xuantian_zhanling_sword'];
    for (const recipeId of targets) {
        const recipe = byId.get(recipeId);
        const productKey = recipe.product.item_key;
        for (const m of recipe.materials) {
            await InventoryService.addItem(player.id, m.item_key, m.quantity, null);
        }
        const stockBefore = await InventoryService.getItemQuantity(player.id, productKey);
        // 掷骰是 `Math.random() < successRate`：钉成 0 就是必成（方向看清楚再钉）
        const realRandom = Math.random;
        Math.random = () => 0;
        let result = null, failure = null;
        try {
            result = await CraftingService.craft(player.id, recipeId, 1);
        } catch (error) {
            failure = error.message;
        } finally {
            Math.random = realRandom;
        }
        const stockAfter = await InventoryService.getItemQuantity(player.id, productKey);
        const left = await Promise.all(recipe.materials.map(m => InventoryService.getItemQuantity(player.id, m.item_key)));
        check(`C4 ${productKey}（${recipe.product.item_key === 'xuantian_zhanling_sword' ? '神话' : '稀有'}档）真能炼出来：产物 +1、材料扣光`,
            !failure && stockAfter - stockBefore === recipe.product.quantity && left.every(q => q === 0),
            `${failure ? `失败：${failure}` : `success=${result?.success} 产量=${result?.quantity}`}｜库存 ${stockBefore}→${stockAfter}｜剩余材料=${left.join('/')}`);

        // 紧接着再点一次：必须撞冷却 —— 否则"炼出来"可能是白送的
        let cooldown = null;
        try {
            await CraftingService.craft(player.id, recipeId, 1);
        } catch (error) {
            cooldown = error.message;
        }
        check(`C5 ${productKey} 第二次立刻被冷却挡住（真在扣冷却，不是无条件发货）`,
            /冷却中/.test(cooldown || ''), `拒绝理由=${cooldown || '（没挡住）'}`);

        if (recipeId === 'craft_dingkong_mifeng') {
            const put = await EquipmentService.equip(player.id, productKey);
            check('C6 炼出来的装备真能穿（到这一步才叫玩家拿得到，而不只是背包里多个键）',
                put?.success === true, `${put?.message || JSON.stringify(put).slice(0, 80)}`);
        }
    }

    const purged = await PlayerCascadePurge.deletePlayers([player.id]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['craftprobe01']); } catch {}
    process.exit(2);
});
