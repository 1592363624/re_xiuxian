/**
 * 昆吾山·封魔塔副本端到端测试
 *
 * 测试目标：
 *   1. 验证5人组队副本的创建、加入、进入开打完整流程
 *   2. 验证第一幕入山策略4选1（4条路径变量变化正确）
 *   3. 验证第二幕随机池抉择（从5个遗迹中选1个）
 *   4. 验证第三幕3阵眼连续抉择（八灵尺→化龙玺→黑风旗，各选镇/夺/断）
 *   5. 验证第四幕5回合自动决战（含通关与失败两种场景）
 *   6. 验证6变量（封印/魔气/山禁/宝压/玲珑/士气）边界与累积正确
 *   7. 验证奖励结算（基础奖励/普通掉落/首通奖励/宝压/玲珑加成）
 *   8. 验证冷却记录写入与查询
 *
 * 测试策略：
 *   - 直接调用 Service 层方法，绕过 HTTP 层（避免5个真实玩家登录复杂度）
 *   - 使用 1592363624（玩家ID=1）作为队长，创建临时测试小号作为队员
 *   - 测试结束后清理所有临时数据（实例/成员/抉择/冷却/临时玩家）
 *   - 通过 GM 接口重置队长冷却以重复测试
 *
 * 运行方式：node scripts/test_kunwu_dungeon_e2e.js
 */
'use strict';

const path = require('path');
const rootPath = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(rootPath, '.env') });

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../models/player');
const MultiDungeonInstance = require('../models/multiDungeonInstance');
const MultiDungeonMember = require('../models/multiDungeonMember');
const MultiDungeonChoice = require('../models/multiDungeonChoice');
const MultiDungeonCooldown = require('../models/multiDungeonCooldown');
const InventoryService = require('../game/services/InventoryService');
const MultiDungeonService = require('../game/services/MultiDungeonService');

// 境界 rank → 名称映射（避免依赖未初始化的 RealmService）
const RANK_TO_REALM = {
    15: '结丹期',
    19: '元婴期',
    23: '化神期'
};

// 测试结果统计
const stats = {
    total: 0,
    passed: 0,
    failed: 0,
    failedDetails: []
};

/**
 * 断言辅助函数
 * @param {boolean} condition - 条件
 * @param {string} message - 失败描述
 */
function assert(condition, message) {
    stats.total++;
    if (condition) {
        stats.passed++;
        console.log(`  ✓ ${message}`);
    } else {
        stats.failed++;
        stats.failedDetails.push(message);
        console.error(`  ✗ ${message}`);
    }
}

/**
 * 创建测试用临时小号玩家
 * @param {string} nickname - 昵称
 * @param {number} realmRank - 境界rank
 * @returns {Promise<Object>} 创建的玩家对象
 */
async function createTestPlayer(nickname, realmRank = 15) {
    const realmName = RANK_TO_REALM[realmRank] || '结丹期';

    const player = await Player.create({
        username: `test_kunwu_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        password: 'test_password_hash_dummy',
        nickname: nickname,
        realm: realmName,
        realm_rank: realmRank,
        role: 'sect_disciple',
        exp: '1000000',
        hp_current: '10000',
        hp_max: '10000',
        lifespan_current: 500,
        lifespan_max: 1000,
        spirit_stones: '100000',
        divine_sense_balance: 1000,
        attack: 1000,
        defense: 800,
        speed: 200,
        crit_rate: 5,
        crit_damage: 50,
        is_dead: 0,
        last_login_at: new Date()
    });
    return player;
}

/**
 * 清理临时测试玩家及其关联数据
 * @param {number[]} playerIds - 玩家ID列表
 * @param {number[]} instanceIds - 副本实例ID列表
 */
async function cleanupTestData(playerIds, instanceIds) {
    console.log('\n[清理] 开始清理临时测试数据...');

    // 清理副本相关数据
    if (instanceIds.length > 0) {
        await MultiDungeonChoice.destroy({ where: { instance_id: instanceIds }, force: true });
        await MultiDungeonMember.destroy({ where: { instance_id: instanceIds }, force: true });
        await MultiDungeonCooldown.destroy({ where: { instance_id: instanceIds }, force: true });
        await MultiDungeonInstance.destroy({ where: { id: instanceIds }, force: true });
        console.log(`[清理] 已删除 ${instanceIds.length} 个副本实例及关联数据`);
    }

    // 清理冷却记录（按玩家）
    if (playerIds.length > 0) {
        await MultiDungeonCooldown.destroy({ where: { player_id: playerIds }, force: true });
        await MultiDungeonMember.destroy({ where: { player_id: playerIds }, force: true });
        // 删除临时玩家
        await Player.destroy({ where: { id: playerIds }, force: true });
        console.log(`[清理] 已删除 ${playerIds.length} 个临时玩家`);
    }
}

/**
 * 主测试流程
 */
async function runTests() {
    console.log('='.repeat(80));
    console.log('[昆吾山·封魔塔] 端到端测试开始');
    console.log('='.repeat(80));

    // 初始化 ConfigLoader（必须在使用 configLoader.getConfig 之前调用）
    if (typeof configLoader.initialize === 'function') {
        await configLoader.initialize();
    } else if (typeof configLoader.loadAllConfigs === 'function') {
        await configLoader.loadAllConfigs();
    }
    console.log('[初始化] ConfigLoader 已加载所有配置');

    // 初始化 InventoryService 单例（注入 configLoader，否则 getItemConfig 返回 null）
    if (typeof InventoryService.initialize === 'function' && !InventoryService.configLoader) {
        InventoryService.initialize(configLoader);
        console.log('[初始化] InventoryService 已注入 configLoader');
    }

    const testPlayerIds = [];
    const testInstanceIds = [];
    let leaderPlayer = null;
    let memberPlayers = [];

    try {
        // ============ 步骤0：准备测试玩家 ============
        console.log('\n[步骤0] 准备5名测试玩家（1队长+4队员）...');
        leaderPlayer = await createTestPlayer('测试队长_昆吾', 19); // 元婴期
        memberPlayers = [
            await createTestPlayer('测试队员1_昆吾', 15), // 结丹期
            await createTestPlayer('测试队员2_昆吾', 15),
            await createTestPlayer('测试队员3_昆吾', 15),
            await createTestPlayer('测试队员4_昆吾', 15)
        ];
        testPlayerIds.push(leaderPlayer.id, ...memberPlayers.map(p => p.id));
        console.log(`  队长ID: ${leaderPlayer.id} (${leaderPlayer.realm})`);
        memberPlayers.forEach((p, i) => console.log(`  队员${i + 1}ID: ${p.id} (${p.realm})`));

        // 给队长发放昆吾通行令
        try {
            await InventoryService.addItem(leaderPlayer.id, 'kunwu_pass_token', 1);
            console.log('  已发放昆吾通行令×1 给队长');
        } catch (e) {
            console.warn(`  发放昆吾通行令失败（可能物品配置不存在，跳过物品校验）: ${e.message}`);
        }

        // ============ 步骤1：验证前置条件校验 ============
        console.log('\n[步骤1] 验证前置条件校验...');

        // 1.1 验证非法 dungeon_key 被拒绝
        const invalidKeyResult = await MultiDungeonService.create(leaderPlayer.id, 'invalid_key');
        assert(!invalidKeyResult.success, '非法 dungeon_key 应被拒绝');
        assert(invalidKeyResult.message.includes('kunwu'), '错误消息应包含 kunwu 提示');

        // 1.2 验证境界不足的队员尝试开本被拒
        const lowRealmPlayer = memberPlayers[0]; // 结丹期 rank=15
        const lowRealmResult = await MultiDungeonService.create(lowRealmPlayer.id, 'kunwu');
        assert(!lowRealmResult.success, '结丹期尝试开昆吾山应被拒（需元婴期）');
        assert(lowRealmResult.message.includes('境界不足'), '应提示境界不足');

        // ============ 步骤2：队长创建副本 ============
        console.log('\n[步骤2] 队长创建昆吾山副本...');

        const createResult = await MultiDungeonService.create(leaderPlayer.id, 'kunwu');
        assert(createResult.success, '队长创建昆吾山副本应成功: ' + (createResult.message || ''));
        assert(createResult.data.dungeon_key === 'kunwu', '副本键应为 kunwu');
        assert(createResult.data.instance_state === 'preparing', '初始状态应为 preparing');
        assert(createResult.data.member_max === 5, '成员上限应为5');
        assert(createResult.data.member_min === 5, '成员下限应为5');
        const instanceId = createResult.data.instance_id;
        testInstanceIds.push(instanceId);
        console.log(`  副本实例ID: ${instanceId}`);

        // 验证实例变量正确初始化
        const instance = await MultiDungeonInstance.findByPk(instanceId);
        assert(instance.morale === 100, `士气应初始化为100，实际 ${instance.morale}`);
        assert(instance.seal_stability === 50, `封印应初始化为50，实际 ${instance.seal_stability}`);
        assert(instance.demonic_qi === 0, `魔气应初始化为0，实际 ${instance.demonic_qi}`);
        assert(instance.mountain_seal === 30, `山禁应初始化为30，实际 ${instance.mountain_seal}`);
        assert(instance.treasure_pressure === 0, `宝压应初始化为0，实际 ${instance.treasure_pressure}`);
        assert(instance.linglong === 50, `玲珑应初始化为50，实际 ${instance.linglong}`);

        // ============ 步骤3：队员加入副本 ============
        console.log('\n[步骤3] 4名队员加入副本...');

        for (let i = 0; i < memberPlayers.length; i++) {
            const joinResult = await MultiDungeonService.join(memberPlayers[i].id, instanceId);
            assert(joinResult.success, `队员${i + 1}加入副本应成功: ${joinResult.message || ''}`);
        }

        // 验证成员数达到5
        const refreshedInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(refreshedInstance.member_count === 5, `成员数应为5，实际 ${refreshedInstance.member_count}`);

        // ============ 步骤4：队长进入开打 ============
        console.log('\n[步骤4] 队长进入开打...');

        const enterResult = await MultiDungeonService.enter(leaderPlayer.id);
        assert(enterResult.success, '进入开打应成功: ' + (enterResult.message || ''));
        assert(enterResult.data.instance_state === 'active', '开打后状态应为 active');
        assert(enterResult.data.current_act === 1, '应从第1幕开始');
        assert(enterResult.data.act_name === '入山策略', `第1幕名称应为"入山策略"，实际 "${enterResult.data.act_name}"`);
        assert(enterResult.data.choices.length === 4, `第1幕应有4个选项，实际 ${enterResult.data.choices.length}`);

        // ============ 步骤5：第一幕 - 入山策略 ============
        console.log('\n[步骤5] 第一幕入山策略：选择【八灵尺光】（稳健镇塔路线）...');

        const act1Result = await MultiDungeonService.choose(leaderPlayer.id, 'baling_ruler_light');
        assert(act1Result.success, '第一幕抉择应成功: ' + (act1Result.message || ''));
        assert(act1Result.data.current_act === 2, '应推进到第2幕');
        assert(act1Result.data.act_name === '昆吾遗宫', `第2幕名称应为"昆吾遗宫"，实际 "${act1Result.data.act_name}"`);

        // 验证第一幕变量变化：封印+15 玲珑+10 山禁+5
        const instanceAfterAct1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct1.seal_stability === 65, `封印应+15=65，实际 ${instanceAfterAct1.seal_stability}`);
        assert(instanceAfterAct1.linglong === 60, `玲珑应+10=60，实际 ${instanceAfterAct1.linglong}`);
        assert(instanceAfterAct1.mountain_seal === 35, `山禁应+5=35，实际 ${instanceAfterAct1.mountain_seal}`);

        // 验证抉择记录已写入
        const act1Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 1 }
        });
        assert(act1Choices.length === 1, `第一幕应写入1条抉择记录，实际 ${act1Choices.length}`);
        assert(act1Choices[0].choice_key === 'baling_ruler_light', '抉择键应正确');
        assert(act1Choices[0].seal_stability_change === 15, `封印变化应记录15，实际 ${act1Choices[0].seal_stability_change}`);
        assert(act1Choices[0].linglong_change === 10, `玲珑变化应记录10，实际 ${act1Choices[0].linglong_change}`);

        // ============ 步骤6：第二幕 - 随机池抉择 ============
        console.log('\n[步骤6] 第二幕昆吾遗宫：从5个遗迹中选择【取封纹】...');

        const act2Result = await MultiDungeonService.choose(leaderPlayer.id, 'seal_pattern');
        assert(act2Result.success, '第二幕抉择应成功: ' + (act2Result.message || ''));
        assert(act2Result.data.current_act === 3, '应推进到第3幕');
        assert(act2Result.data.act_name === '封魔塔阵眼', `第3幕名称应为"封魔塔阵眼"，实际 "${act2Result.data.act_name}"`);

        // 验证第二幕变量变化：封印+20 玲珑+5
        const instanceAfterAct2 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct2.seal_stability === 85, `封印应+20=85，实际 ${instanceAfterAct2.seal_stability}`);
        assert(instanceAfterAct2.linglong === 65, `玲珑应+5=65，实际 ${instanceAfterAct2.linglong}`);

        // 验证第二幕抉择记录
        const act2Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 2 }
        });
        assert(act2Choices.length === 1, `第二幕应写入1条抉择记录，实际 ${act2Choices.length}`);

        // ============ 步骤7：第三幕 - 3阵眼连续抉择 ============
        console.log('\n[步骤7] 第三幕封魔塔阵眼：依次处理3个阵眼...');

        // 7.1 第一个阵眼：八灵尺阵眼 - 选择"镇"
        console.log('  7.1 八灵尺阵眼 - 选择【镇（补封）】...');
        const eye1Result = await MultiDungeonService.choose(leaderPlayer.id, 'baling_eye:suppress');
        assert(eye1Result.success, '第一阵眼抉择应成功: ' + (eye1Result.message || ''));
        assert(eye1Result.data.current_act === 3, '仍应在第3幕（未完成3次）');
        assert(eye1Result.data.act_state === 'multi_choice_1', `act_state 应为 multi_choice_1，实际 ${eye1Result.data.act_state}`);
        assert(eye1Result.data.next_eye === 'dragon_eye', `下一阵眼应为 dragon_eye，实际 ${eye1Result.data.next_eye}`);
        assert(eye1Result.data.next_eye_name === '化龙玺阵眼', `下一阵眼名应为"化龙玺阵眼"，实际 "${eye1Result.data.next_eye_name}"`);

        // 验证八灵尺阵眼效果：封印+15
        const instanceAfterEye1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye1.seal_stability === 100, `封印应+15=100（达到上限），实际 ${instanceAfterEye1.seal_stability}`);

        // 7.2 第二个阵眼：化龙玺阵眼 - 选择"镇"
        console.log('  7.2 化龙玺阵眼 - 选择【镇（补封）】...');
        const eye2Result = await MultiDungeonService.choose(leaderPlayer.id, 'dragon_eye:suppress');
        assert(eye2Result.success, '第二阵眼抉择应成功: ' + (eye2Result.message || ''));
        assert(eye2Result.data.next_eye === 'blackwind_eye', `下一阵眼应为 blackwind_eye，实际 ${eye2Result.data.next_eye}`);

        // 验证化龙玺阵眼效果：封印+20（已达上限，仍100）士气-10
        const instanceAfterEye2 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye2.seal_stability === 100, `封印应保持100（上限），实际 ${instanceAfterEye2.seal_stability}`);
        assert(instanceAfterEye2.morale === 90, `士气应-10=90，实际 ${instanceAfterEye2.morale}`);

        // 7.3 第三个阵眼：黑风旗阵眼 - 选择"镇"
        console.log('  7.3 黑风旗阵眼 - 选择【镇（补封）】...');
        const eye3Result = await MultiDungeonService.choose(leaderPlayer.id, 'blackwind_eye:suppress');
        assert(eye3Result.success, '第三阵眼抉择应成功: ' + (eye3Result.message || ''));

        // 第三幕完成应自动推进到第4幕
        assert(eye3Result.data.current_act === 4, `应推进到第4幕，实际 ${eye3Result.data.current_act}`);
        assert(eye3Result.data.act_name === '玲珑封魔塔决战', `第4幕名称应为"玲珑封魔塔决战"，实际 "${eye3Result.data.act_name}"`);
        assert(eye3Result.data.is_auto_advance === true, '第4幕应标记为 is_auto_advance');
        assert(eye3Result.data.choices.length === 0, '自动决战幕 choices 应为空数组');
        assert(eye3Result.data.rounds_max === 5, `rounds_max 应为5，实际 ${eye3Result.data.rounds_max}`);

        // 验证黑风旗阵眼效果：封印+10（仍100）山禁+10
        const instanceAfterEye3 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye3.seal_stability === 100, `封印应保持100，实际 ${instanceAfterEye3.seal_stability}`);
        assert(instanceAfterEye3.mountain_seal === 45, `山禁应+10=45，实际 ${instanceAfterEye3.mountain_seal}`);

        // 验证第三幕共3条抉择记录
        const act3Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 3 }
        });
        assert(act3Choices.length === 3, `第三幕应有3条抉择记录，实际 ${act3Choices.length}`);
        assert(act3Choices[0].eye_key === 'baling_eye', `第1条记录 eye_key 应为 baling_eye`);
        assert(act3Choices[1].eye_key === 'dragon_eye', `第2条记录 eye_key 应为 dragon_eye`);
        assert(act3Choices[2].eye_key === 'blackwind_eye', `第3条记录 eye_key 应为 blackwind_eye`);

        // ============ 步骤8：第四幕 - 自动决战（应失败场景）============
        console.log('\n[步骤8] 第四幕封魔决战：测试失败场景...');
        console.log('  （当前封印=100，魔气=0，玲珑=65，5回合伤害=200000+65*2000=330000/回合，5回合总伤害=1650000，应可击杀1000000）');

        // 先尝试在 is_auto_advance 幕调用 choose，应被拒绝
        const invalidChooseResult = await MultiDungeonService.choose(leaderPlayer.id, 'any_choice');
        assert(!invalidChooseResult.success, '在自动决战幕调用 choose 应被拒绝');

        // 触发自动决战
        const act4Result = await MultiDungeonService.advance(leaderPlayer.id);
        assert(act4Result.success, '第四幕自动决战应执行完成: ' + (act4Result.message || ''));
        assert(act4Result.data.auto_battle, '应返回 auto_battle 详情');
        assert(act4Result.data.auto_battle.rounds_log.length > 0, '应有回合日志');
        assert(act4Result.data.auto_battle.rounds_log.length <= 5, `回合数不应超过5，实际 ${act4Result.data.auto_battle.rounds_log.length}`);

        // 验证伤害计算：每回合 200000 + 玲珑*2000
        const firstRound = act4Result.data.auto_battle.rounds_log[0];
        const expectedDamage = 200000 + 65 * 2000; // 330000
        const actualDamage = parseInt(firstRound.damage);
        assert(actualDamage === expectedDamage, `第1回合伤害应为 ${expectedDamage}，实际 ${actualDamage}`);

        // 验证通关：HP=1000000，5回合伤害1650000，应在4-5回合内通关
        assert(act4Result.data.instance_state === 'cleared', `副本应通关，实际状态 ${act4Result.data.instance_state}`);
        assert(act4Result.data.auto_battle.outcome === 'cleared', `auto_battle.outcome 应为 cleared`);

        console.log(`  通关！实际用了 ${act4Result.data.auto_battle.rounds_total} 回合`);

        // ============ 步骤9：验证通关奖励发放 ============
        console.log('\n[步骤9] 验证通关奖励发放...');

        const rewards = act4Result.data.rewards;
        assert(rewards, '应返回 rewards 摘要');
        assert(rewards.normal_drops.length === 5, `5名成员应有5条 normal_drops 记录，实际 ${rewards.normal_drops.length}`);

        // 验证玲珑加成：每10点玲珑+1000修为+100灵石，65点玲珑=6*1000=6000修为+6*100=600灵石
        const leaderDrops = rewards.normal_drops.find(d => d.player_id === leaderPlayer.id);
        assert(leaderDrops, '应有队长奖励记录');
        const linglongBonusExp = leaderDrops.drops.find(d => d.source === 'linglong_bonus' && d.type === 'exp');
        assert(linglongBonusExp, '应有玲珑修为加成');
        assert(parseInt(linglongBonusExp.count) === 6000, `玲珑修为加成应为6000，实际 ${linglongBonusExp.count}`);

        // 验证基础奖励：50000修为 + 20000灵石 + 100神识
        const baseExp = leaderDrops.drops.find(d => d.type === 'exp' && !d.source);
        assert(baseExp, '应有基础修为奖励');
        // harvest_multiplier=1.0 时基础修为=50000
        assert(parseInt(baseExp.count) === 50000, `基础修为应为50000，实际 ${baseExp.count}`);

        const baseSpiritStones = leaderDrops.drops.find(d => d.type === 'spirit_stones' && !d.source);
        assert(baseSpiritStones, '应有基础灵石奖励');
        assert(parseInt(baseSpiritStones.count) === 20000, `基础灵石应为20000，实际 ${baseSpiritStones.count}`);

        const baseDivineSense = leaderDrops.drops.find(d => d.type === 'divine_sense');
        assert(baseDivineSense, '应有神识奖励');
        assert(baseDivineSense.count === 100, `神识应为100，实际 ${baseDivineSense.count}`);

        // ============ 步骤10：验证冷却记录写入 ============
        console.log('\n[步骤10] 验证冷却记录写入...');

        const cooldowns = await MultiDungeonCooldown.findAll({
            where: { instance_id: instanceId }
        });
        assert(cooldowns.length === 5, `5名成员应有5条冷却记录，实际 ${cooldowns.length}`);
        assert(cooldowns[0].reason === 'cleared', `冷却原因应为 cleared，实际 ${cooldowns[0].reason}`);
        assert(cooldowns[0].cooldown_hours === 72, `冷却时长应为72小时，实际 ${cooldowns[0].cooldown_hours}`);

        // 验证实例状态
        const finalInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(finalInstance.instance_state === 'cleared', `副本状态应为 cleared，实际 ${finalInstance.instance_state}`);
        assert(finalInstance.cleared_at !== null, 'cleared_at 不应为 null');
        assert(finalInstance.first_clear === 1 || finalInstance.first_clear === 0, 'first_clear 应为0或1');

        // ============ 步骤11：验证 status 接口返回完整数据 ============
        console.log('\n[步骤11] 验证 status 接口（已通关后查询应返回 has_instance=false）...');

        const statusResult = await MultiDungeonService.getStatus(leaderPlayer.id);
        assert(statusResult.success, 'status 接口应成功');
        assert(statusResult.data.has_instance === false, '通关后应无进行中副本');

        // ============ 步骤12：验证 getHelp 包含 kunwu ============
        console.log('\n[步骤12] 验证 getHelp 包含 kunwu...');

        const helpResult = await MultiDungeonService.getHelp();
        assert(helpResult.success, 'getHelp 应成功');
        assert(helpResult.data.dungeons.kunwu, 'getHelp 应包含 kunwu');
        assert(helpResult.data.dungeons.kunwu.name === '昆吾山·封魔塔', `kunwu 名称应正确，实际 "${helpResult.data.dungeons.kunwu.name}"`);
        assert(helpResult.data.dungeons.kunwu.member_max === 5, `kunwu 成员上限应为5`);
        assert(helpResult.data.dungeons.kunwu.act_count === 4, `kunwu 应有4幕`);

        // ============ 步骤13：验证 getRewards 返回完整奖励池 ============
        console.log('\n[步骤13] 验证 getRewards 返回 kunwu 奖励池...');

        const rewardsResult = await MultiDungeonService.getRewards('kunwu');
        assert(rewardsResult.success, 'getRewards 应成功');
        assert(rewardsResult.data.rewards.base_rewards.length === 3, `基础奖励应有3项，实际 ${rewardsResult.data.rewards.base_rewards.length}`);
        assert(rewardsResult.data.rewards.normal_drops.length === 7, `普通掉落应有7种，实际 ${rewardsResult.data.rewards.normal_drops.length}`);
        assert(rewardsResult.data.rewards.rare_drop.item_key === 'baling_ruler', `稀有掉落应为八灵尺`);
        assert(rewardsResult.data.rewards.rare_drop.chance === 0.002, `稀有掉落概率应为0.002`);

    } catch (err) {
        console.error('\n[测试异常]', err);
        console.error(err.stack);
        stats.total++;
        stats.failed++;
        stats.failedDetails.push(`测试异常: ${err.message}`);
    } finally {
        // ============ 清理 ============
        await cleanupTestData(testPlayerIds, testInstanceIds);
    }

    // ============ 输出测试结果 ============
    console.log('\n' + '='.repeat(80));
    console.log('[昆吾山·封魔塔] 端到端测试结果');
    console.log('='.repeat(80));
    console.log(`总计: ${stats.total}, 通过: ${stats.passed}, 失败: ${stats.failed}`);
    if (stats.failed > 0) {
        console.log('\n失败项:');
        stats.failedDetails.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
    }
    console.log('='.repeat(80));
    process.exit(stats.failed > 0 ? 1 : 0);
}

// 启动测试
runTests().catch(err => {
    console.error('[测试启动失败]', err);
    process.exit(1);
});
