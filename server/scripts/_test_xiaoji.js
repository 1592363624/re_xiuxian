/**
 * 北冥小极宫多人剧情副本端到端测试
 *
 * 测试目标：
 *   1. 验证4-5人组队副本的创建、加入、进入开打完整流程
 *   2. 验证第1幕"玄冰花之行"采摘策略（稳采/急采/避让）的变量变化
 *   3. 验证第2幕"五焰冲关"火焰之力与冰封之力相互克制机制
 *   4. 验证第3幕"寒骊翻脸"阴罗宗阴幡镇魂校验（requires_yinluo + 煞气≥50）
 *   5. 验证第4幕"冰海妖围"冰封之力达到100通关条件
 *   6. 验证4个专属变量（咒扰/冰封/火焰/阴罗幡煞气）边界与累积正确
 *   7. 验证完美通关判定（咒扰<30且士气>60）与奖励发放
 *   8. 验证保底掉落/稀有掉落/称号奖励
 *   9. 验证 requires_yinluo 校验失败场景（无阴罗宗队员时拒绝）
 *
 * 测试策略：
 *   - 直接调用 Service 层方法，绕过 HTTP 层（避免4个真实玩家登录复杂度）
 *   - 使用临时测试小号作为队长+队员（含1名阴罗宗弟子）
 *   - 选择 retreat → seal → yinluo_suppress → seal_all 路线触发完美通关
 *   - 测试结束后清理所有临时数据（实例/成员/抉择/冷却/临时玩家/宗门关系）
 *
 * 运行方式：node scripts/_test_xiaoji.js
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
const PlayerSect = require('../models/playerSect');
const MultiDungeonInstance = require('../models/multiDungeonInstance');
const MultiDungeonMember = require('../models/multiDungeonMember');
const MultiDungeonChoice = require('../models/multiDungeonChoice');
const MultiDungeonCooldown = require('../models/multiDungeonCooldown');
const InventoryService = require('../game/services/InventoryService');
const MultiDungeonService = require('../game/services/MultiDungeonService');

// 境界 rank → 名称映射（避免依赖未初始化的 RealmService）
// 注：以 realm_breakthrough.json 实际映射为准：rank 19=元婴初期, 21=元婴后期, 23=化神初期
const RANK_TO_REALM = {
    19: '元婴初期',
    21: '元婴后期',
    23: '化神初期'
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
async function createTestPlayer(nickname, realmRank = 19) {
    const realmName = RANK_TO_REALM[realmRank] || '元婴初期';
    const player = await Player.create({
        username: `test_xiaoji_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
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
 * 将玩家加入阴罗宗（用于测试阴幡镇魂校验）
 * @param {number} playerId - 玩家ID
 * @returns {Promise<Object>} 宗门成员记录
 */
async function joinYinluoSect(playerId) {
    return await PlayerSect.create({
        player_id: playerId,
        sect_id: 'yinluo',
        contribution: 100,
        role: 'disciple',
        joined_at: new Date(),
        daily_quests_completed: [],
        quests_reset_at: new Date(Date.now() + 86400000)
    });
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

    // 清理冷却记录与宗门关系（按玩家）
    if (playerIds.length > 0) {
        await MultiDungeonCooldown.destroy({ where: { player_id: playerIds }, force: true });
        await MultiDungeonMember.destroy({ where: { player_id: playerIds }, force: true });
        await PlayerSect.destroy({ where: { player_id: playerIds }, force: true });
        // 删除临时玩家
        await Player.destroy({ where: { id: playerIds }, force: true });
        console.log(`[清理] 已删除 ${playerIds.length} 个临时玩家及其宗门关系`);
    }
}

/**
 * 主测试流程
 */
async function runTests() {
    console.log('='.repeat(80));
    console.log('[北冥小极宫] 端到端测试开始');
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
        console.log('\n[步骤0] 准备4名测试玩家（1队长+3队员，含1名阴罗宗弟子）...');
        leaderPlayer = await createTestPlayer('测试队长_小极宫', 21); // 元婴后期 rank=21（队长要求）
        memberPlayers = [
            await createTestPlayer('测试队员1_阴罗宗', 19), // 元婴初期，将加入阴罗宗
            await createTestPlayer('测试队员2_小极宫', 19),
            await createTestPlayer('测试队员3_小极宫', 19)
        ];
        testPlayerIds.push(leaderPlayer.id, ...memberPlayers.map(p => p.id));
        console.log(`  队长ID: ${leaderPlayer.id} (${leaderPlayer.realm})`);
        memberPlayers.forEach((p, i) => console.log(`  队员${i + 1}ID: ${p.id} (${p.realm})`));

        // 将队员1加入阴罗宗（用于测试阴幡镇魂）
        await joinYinluoSect(memberPlayers[0].id);
        console.log(`  队员1 已加入阴罗宗`);

        // 给队长发放北冥寒令（入宫凭证）
        try {
            await InventoryService.addItem(leaderPlayer.id, 'beiming_cold_token', 1);
            console.log('  已发放北冥寒令×1 给队长');
        } catch (e) {
            console.warn(`  发放北冥寒令失败: ${e.message}`);
        }

        // ============ 步骤1：验证前置条件校验 ============
        console.log('\n[步骤1] 验证前置条件校验...');

        // 1.1 验证非法 dungeon_key 被拒绝
        const invalidKeyResult = await MultiDungeonService.create(leaderPlayer.id, 'invalid_key');
        assert(!invalidKeyResult.success, '非法 dungeon_key 应被拒绝');
        assert(invalidKeyResult.message.includes('xiaoji'), '错误消息应包含 xiaoji 提示');

        // 1.2 验证境界不足的队员尝试开本被拒
        const lowRealmPlayer = memberPlayers[0]; // 元婴初期 rank=19，需 rank=21（元婴后期）
        const lowRealmResult = await MultiDungeonService.create(lowRealmPlayer.id, 'xiaoji');
        assert(!lowRealmResult.success, '元婴初期尝试开小极宫应被拒（需元婴后期）');

        // ============ 步骤2：队长创建副本 ============
        console.log('\n[步骤2] 队长创建小极宫副本...');

        const createResult = await MultiDungeonService.create(leaderPlayer.id, 'xiaoji');
        assert(createResult.success, '队长创建小极宫副本应成功: ' + (createResult.message || ''));
        assert(createResult.data.dungeon_key === 'xiaoji', '副本键应为 xiaoji');
        assert(createResult.data.instance_state === 'preparing', '初始状态应为 preparing');
        assert(createResult.data.member_max === 5, '成员上限应为5');
        assert(createResult.data.member_min === 4, '成员下限应为4');
        const instanceId = createResult.data.instance_id;
        testInstanceIds.push(instanceId);
        console.log(`  副本实例ID: ${instanceId}`);

        // 验证实例变量正确初始化（含小极宫专属变量）
        const instance = await MultiDungeonInstance.findByPk(instanceId);
        assert(instance.morale === 80, `士气应初始化为80，实际 ${instance.morale}`);
        assert(instance.vigilance === 30, `警戒应初始化为30，实际 ${instance.vigilance}`);
        assert((instance.curse_disorder || 0) === 0, `咒扰应初始化为0，实际 ${instance.curse_disorder}`);
        assert((instance.ice_seal_power || 0) === 50, `冰封之力应初始化为50，实际 ${instance.ice_seal_power}`);
        assert((instance.flame_power || 0) === 0, `火焰之力应初始化为0，实际 ${instance.flame_power}`);
        assert((instance.yinluo_banner_qi || 0) === 0, `阴罗幡煞气应初始化为0（队长非阴罗宗），实际 ${instance.yinluo_banner_qi}`);

        // ============ 步骤3：队员加入副本 ============
        console.log('\n[步骤3] 3名队员加入副本（含1名阴罗宗弟子）...');

        for (let i = 0; i < memberPlayers.length; i++) {
            const joinResult = await MultiDungeonService.join(memberPlayers[i].id, instanceId);
            assert(joinResult.success, `队员${i + 1}加入副本应成功: ${joinResult.message || ''}`);
        }

        // 验证成员数达到4
        const refreshedInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(refreshedInstance.member_count === 4, `成员数应为4，实际 ${refreshedInstance.member_count}`);

        // 验证阴罗宗弟子加入后阴罗幡煞气累加（每名阴罗宗弟子+100）
        assert((refreshedInstance.yinluo_banner_qi || 0) === 100, `阴罗幡煞气应为100（1名阴罗宗弟子×100），实际 ${refreshedInstance.yinluo_banner_qi}`);

        // ============ 步骤4：队长进入开打 ============
        console.log('\n[步骤4] 队长进入开打...');

        const enterResult = await MultiDungeonService.enter(leaderPlayer.id);
        assert(enterResult.success, '进入开打应成功: ' + (enterResult.message || ''));
        assert(enterResult.data.instance_state === 'active', '开打后状态应为 active');
        assert(enterResult.data.current_act === 1, '应从第1幕开始');
        assert(enterResult.data.act_name === '玄冰花之行', `第1幕名称应为"玄冰花之行"，实际 "${enterResult.data.act_name}"`);
        assert(enterResult.data.choices.length === 3, `第1幕应有3个选项，实际 ${enterResult.data.choices.length}`);

        // ============ 步骤5：第一幕 - 玄冰花之行 ============
        console.log('\n[步骤5] 第一幕玄冰花之行：选择【避让】（提升士气+降低咒扰，为完美通关铺垫）...');

        const act1Result = await MultiDungeonService.choose(leaderPlayer.id, 'retreat');
        assert(act1Result.success, '第一幕抉择应成功: ' + (act1Result.message || ''));
        assert(act1Result.data.current_act === 2, '应推进到第2幕');
        assert(act1Result.data.act_name === '五焰冲关', `第2幕名称应为"五焰冲关"，实际 "${act1Result.data.act_name}"`);

        // 验证第一幕变量变化：士气+5=85 咒扰-5=0 收获-10%
        const instanceAfterAct1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct1.morale === 85, `士气应+5=85，实际 ${instanceAfterAct1.morale}`);
        assert((instanceAfterAct1.curse_disorder || 0) === 0, `咒扰应-5=0（clamped），实际 ${instanceAfterAct1.curse_disorder}`);

        // 验证抉择记录已写入（含小极宫专属字段）
        const act1Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 1 }
        });
        assert(act1Choices.length === 1, `第一幕应写入1条抉择记录，实际 ${act1Choices.length}`);
        assert(act1Choices[0].curse_disorder_change === -5, `咒扰变化应记录-5，实际 ${act1Choices[0].curse_disorder_change}`);

        // ============ 步骤6：第二幕 - 五焰冲关 ============
        console.log('\n[步骤6] 第二幕五焰冲关：选择【封焰】（用冰封之力封印火焰，冰封+15）...');

        const act2Result = await MultiDungeonService.choose(leaderPlayer.id, 'seal');
        assert(act2Result.success, '第二幕抉择应成功: ' + (act2Result.message || ''));
        assert(act2Result.data.current_act === 3, '应推进到第3幕');
        assert(act2Result.data.act_name === '寒骊翻脸', `第3幕名称应为"寒骊翻脸"，实际 "${act2Result.data.act_name}"`);

        // 验证第二幕变量变化：冰封+15=65 火焰-20=0
        const instanceAfterAct2 = await MultiDungeonInstance.findByPk(instanceId);
        assert((instanceAfterAct2.ice_seal_power || 0) === 65, `冰封之力应+15=65，实际 ${instanceAfterAct2.ice_seal_power}`);
        assert((instanceAfterAct2.flame_power || 0) === 0, `火焰之力应-20=0（clamped），实际 ${instanceAfterAct2.flame_power}`);

        // ============ 步骤7：第三幕 - 寒骊翻脸（阴幡镇魂） ============
        console.log('\n[步骤7] 第三幕寒骊翻脸：选择【阴幡镇魂】（需阴罗宗弟子+煞气≥50）...');

        // 7.1 先验证无阴罗宗队员时阴幡镇魂被拒（创建第二个副本测试）
        console.log('  7.1 验证 requires_yinluo 校验：无阴罗宗弟子时应被拒...');
        const leader2 = await createTestPlayer('测试队长2_无阴罗', 21);
        testPlayerIds.push(leader2.id);
        await InventoryService.addItem(leader2.id, 'beiming_cold_token', 1);
        const members2 = [
            await createTestPlayer('测试队员4_无阴罗', 19),
            await createTestPlayer('测试队员5_无阴罗', 19),
            await createTestPlayer('测试队员6_无阴罗', 19)
        ];
        testPlayerIds.push(...members2.map(p => p.id));

        const createResult2 = await MultiDungeonService.create(leader2.id, 'xiaoji');
        const instanceId2 = createResult2.data.instance_id;
        testInstanceIds.push(instanceId2);
        for (const m of members2) {
            await MultiDungeonService.join(m.id, instanceId2);
        }
        await MultiDungeonService.enter(leader2.id);
        // 推进到第3幕
        await MultiDungeonService.choose(leader2.id, 'retreat'); // 第1幕
        await MultiDungeonService.choose(leader2.id, 'seal');     // 第2幕
        // 第3幕尝试阴幡镇魂（无阴罗宗弟子，应被拒）
        const yinluoRejectResult = await MultiDungeonService.choose(leader2.id, 'yinluo_suppress');
        assert(!yinluoRejectResult.success, '无阴罗宗弟子时阴幡镇魂应被拒');
        assert(yinluoRejectResult.message.includes('阴罗宗'), `错误消息应包含"阴罗宗"，实际："${yinluoRejectResult.message}"`);
        console.log('  ✓ 无阴罗宗弟子时阴幡镇魂被正确拒绝');

        // 7.2 回到主副本：有阴罗宗弟子时阴幡镇魂应成功
        console.log('  7.2 主副本（有阴罗宗弟子）选择阴幡镇魂...');
        const act3Result = await MultiDungeonService.choose(leaderPlayer.id, 'yinluo_suppress');
        assert(act3Result.success, '有阴罗宗弟子+煞气100≥50时阴幡镇魂应成功: ' + (act3Result.message || ''));
        assert(act3Result.data.current_act === 4, '应推进到第4幕');
        assert(act3Result.data.act_name === '冰海妖围', `第4幕名称应为"冰海妖围"，实际 "${act3Result.data.act_name}"`);

        // 验证第三幕变量变化：咒扰-30=0 煞气-50=50 冰封+10=75
        const instanceAfterAct3 = await MultiDungeonInstance.findByPk(instanceId);
        assert((instanceAfterAct3.curse_disorder || 0) === 0, `咒扰应-30=0（clamped），实际 ${instanceAfterAct3.curse_disorder}`);
        assert((instanceAfterAct3.yinluo_banner_qi || 0) === 50, `阴罗幡煞气应-50=50，实际 ${instanceAfterAct3.yinluo_banner_qi}`);
        assert((instanceAfterAct3.ice_seal_power || 0) === 75, `冰封之力应+10=75，实际 ${instanceAfterAct3.ice_seal_power}`);

        // ============ 步骤8：第四幕 - 冰海妖围（最终决战） ============
        console.log('\n[步骤8] 第四幕冰海妖围：选择【全员封妖】（冰封+25=100，触发通关）...');

        const act4Result = await MultiDungeonService.choose(leaderPlayer.id, 'seal_all');
        assert(act4Result.success, '第四幕抉择应成功: ' + (act4Result.message || ''));

        // 验证副本通关（ice_seal_power 达到 100）
        assert(act4Result.data.instance_state === 'cleared', `副本状态应为 cleared，实际 ${act4Result.data.instance_state}`);
        const finalInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert((finalInstance.ice_seal_power || 0) === 100, `冰封之力应达到100，实际 ${finalInstance.ice_seal_power}`);
        assert((finalInstance.curse_disorder || 0) === 10, `咒扰应为10（<30 完美通关），实际 ${finalInstance.curse_disorder}`);
        assert((finalInstance.morale || 0) === 65, `士气应为65（>60 完美通关），实际 ${finalInstance.morale}`);
        console.log(`  最终状态：冰封=${finalInstance.ice_seal_power}/100 咒扰=${finalInstance.curse_disorder}/30 士气=${finalInstance.morale}/60`);

        // ============ 步骤9：验证通关奖励发放 ============
        console.log('\n[步骤9] 验证通关奖励发放（含小极宫专属奖励）...');

        const rewards = act4Result.data.rewards;
        assert(rewards, '应返回 rewards 摘要');
        assert(rewards.normal_drops.length === 4, `4名成员应有4条 normal_drops 记录，实际 ${rewards.normal_drops.length}`);

        // 验证完美通关标志
        assert(rewards.xiaoji_perfect_clear === true, '应判定为完美通关（咒扰<30且士气>60）');

        // 验证完美破局加成（每人额外获得修为+3000）
        const leaderDrops = rewards.normal_drops.find(d => d.player_id === leaderPlayer.id);
        assert(leaderDrops, '应有队长奖励记录');
        const perfectBonusExp = leaderDrops.drops.find(d => d.source === 'perfect_bonus' && d.type === 'exp');
        assert(perfectBonusExp, '应有完美破局修为加成');
        assert(parseInt(perfectBonusExp.count) === 3000, `完美破局修为应为3000，实际 ${perfectBonusExp.count}`);

        // 验证基础奖励：9000修为 × harvest_multiplier + 1200灵石
        // 注：base_rewards.exp 会被 instance.harvest_multiplier 放大（见 _settleRewards line 2603）
        // 测试路径：retreat(-0.10) + seal(+0.10) + yinluo_suppress(+0.40) + seal_all(+0.20) = +0.60，倍率 1.6
        // 容差 ±1：内存累加 1.5999... 与 DB DECIMAL 1.60 读回存在 1 点精度差异（Math.floor 截断）
        const baseExp = leaderDrops.drops.find(d => d.type === 'exp' && !d.source);
        assert(baseExp, '应有基础修为奖励');
        const expectedBaseExp = Math.floor(9000 * Number(finalInstance.harvest_multiplier));
        assert(Math.abs(parseInt(baseExp.count) - expectedBaseExp) <= 1,
            `基础修为应为 9000×${Number(finalInstance.harvest_multiplier)}≈${expectedBaseExp}（容差±1），实际 ${baseExp.count}`);

        // 验证保底掉落：玄冰花×1 优先分给贡献最高的队员
        assert(rewards.xiaoji_guaranteed_drops && rewards.xiaoji_guaranteed_drops.length > 0, '应有保底掉落记录');
        const guaranteedDrop = rewards.xiaoji_guaranteed_drops[0];
        assert(guaranteedDrop.item_key === 'xuanbing_flower', `保底掉落应为玄冰花，实际 ${guaranteedDrop.item_key}`);
        console.log(`  保底掉落：玄冰花×1 → 玩家ID ${guaranteedDrop.player_id}`);

        // 验证稀有掉落：1-4件按权重加权随机
        if (rewards.xiaoji_rare_drops) {
            console.log(`  稀有掉落：${rewards.xiaoji_rare_drops.length} 件`);
            rewards.xiaoji_rare_drops.forEach(d => {
                console.log(`    - ${d.name}×${d.count} → 玩家ID ${d.player_id}`);
            });
        }

        // ============ 步骤10：验证冷却记录写入 ============
        console.log('\n[步骤10] 验证冷却记录写入...');

        const cooldowns = await MultiDungeonCooldown.findAll({
            where: { instance_id: instanceId }
        });
        assert(cooldowns.length === 4, `4名成员应有4条冷却记录，实际 ${cooldowns.length}`);
        assert(cooldowns[0].reason === 'cleared', `冷却原因应为 cleared，实际 ${cooldowns[0].reason}`);
        assert(cooldowns[0].cooldown_hours === 72, `冷却时长应为72小时，实际 ${cooldowns[0].cooldown_hours}`);

        // ============ 步骤11：验证 status 接口返回小极宫专属字段 ============
        console.log('\n[步骤11] 验证 status 接口返回小极宫专属字段（通过未通关的第二个副本）...');

        // 第二个副本仍在进行中，查询其 status 应返回 xiaoji 专属变量
        const statusResult2 = await MultiDungeonService.getStatus(leader2.id);
        assert(statusResult2.success, 'status 接口应成功');
        assert(statusResult2.data.has_instance === true, '应存在进行中的副本');
        assert(statusResult2.data.instance.dungeon_key === 'xiaoji', '副本键应为 xiaoji');
        const statusVars = statusResult2.data.variables;
        assert(statusVars.curse_disorder !== undefined, '应返回 curse_disorder 字段');
        assert(statusVars.ice_seal_power !== undefined, '应返回 ice_seal_power 字段');
        assert(statusVars.flame_power !== undefined, '应返回 flame_power 字段');
        assert(statusVars.yinluo_banner_qi !== undefined, '应返回 yinluo_banner_qi 字段');
        console.log(`  第二副本变量：咒扰=${statusVars.curse_disorder} 冰封=${statusVars.ice_seal_power} 火焰=${statusVars.flame_power} 煞气=${statusVars.yinluo_banner_qi}`);

        // ============ 步骤12：验证 getHelp 包含 xiaoji ============
        console.log('\n[步骤12] 验证 getHelp 包含 xiaoji...');

        const helpResult = await MultiDungeonService.getHelp();
        assert(helpResult.success, 'getHelp 应成功');
        assert(helpResult.data.dungeons.xiaoji, 'getHelp 应包含 xiaoji');
        assert(helpResult.data.dungeons.xiaoji.name === '北冥小极宫', `xiaoji 名称应正确，实际 "${helpResult.data.dungeons.xiaoji.name}"`);
        assert(helpResult.data.dungeons.xiaoji.member_max === 5, `xiaoji 成员上限应为5`);
        assert(helpResult.data.dungeons.xiaoji.act_count === 4, `xiaoji 应有4幕`);

        // ============ 步骤13：验证 getRewards 返回完整奖励池 ============
        console.log('\n[步骤13] 验证 getRewards 返回 xiaoji 奖励池...');

        const rewardsResult = await MultiDungeonService.getRewards('xiaoji');
        assert(rewardsResult.success, 'getRewards 应成功');
        assert(rewardsResult.data.rewards.base_rewards.length === 2, `基础奖励应有2项，实际 ${rewardsResult.data.rewards.base_rewards.length}`);
        assert(rewardsResult.data.rewards.perfect_bonus.exp === 3000, `完美破局修为应为3000`);
        assert(rewardsResult.data.rewards.guaranteed_drops.length === 1, `保底掉落应有1项`);
        assert(rewardsResult.data.rewards.rare_drops.length === 7, `稀有掉落应有7种，实际 ${rewardsResult.data.rewards.rare_drops.length}`);
        assert(rewardsResult.data.rewards.title === 'beiming_breaker', `称号应为 beiming_breaker`);

        // ============ 步骤14：验证 GM 调整小极宫专属变量 ============
        console.log('\n[步骤14] 验证 GM 调整小极宫专属变量（gmAdjustVariable）...');

        // 使用第二个副本测试 GM 调整小极宫变量
        const gmAdjustResult = await MultiDungeonService.gmAdjustVariable(instanceId2, 'ice_seal_power', 99, leaderPlayer.id);
        assert(gmAdjustResult.success, 'GM 调整 ice_seal_power 应成功: ' + (gmAdjustResult.message || ''));
        const instance2AfterGm = await MultiDungeonInstance.findByPk(instanceId2);
        assert((instance2AfterGm.ice_seal_power || 0) === 99, `GM 调整后冰封之力应为99，实际 ${instance2AfterGm.ice_seal_power}`);

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
    console.log('[北冥小极宫] 端到端测试结果');
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
