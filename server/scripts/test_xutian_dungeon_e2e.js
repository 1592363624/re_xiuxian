/**
 * 虚天殿副本端到端测试
 *
 * 测试目标：
 *   1. 验证4-6人组队副本的创建、加入、进入开打完整流程
 *   2. 验证第一幕选择道路（冰道/火道，path_choice 变化正确）
 *   3. 验证第二幕阵策（3选1，formation_power 累积）
 *   4. 验证第三幕随机池抉择（从5个战术中选1个）
 *   5. 验证第四幕争鼎（求稳/夺鼎，treasure_pressure 累积）
 *   6. 验证第五幕3阵眼连续抉择（冰焰→虚天→魂印，各选破/守/避）
 *   7. 验证第六幕6回合自动决战（虚天主魂HP削减+阵法强度≥70通关）
 *   8. 验证3专属变量（path_choice/formation_power/void_soul_hp）+5通用变量边界与累积
 *   9. 验证奖励结算（基础/普通掉落/首通/稀有掉落）
 *  10. 验证冷却记录写入与查询
 *
 * 测试策略：
 *   - 直接调用 Service 层方法，绕过 HTTP 层
 *   - 使用 1592363624（玩家ID=1）作为队长，创建临时测试小号作为队员
 *   - 选择【激进路线】最大化阵法强度以确保通关（火道→急攻→火炎爆发→夺鼎→3阵眼全破）
 *   - 测试结束后清理所有临时数据
 *
 * 运行方式：node scripts/test_xutian_dungeon_e2e.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
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

// 境界 rank → 名称映射（与 realm_breakthrough.json 一致）
const RANK_TO_REALM = {
    17: '金丹后期',
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
async function createTestPlayer(nickname, realmRank = 17) {
    const realmName = RANK_TO_REALM[realmRank] || '金丹后期';

    const player = await Player.create({
        username: `test_xutian_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
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
        await Player.destroy({ where: { id: playerIds }, force: true });
        console.log(`[清理] 已删除 ${playerIds.length} 个临时玩家`);
    }
}

/**
 * 主测试流程
 */
async function runTests() {
    console.log('='.repeat(80));
    console.log('[虚天殿] 端到端测试开始');
    console.log('='.repeat(80));

    // 初始化 ConfigLoader
    if (typeof configLoader.initialize === 'function') {
        await configLoader.initialize();
    } else if (typeof configLoader.loadAllConfigs === 'function') {
        await configLoader.loadAllConfigs();
    }
    console.log('[初始化] ConfigLoader 已加载所有配置');

    // 初始化 InventoryService 单例
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
        console.log('\n[步骤0] 准备4名测试玩家（1队长+3队员，最少4人）...');
        leaderPlayer = await createTestPlayer('测试队长_虚天', 19); // 元婴期
        memberPlayers = [
            await createTestPlayer('测试队员1_虚天', 17), // 结丹后期
            await createTestPlayer('测试队员2_虚天', 17),
            await createTestPlayer('测试队员3_虚天', 17)
        ];
        testPlayerIds.push(leaderPlayer.id, ...memberPlayers.map(p => p.id));
        console.log(`  队长ID: ${leaderPlayer.id} (${leaderPlayer.realm})`);
        memberPlayers.forEach((p, i) => console.log(`  队员${i + 1}ID: ${p.id} (${p.realm})`));

        // 给队长发放虚天令
        try {
            await InventoryService.addItem(leaderPlayer.id, 'xutian_pass_token', 1);
            console.log('  已发放虚天令×1 给队长');
        } catch (e) {
            console.warn(`  发放虚天令失败（可能物品配置不存在，跳过物品校验）: ${e.message}`);
        }

        // ============ 步骤1：验证前置条件校验 ============
        console.log('\n[步骤1] 验证前置条件校验...');

        // 1.1 验证非法 dungeon_key 被拒绝
        const invalidKeyResult = await MultiDungeonService.create(leaderPlayer.id, 'invalid_key');
        assert(!invalidKeyResult.success, '非法 dungeon_key 应被拒绝');
        assert(invalidKeyResult.message.includes('xutian'), '错误消息应包含 xutian 提示');

        // 1.2 验证境界不足的队员尝试开本被拒
        const lowRealmPlayer = memberPlayers[0]; // 结丹后期 rank=17
        const lowRealmResult = await MultiDungeonService.create(lowRealmPlayer.id, 'xutian');
        assert(!lowRealmResult.success, '结丹后期尝试开虚天殿应被拒（需元婴期）');
        assert(lowRealmResult.message.includes('境界不足'), '应提示境界不足');

        // ============ 步骤2：队长创建副本 ============
        console.log('\n[步骤2] 队长创建虚天殿副本...');

        const createResult = await MultiDungeonService.create(leaderPlayer.id, 'xutian');
        assert(createResult.success, '队长创建虚天殿副本应成功: ' + (createResult.message || ''));
        assert(createResult.data.dungeon_key === 'xutian', '副本键应为 xutian');
        assert(createResult.data.instance_state === 'preparing', '初始状态应为 preparing');
        assert(createResult.data.member_max === 6, `成员上限应为6，实际 ${createResult.data.member_max}`);
        assert(createResult.data.member_min === 4, `成员下限应为4，实际 ${createResult.data.member_min}`);
        const instanceId = createResult.data.instance_id;
        testInstanceIds.push(instanceId);
        console.log(`  副本实例ID: ${instanceId}`);

        // 验证实例变量正确初始化
        const instance = await MultiDungeonInstance.findByPk(instanceId);
        assert(instance.morale === 100, `士气应初始化为100，实际 ${instance.morale}`);
        assert(instance.seal_stability === 50, `封印应初始化为50，实际 ${instance.seal_stability}`);
        assert(instance.soul_stability === 100, `神魂稳定度应初始化为100，实际 ${instance.soul_stability}`);
        assert(instance.treasure_pressure === 0, `宝压应初始化为0，实际 ${instance.treasure_pressure}`);
        // 虚天殿专属变量
        assert(instance.path_choice === 0, `path_choice 应初始化为0，实际 ${instance.path_choice}`);
        assert(instance.formation_power === 30, `阵法强度应初始化为30，实际 ${instance.formation_power}`);
        assert(instance.void_soul_hp === null, `void_soul_hp 初始应为 null（未进入第六幕），实际 ${instance.void_soul_hp}`);

        // ============ 步骤3：队员加入副本 ============
        console.log('\n[步骤3] 3名队员加入副本...');

        for (let i = 0; i < memberPlayers.length; i++) {
            const joinResult = await MultiDungeonService.join(memberPlayers[i].id, instanceId);
            assert(joinResult.success, `队员${i + 1}加入副本应成功: ${joinResult.message || ''}`);
        }

        // 验证成员数达到4（最低人数）
        const refreshedInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(refreshedInstance.member_count === 4, `成员数应为4，实际 ${refreshedInstance.member_count}`);

        // ============ 步骤4：队长进入开打 ============
        console.log('\n[步骤4] 队长进入开打...');

        const enterResult = await MultiDungeonService.enter(leaderPlayer.id);
        assert(enterResult.success, '进入开打应成功: ' + (enterResult.message || ''));
        assert(enterResult.data.instance_state === 'active', '开打后状态应为 active');
        assert(enterResult.data.current_act === 1, '应从第1幕开始');
        assert(enterResult.data.act_name === '选择道路', `第1幕名称应为"选择道路"，实际 "${enterResult.data.act_name}"`);
        assert(enterResult.data.choices.length === 2, `第1幕应有2个选项（冰道/火道），实际 ${enterResult.data.choices.length}`);

        // ============ 步骤5：第一幕 - 选择道路（火道，激进路线）============
        console.log('\n[步骤5] 第一幕选择道路：选择【火道路】（激进路线，最大化阵法强度）...');

        const act1Result = await MultiDungeonService.choose(leaderPlayer.id, 'fire_path');
        assert(act1Result.success, '第一幕抉择应成功: ' + (act1Result.message || ''));
        assert(act1Result.data.current_act === 2, '应推进到第2幕');
        assert(act1Result.data.act_name === '阵策', `第2幕名称应为"阵策"，实际 "${act1Result.data.act_name}"`);

        // 验证第一幕变量变化：path_choice=2, soul_stability-10=90, treasure_pressure+10=10, formation_power+10=40
        const instanceAfterAct1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct1.path_choice === 2, `path_choice 应为2（火道），实际 ${instanceAfterAct1.path_choice}`);
        assert(instanceAfterAct1.soul_stability === 90, `神魂稳定度应-10=90，实际 ${instanceAfterAct1.soul_stability}`);
        assert(instanceAfterAct1.treasure_pressure === 10, `宝压应+10=10，实际 ${instanceAfterAct1.treasure_pressure}`);
        assert(instanceAfterAct1.formation_power === 40, `阵法强度应+10=40，实际 ${instanceAfterAct1.formation_power}`);
        assert(instanceAfterAct1.harvest_multiplier === 1.1, `收获倍率应+0.1=1.1，实际 ${instanceAfterAct1.harvest_multiplier}`);

        // 验证抉择记录已写入（含 path_choice_change 字段）
        const act1Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 1 }
        });
        assert(act1Choices.length === 1, `第一幕应写入1条抉择记录，实际 ${act1Choices.length}`);
        assert(act1Choices[0].choice_key === 'fire_path', '抉择键应为 fire_path');
        assert(act1Choices[0].path_choice_change === 2, `path_choice_change 应记录2，实际 ${act1Choices[0].path_choice_change}`);
        assert(act1Choices[0].formation_power_change === 10, `formation_power_change 应记录10，实际 ${act1Choices[0].formation_power_change}`);

        // ============ 步骤6：第二幕 - 阵策（急攻阵）============
        console.log('\n[步骤6] 第二幕阵策：选择【急攻阵】（高风险高伤害）...');

        const act2Result = await MultiDungeonService.choose(leaderPlayer.id, 'rush_formation');
        assert(act2Result.success, '第二幕抉择应成功: ' + (act2Result.message || ''));
        assert(act2Result.data.current_act === 3, '应推进到第3幕');
        assert(act2Result.data.act_name === '选择战术', `第3幕名称应为"选择战术"，实际 "${act2Result.data.act_name}"`);

        // 验证第二幕变量变化：seal_stability-10=40, formation_power+15=55, harvest_multiplier+0.1=1.2
        const instanceAfterAct2 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct2.seal_stability === 40, `封印应-10=40，实际 ${instanceAfterAct2.seal_stability}`);
        assert(instanceAfterAct2.formation_power === 55, `阵法强度应+15=55，实际 ${instanceAfterAct2.formation_power}`);
        assert(instanceAfterAct2.harvest_multiplier === 1.2, `收获倍率应+0.1=1.2，实际 ${instanceAfterAct2.harvest_multiplier}`);

        // ============ 步骤7：第三幕 - 随机池抉择（火炎爆发）============
        console.log('\n[步骤7] 第三幕选择战术：选择【火炎爆发】（继续累积阵法强度）...');

        const act3Result = await MultiDungeonService.choose(leaderPlayer.id, 'fire_burst_tactic');
        assert(act3Result.success, '第三幕抉择应成功: ' + (act3Result.message || ''));
        assert(act3Result.data.current_act === 4, '应推进到第4幕');
        assert(act3Result.data.act_name === '争鼎', `第4幕名称应为"争鼎"，实际 "${act3Result.data.act_name}"`);

        // 验证第三幕变量变化：treasure_pressure+10=20, formation_power+15=70, harvest_multiplier+0.05=1.25
        const instanceAfterAct3 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct3.treasure_pressure === 20, `宝压应+10=20，实际 ${instanceAfterAct3.treasure_pressure}`);
        assert(instanceAfterAct3.formation_power === 70, `阵法强度应+15=70，实际 ${instanceAfterAct3.formation_power}`);
        assert(instanceAfterAct3.harvest_multiplier === 1.25, `收获倍率应+0.05=1.25，实际 ${instanceAfterAct3.harvest_multiplier}`);

        // ============ 步骤8：第四幕 - 争鼎（夺鼎）============
        console.log('\n[步骤8] 第四幕争鼎：选择【夺鼎】（高风险高回报，最大化宝压和阵法强度）...');

        const act4Result = await MultiDungeonService.choose(leaderPlayer.id, 'seize_cauldron');
        assert(act4Result.success, '第四幕抉择应成功: ' + (act4Result.message || ''));
        assert(act4Result.data.current_act === 5, '应推进到第5幕');
        assert(act4Result.data.act_name === '后殿抉择', `第5幕名称应为"后殿抉择"，实际 "${act4Result.data.act_name}"`);

        // 验证第四幕变量变化：soul_stability-15=75, treasure_pressure+30=50, formation_power+10=80, harvest_multiplier+0.3=1.55
        const instanceAfterAct4 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct4.soul_stability === 75, `神魂稳定度应-15=75，实际 ${instanceAfterAct4.soul_stability}`);
        assert(instanceAfterAct4.treasure_pressure === 50, `宝压应+30=50，实际 ${instanceAfterAct4.treasure_pressure}`);
        assert(instanceAfterAct4.formation_power === 80, `阵法强度应+10=80，实际 ${instanceAfterAct4.formation_power}`);
        assert(instanceAfterAct4.harvest_multiplier === 1.55, `收获倍率应+0.3=1.55，实际 ${instanceAfterAct4.harvest_multiplier}`);

        // ============ 步骤9：第五幕 - 3阵眼连续抉择（全选"破"以最大化阵法强度）============
        console.log('\n[步骤9] 第五幕后殿抉择：依次处理3个阵眼，全选【破】以最大化阵法强度...');

        // 9.1 第一个阵眼：冰焰阵眼 - 选择"破"
        console.log('  9.1 冰焰阵眼 - 选择【破（强破）】...');
        const eye1Result = await MultiDungeonService.choose(leaderPlayer.id, 'ice_flame_eye:break');
        assert(eye1Result.success, '第一阵眼抉择应成功: ' + (eye1Result.message || ''));
        assert(eye1Result.data.current_act === 5, '仍应在第5幕（未完成3次）');
        assert(eye1Result.data.act_state === 'multi_choice_1', `act_state 应为 multi_choice_1，实际 ${eye1Result.data.act_state}`);
        assert(eye1Result.data.next_eye === 'void_eye', `下一阵眼应为 void_eye，实际 ${eye1Result.data.next_eye}`);
        assert(eye1Result.data.next_eye_name === '虚天阵眼', `下一阵眼名应为"虚天阵眼"，实际 "${eye1Result.data.next_eye_name}"`);

        // 验证冰焰阵眼效果：treasure_pressure+10=60, formation_power+15=95
        const instanceAfterEye1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye1.treasure_pressure === 60, `宝压应+10=60，实际 ${instanceAfterEye1.treasure_pressure}`);
        assert(instanceAfterEye1.formation_power === 95, `阵法强度应+15=95，实际 ${instanceAfterEye1.formation_power}`);

        // 9.2 第二个阵眼：虚天阵眼 - 选择"破"
        console.log('  9.2 虚天阵眼 - 选择【破（强破）】...');
        const eye2Result = await MultiDungeonService.choose(leaderPlayer.id, 'void_eye:break');
        assert(eye2Result.success, '第二阵眼抉择应成功: ' + (eye2Result.message || ''));
        assert(eye2Result.data.next_eye === 'soul_mark_eye', `下一阵眼应为 soul_mark_eye，实际 ${eye2Result.data.next_eye}`);

        // 验证虚天阵眼效果：treasure_pressure+15=75, formation_power+20=100（达上限）
        const instanceAfterEye2 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye2.treasure_pressure === 75, `宝压应+15=75，实际 ${instanceAfterEye2.treasure_pressure}`);
        assert(instanceAfterEye2.formation_power === 100, `阵法强度应+20=100（达上限），实际 ${instanceAfterEye2.formation_power}`);

        // 9.3 第三个阵眼：魂印阵眼 - 选择"破"
        console.log('  9.3 魂印阵眼 - 选择【破（强破）】...');
        const eye3Result = await MultiDungeonService.choose(leaderPlayer.id, 'soul_mark_eye:break');
        assert(eye3Result.success, '第三阵眼抉择应成功: ' + (eye3Result.message || ''));

        // 第五幕完成应自动推进到第6幕
        assert(eye3Result.data.current_act === 6, `应推进到第6幕，实际 ${eye3Result.data.current_act}`);
        assert(eye3Result.data.act_name === '后殿阵策', `第6幕名称应为"后殿阵策"，实际 "${eye3Result.data.act_name}"`);
        assert(eye3Result.data.is_auto_advance === true, '第6幕应标记为 is_auto_advance');
        assert(eye3Result.data.choices.length === 0, '自动决战幕 choices 应为空数组');
        assert(eye3Result.data.rounds_max === 6, `rounds_max 应为6，实际 ${eye3Result.data.rounds_max}`);

        // 验证魂印阵眼效果：soul_stability-10=65, treasure_pressure+20=95, formation_power+25=100（仍达上限）
        const instanceAfterEye3 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterEye3.soul_stability === 65, `神魂稳定度应-10=65，实际 ${instanceAfterEye3.soul_stability}`);
        assert(instanceAfterEye3.treasure_pressure === 95, `宝压应+20=95，实际 ${instanceAfterEye3.treasure_pressure}`);
        assert(instanceAfterEye3.formation_power === 100, `阵法强度应保持100（达上限），实际 ${instanceAfterEye3.formation_power}`);

        // 验证第五幕共3条抉择记录
        const act5Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 5 }
        });
        assert(act5Choices.length === 3, `第五幕应有3条抉择记录，实际 ${act5Choices.length}`);
        assert(act5Choices[0].eye_key === 'ice_flame_eye', `第1条记录 eye_key 应为 ice_flame_eye`);
        assert(act5Choices[1].eye_key === 'void_eye', `第2条记录 eye_key 应为 void_eye`);
        assert(act5Choices[2].eye_key === 'soul_mark_eye', `第3条记录 eye_key 应为 soul_mark_eye`);

        // ============ 步骤10：第六幕 - 自动决战（预期通关）============
        console.log('\n[步骤10] 第六幕后殿阵策：测试通关场景...');
        console.log('  （当前阵法强度=100，神魂稳定=65，6回合伤害=180000+100*2500=430000/回合）');
        console.log('  （4回合总伤害=1720000>1500000，应在4回合内击杀虚天主魂）');

        // 先尝试在 is_auto_advance 幕调用 choose，应被拒绝
        const invalidChooseResult = await MultiDungeonService.choose(leaderPlayer.id, 'any_choice');
        assert(!invalidChooseResult.success, '在自动决战幕调用 choose 应被拒绝');

        // 触发自动决战
        const act6Result = await MultiDungeonService.advance(leaderPlayer.id);
        assert(act6Result.success, '第六幕自动决战应执行完成: ' + (act6Result.message || ''));
        assert(act6Result.data.auto_battle, '应返回 auto_battle 详情');
        assert(act6Result.data.auto_battle.rounds_log.length > 0, '应有回合日志');
        assert(act6Result.data.auto_battle.rounds_log.length <= 6, `回合数不应超过6，实际 ${act6Result.data.auto_battle.rounds_log.length}`);

        // 验证伤害计算：每回合 180000 + 100 * 2500 = 430000
        const firstRound = act6Result.data.auto_battle.rounds_log[0];
        const expectedDamage = 180000 + 100 * 2500; // 430000
        const actualDamage = parseInt(firstRound.damage);
        assert(actualDamage === expectedDamage, `第1回合伤害应为 ${expectedDamage}，实际 ${actualDamage}`);

        // 验证通关：HP=1500000，4回合伤害 1720000，应在4回合内通关
        assert(act6Result.data.instance_state === 'cleared', `副本应通关，实际状态 ${act6Result.data.instance_state}`);
        assert(act6Result.data.auto_battle.outcome === 'cleared', `auto_battle.outcome 应为 cleared`);

        console.log(`  通关！实际用了 ${act6Result.data.auto_battle.rounds_total} 回合`);
        console.log(`  最终虚天主魂HP: ${act6Result.data.auto_battle.final_void_soul_hp}`);
        console.log(`  最终阵法强度: ${act6Result.data.auto_battle.final_formation_power}`);

        // ============ 步骤11：验证通关奖励发放 ============
        console.log('\n[步骤11] 验证通关奖励发放...');

        const rewards = act6Result.data.rewards;
        assert(rewards, '应返回 rewards 摘要');
        assert(rewards.normal_drops.length === 4, `4名成员应有4条 normal_drops 记录，实际 ${rewards.normal_drops.length}`);

        // 验证基础奖励：60000修为 + 25000灵石 + 120神识（受 harvest_multiplier=1.55 影响）
        const leaderDrops = rewards.normal_drops.find(d => d.player_id === leaderPlayer.id);
        assert(leaderDrops, '应有队长奖励记录');
        const baseExp = leaderDrops.drops.find(d => d.type === 'exp' && !d.source);
        assert(baseExp, '应有基础修为奖励');
        // harvest_multiplier=1.55，基础修为=60000*1.55=93000
        const expectedBaseExp = Math.floor(60000 * 1.55);
        assert(parseInt(baseExp.count) === expectedBaseExp, `基础修为应为 ${expectedBaseExp}（60000*1.55），实际 ${baseExp.count}`);

        const baseSpiritStones = leaderDrops.drops.find(d => d.type === 'spirit_stones' && !d.source);
        assert(baseSpiritStones, '应有基础灵石奖励');
        const expectedBaseStones = Math.floor(25000 * 1.55);
        assert(parseInt(baseSpiritStones.count) === expectedBaseStones, `基础灵石应为 ${expectedBaseStones}（25000*1.55），实际 ${baseSpiritStones.count}`);

        const baseDivineSense = leaderDrops.drops.find(d => d.type === 'divine_sense');
        assert(baseDivineSense, '应有神识奖励');
        assert(baseDivineSense.count === 120, `神识应为120，实际 ${baseDivineSense.count}`);

        // ============ 步骤12：验证冷却记录写入 ============
        console.log('\n[步骤12] 验证冷却记录写入...');

        const cooldowns = await MultiDungeonCooldown.findAll({
            where: { instance_id: instanceId }
        });
        assert(cooldowns.length === 4, `4名成员应有4条冷却记录，实际 ${cooldowns.length}`);
        assert(cooldowns[0].reason === 'cleared', `冷却原因应为 cleared，实际 ${cooldowns[0].reason}`);
        assert(cooldowns[0].cooldown_hours === 48, `冷却时长应为48小时，实际 ${cooldowns[0].cooldown_hours}`);

        // 验证实例状态
        const finalInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(finalInstance.instance_state === 'cleared', `副本状态应为 cleared，实际 ${finalInstance.instance_state}`);
        assert(finalInstance.cleared_at !== null, 'cleared_at 不应为 null');
        assert(finalInstance.first_clear === 1 || finalInstance.first_clear === 0, 'first_clear 应为0或1');
        // 验证虚天殿专属字段最终值
        assert(finalInstance.path_choice === 2, `最终 path_choice 应为2（火道），实际 ${finalInstance.path_choice}`);
        assert(finalInstance.formation_power === 100, `最终 formation_power 应为100，实际 ${finalInstance.formation_power}`);
        assert(finalInstance.void_soul_hp !== null, 'void_soul_hp 不应为 null（已进入第六幕）');

        // ============ 步骤13：验证 status 接口 ============
        console.log('\n[步骤13] 验证 status 接口（已通关后查询应返回 has_instance=false）...');

        const statusResult = await MultiDungeonService.getStatus(leaderPlayer.id);
        assert(statusResult.success, 'status 接口应成功');
        assert(statusResult.data.has_instance === false, '通关后应无进行中副本');

        // ============ 步骤14：验证 getHelp 包含 xutian ============
        console.log('\n[步骤14] 验证 getHelp 包含 xutian...');

        const helpResult = await MultiDungeonService.getHelp();
        assert(helpResult.success, 'getHelp 应成功');
        assert(helpResult.data.dungeons.xutian, 'getHelp 应包含 xutian');
        assert(helpResult.data.dungeons.xutian.name === '虚天殿', `xutian 名称应正确，实际 "${helpResult.data.dungeons.xutian.name}"`);
        assert(helpResult.data.dungeons.xutian.member_max === 6, `xutian 成员上限应为6`);
        assert(helpResult.data.dungeons.xutian.member_min === 4, `xutian 成员下限应为4`);
        assert(helpResult.data.dungeons.xutian.act_count === 6, `xutian 应有6幕`);

        // ============ 步骤15：验证 getRewards 返回完整奖励池 ============
        console.log('\n[步骤15] 验证 getRewards 返回 xutian 奖励池...');

        const rewardsResult = await MultiDungeonService.getRewards('xutian');
        assert(rewardsResult.success, 'getRewards 应成功');
        assert(rewardsResult.data.rewards.base_rewards.length === 3, `基础奖励应有3项，实际 ${rewardsResult.data.rewards.base_rewards.length}`);
        assert(rewardsResult.data.rewards.normal_drops.length === 7, `普通掉落应有7种，实际 ${rewardsResult.data.rewards.normal_drops.length}`);
        assert(rewardsResult.data.rewards.rare_drop.item_key === 'xutian_cauldron', `稀有掉落应为虚天鼎`);
        assert(rewardsResult.data.rewards.rare_drop.chance === 0.001, `稀有掉落概率应为0.001`);

        // ============ 步骤16：验证 getCooldown 包含 xutian ============
        console.log('\n[步骤16] 验证 getCooldown 包含 xutian 冷却记录...');

        const cooldownResult = await MultiDungeonService.getCooldown(leaderPlayer.id);
        assert(cooldownResult.success, 'getCooldown 应成功');
        assert(cooldownResult.data.cooldowns.xutian, '应返回 xutian 冷却状态');
        assert(cooldownResult.data.cooldowns.xutian.in_cooldown === true, 'xutian 应处于冷却中');
        assert(cooldownResult.data.cooldowns.xutian.cooldown_hours === 48, `冷却时长应为48小时，实际 ${cooldownResult.data.cooldowns.xutian.cooldown_hours}`);

        // ============ 步骤17：验证 gmResetCooldown 支持 xutian ============
        console.log('\n[步骤17] 验证 gmResetCooldown 支持 xutian（使用队长玩家ID作为admin）...');

        const resetResult = await MultiDungeonService.gmResetCooldown(leaderPlayer.id, 'xutian', leaderPlayer.id);
        assert(resetResult.success, 'gmResetCooldown 重置 xutian 冷却应成功: ' + (resetResult.message || ''));

        // 验证冷却已被重置
        const cooldownAfterReset = await MultiDungeonService.getCooldown(leaderPlayer.id);
        assert(cooldownAfterReset.data.cooldowns.xutian.in_cooldown === false, '重置后 xutian 应不在冷却中');

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
    console.log('[虚天殿] 端到端测试结果');
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
