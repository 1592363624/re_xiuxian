/**
 * 落云秘圃多人剧情副本端到端测试
 *
 * 测试目标：
 *   1. 验证3-5人组队副本的创建、加入、进入开打完整流程
 *   2. 验证第1幕"破禁入圃"破禁策略对灵脉之力（spirit_vein_power）/根脉稳定（root_stability）的影响
 *   3. 验证第2幕"护根稳压"护根策略对灵植灵气（spirit_plant_aura）/枝桠活力（branch_vigor）的影响
 *   4. 验证第3幕"截枝封灵"截枝决策的三种路径：
 *      - cut_seal（截枝封灵）：必得灵眼树胚（lingyan_sapling），但根脉崩塌
 *      - branch_care（留枝养灵）：25% 几率掉落灵眼树胚，根脉保持
 *      - balanced_harvest（均衡采枝）：50% 几率掉落灵眼树胚，平衡收益与根脉
 *   5. 验证第3幕通关条件：root_stability >= 50（final_root_stability_target）
 *   6. 验证完美通关判定（root_stability>70 且 spirit_plant_aura>50）与奖励发放
 *   7. 验证灵眼树胚掉落逻辑（act3_choice 决定掉落率）
 *   8. 验证稀有掉落/称号奖励
 *
 * 测试策略：
 *   - 直接调用 Service 层方法，绕过 HTTP 层（避免登录与多玩家协作复杂度）
 *   - 使用临时测试小号作为队长+队员
 *   - 主测试路径：seek_crack → infuse_aura → cut_seal（必得灵眼树胚）
 *   - 辅助测试路径：seek_crack → wait_calm → branch_care（验证低几率掉落）
 *   - 测试结束后清理所有临时数据
 *
 * 运行方式：node scripts/_test_luoyun.js
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
// 注：以 realm_breakthrough.json 实际映射为准：rank 21=元婴后期, 23=化神初期
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
async function createTestPlayer(nickname, realmRank = 21) {
    const realmName = RANK_TO_REALM[realmRank] || '元婴后期';
    const player = await Player.create({
        username: `test_luoyun_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
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

    // 清理冷却记录与玩家
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
    console.log('[落云秘圃] 端到端测试开始');
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

    try {
        // ============ 步骤0：准备测试玩家 ============
        console.log('\n[步骤0] 准备4名测试玩家（1队长+3队员）...');
        // 队长需化神初期 rank=23（落云秘圃队长要求）
        const leaderPlayer = await createTestPlayer('测试队长_落云秘圃', 23);
        // 队员需元婴后期 rank=21（落云秘圃队员要求）
        const memberPlayers = [
            await createTestPlayer('测试队员1_落云', 21),
            await createTestPlayer('测试队员2_落云', 21),
            await createTestPlayer('测试队员3_落云', 21)
        ];
        testPlayerIds.push(leaderPlayer.id, ...memberPlayers.map(p => p.id));
        console.log(`  队长ID: ${leaderPlayer.id} (${leaderPlayer.realm})`);
        memberPlayers.forEach((p, i) => console.log(`  队员${i + 1}ID: ${p.id} (${p.realm})`));

        // 给队长发放落云秘匙（入圃凭证）
        try {
            await InventoryService.addItem(leaderPlayer.id, 'luoyun_secret_key', 1);
            console.log('  已发放落云秘匙×1 给队长');
        } catch (e) {
            console.warn(`  发放落云秘匙失败: ${e.message}`);
        }

        // ============ 步骤1：验证前置条件校验 ============
        console.log('\n[步骤1] 验证前置条件校验...');

        // 1.1 验证非法 dungeon_key 被拒绝
        const invalidKeyResult = await MultiDungeonService.create(leaderPlayer.id, 'invalid_key');
        assert(!invalidKeyResult.success, '非法 dungeon_key 应被拒绝');
        assert(invalidKeyResult.message.includes('luoyun'), '错误消息应包含 luoyun 提示');

        // 1.2 验证境界不足的队员尝试开本被拒
        const lowRealmPlayer = memberPlayers[0]; // 元婴后期 rank=21，需 rank=23（化神初期）
        const lowRealmResult = await MultiDungeonService.create(lowRealmPlayer.id, 'luoyun');
        assert(!lowRealmResult.success, '元婴后期尝试开落云秘圃应被拒（需化神初期）');

        // ============ 步骤2：队长创建副本 ============
        console.log('\n[步骤2] 队长创建落云秘圃副本...');

        const createResult = await MultiDungeonService.create(leaderPlayer.id, 'luoyun');
        assert(createResult.success, '队长创建落云秘圃副本应成功: ' + (createResult.message || ''));
        assert(createResult.data.dungeon_key === 'luoyun', '副本键应为 luoyun');
        assert(createResult.data.instance_state === 'preparing', '初始状态应为 preparing');
        assert(createResult.data.member_max === 5, '成员上限应为5');
        assert(createResult.data.member_min === 3, '成员下限应为3');
        const instanceId = createResult.data.instance_id;
        testInstanceIds.push(instanceId);
        console.log(`  副本实例ID: ${instanceId}`);

        // 验证实例变量正确初始化（含落云秘圃专属变量）
        const instance = await MultiDungeonInstance.findByPk(instanceId);
        assert(instance.morale === 70, `士气应初始化为70，实际 ${instance.morale}`);
        assert((instance.spirit_vein_power || 0) === 60, `灵脉之力应初始化为60，实际 ${instance.spirit_vein_power}`);
        assert((instance.root_stability || 0) === 80, `根脉稳定应初始化为80，实际 ${instance.root_stability}`);
        assert((instance.branch_vigor || 0) === 50, `枝桠活力应初始化为50，实际 ${instance.branch_vigor}`);
        assert((instance.spirit_plant_aura || 0) === 30, `灵植灵气应初始化为30，实际 ${instance.spirit_plant_aura}`);
        assert(instance.act3_choice === null, `act3_choice 应初始化为 null，实际 ${instance.act3_choice}`);

        // ============ 步骤3：队员加入副本 ============
        console.log('\n[步骤3] 3名队员加入副本...');

        for (let i = 0; i < memberPlayers.length; i++) {
            const joinResult = await MultiDungeonService.join(memberPlayers[i].id, instanceId);
            assert(joinResult.success, `队员${i + 1}加入副本应成功: ${joinResult.message || ''}`);
        }

        // 验证成员数达到4
        const refreshedInstance = await MultiDungeonInstance.findByPk(instanceId);
        assert(refreshedInstance.member_count === 4, `成员数应为4，实际 ${refreshedInstance.member_count}`);

        // ============ 步骤4：队长进入开打 ============
        console.log('\n[步骤4] 队长进入开打...');

        const enterResult = await MultiDungeonService.enter(leaderPlayer.id);
        assert(enterResult.success, '进入开打应成功: ' + (enterResult.message || ''));
        assert(enterResult.data.instance_state === 'active', '开打后状态应为 active');
        assert(enterResult.data.current_act === 1, '应从第1幕开始');
        assert(enterResult.data.act_name === '破禁入圃', `第1幕名称应为"破禁入圃"，实际 "${enterResult.data.act_name}"`);
        assert(enterResult.data.choices.length === 3, `第1幕应有3个选项，实际 ${enterResult.data.choices.length}`);

        // ============ 步骤5：第一幕 - 破禁入圃 ============
        console.log('\n[步骤5] 第一幕破禁入圃：选择【寻隙而入】（稳妥潜入，损耗小）...');

        const act1Result = await MultiDungeonService.choose(leaderPlayer.id, 'seek_crack');
        assert(act1Result.success, '第一幕抉择应成功: ' + (act1Result.message || ''));
        assert(act1Result.data.current_act === 2, '应推进到第2幕');
        assert(act1Result.data.act_name === '护根稳压', `第2幕名称应为"护根稳压"，实际 "${act1Result.data.act_name}"`);

        // 验证第一幕变量变化：士气-5=65 灵脉-5=55 根脉-5=75 收获+10%=1.1 枝桠+5=55
        const instanceAfterAct1 = await MultiDungeonInstance.findByPk(instanceId);
        assert(instanceAfterAct1.morale === 65, `士气应-5=65，实际 ${instanceAfterAct1.morale}`);
        assert((instanceAfterAct1.spirit_vein_power || 0) === 55, `灵脉之力应-5=55，实际 ${instanceAfterAct1.spirit_vein_power}`);
        assert((instanceAfterAct1.root_stability || 0) === 75, `根脉稳定应-5=75，实际 ${instanceAfterAct1.root_stability}`);
        assert((instanceAfterAct1.branch_vigor || 0) === 55, `枝桠活力应+5=55，实际 ${instanceAfterAct1.branch_vigor}`);

        // 验证抉择记录已写入（含落云秘圃专属字段）
        const act1Choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instanceId, act_number: 1 }
        });
        assert(act1Choices.length === 1, `第一幕应写入1条抉择记录，实际 ${act1Choices.length}`);
        assert(act1Choices[0].spirit_vein_power_change === -5, `灵脉之力变化应记录-5，实际 ${act1Choices[0].spirit_vein_power_change}`);
        assert(act1Choices[0].root_stability_change === -5, `根脉稳定变化应记录-5，实际 ${act1Choices[0].root_stability_change}`);

        // ============ 步骤6：第二幕 - 护根稳压 ============
        console.log('\n[步骤6] 第二幕护根稳压：选择【灌注灵气】（强化根脉，灵气+30 根脉+15）...');

        const act2Result = await MultiDungeonService.choose(leaderPlayer.id, 'infuse_aura');
        assert(act2Result.success, '第二幕抉择应成功: ' + (act2Result.message || ''));
        assert(act2Result.data.current_act === 3, '应推进到第3幕');
        assert(act2Result.data.act_name === '截枝封灵', `第3幕名称应为"截枝封灵"，实际 "${act2Result.data.act_name}"`);

        // 验证第二幕变量变化：灵气+30=30+30=60 根脉+15=75+15=90（>70 完美通关） 枝桠+10=55+10=65
        const instanceAfterAct2 = await MultiDungeonInstance.findByPk(instanceId);
        assert((instanceAfterAct2.spirit_plant_aura || 0) === 60, `灵植灵气应+30=60，实际 ${instanceAfterAct2.spirit_plant_aura}`);
        assert((instanceAfterAct2.root_stability || 0) === 90, `根脉稳定应+15=90，实际 ${instanceAfterAct2.root_stability}`);
        assert((instanceAfterAct2.branch_vigor || 0) === 65, `枝桠活力应+10=65，实际 ${instanceAfterAct2.branch_vigor}`);

        // ============ 步骤7：第三幕 - 截枝封灵（cut_seal 必得灵眼树胚） ============
        console.log('\n[步骤7] 第三幕截枝封灵：选择【截枝封灵】（必得灵眼树胚，但根脉崩塌）...');

        const act3Result = await MultiDungeonService.choose(leaderPlayer.id, 'cut_seal');
        assert(act3Result.success, '第三幕抉择应成功: ' + (act3Result.message || ''));

        // 验证副本通关
        assert(act3Result.data.instance_state === 'cleared', `副本状态应为 cleared，实际 ${act3Result.data.instance_state}`);

        const finalInstance = await MultiDungeonInstance.findByPk(instanceId);
        // 第三幕变量变化：士气-15=65-15=50 根脉-40=90-40=50（正好达到阈值） 枝桠-30=65-30=35 灵气-20=60-20=40
        assert((finalInstance.root_stability || 0) === 50, `根脉稳定应-40=50（达到阈值），实际 ${finalInstance.root_stability}`);
        assert((finalInstance.branch_vigor || 0) === 35, `枝桠活力应-30=35，实际 ${finalInstance.branch_vigor}`);
        assert((finalInstance.spirit_plant_aura || 0) === 40, `灵植灵气应-20=40，实际 ${finalInstance.spirit_plant_aura}`);
        assert(finalInstance.act3_choice === 'cut_seal', `act3_choice 应为 cut_seal，实际 ${finalInstance.act3_choice}`);
        console.log(`  最终状态：根脉=${finalInstance.root_stability}/50 灵气=${finalInstance.spirit_plant_aura}/50 act3_choice=${finalInstance.act3_choice}`);

        // ============ 步骤8：验证通关奖励发放 ============
        console.log('\n[步骤8] 验证通关奖励发放（含落云秘圃专属奖励）...');

        const rewards = act3Result.data.rewards;
        assert(rewards, '应返回 rewards 摘要');
        assert(rewards.normal_drops.length === 4, `4名成员应有4条 normal_drops 记录，实际 ${rewards.normal_drops.length}`);

        // 完美通关判定：根脉稳定>70（实际50，不满足） 灵植灵气>50（实际40，不满足）
        // 注：cut_seal 路径必然导致根脉大幅下降，无法完美通关
        assert(rewards.luoyun_perfect_clear === false, 'cut_seal 路径下应判定为非完美通关（根脉不足70）');

        // 验证灵眼树胚掉落：act3_choice=cut_seal，必掉
        assert(rewards.luoyun_sapling_drop_info, '应返回灵眼树胚掉落信息');
        assert(rewards.luoyun_sapling_drop_info.act3_choice === 'cut_seal', `act3_choice 应为 cut_seal，实际 ${rewards.luoyun_sapling_drop_info.act3_choice}`);
        assert(rewards.luoyun_sapling_drop_info.drop_rate === 1.0, `cut_seal 路径掉落率应为 1.0，实际 ${rewards.luoyun_sapling_drop_info.drop_rate}`);
        assert(rewards.luoyun_sapling_drop_info.dropped === true, `cut_seal 路径应必掉灵眼树胚，实际 dropped=${rewards.luoyun_sapling_drop_info.dropped}`);
        assert(rewards.luoyun_sapling_drop_info.item_key === 'lingyan_sapling', `掉落物品应为 lingyan_sapling，实际 ${rewards.luoyun_sapling_drop_info.item_key}`);
        console.log(`  灵眼树胚掉落：✓ 必掉（cut_seal）→ 玩家ID ${rewards.luoyun_sapling_drop_info.player_id}`);

        // 验证稀有掉落
        if (rewards.luoyun_rare_drops) {
            console.log(`  稀有掉落：${rewards.luoyun_rare_drops.length} 件`);
            rewards.luoyun_rare_drops.forEach(d => {
                console.log(`    - ${d.name}×${d.count} → 玩家ID ${d.player_id}`);
            });
        }

        // ============ 步骤9：验证冷却记录写入 ============
        console.log('\n[步骤9] 验证冷却记录写入...');

        const cooldowns = await MultiDungeonCooldown.findAll({
            where: { instance_id: instanceId }
        });
        assert(cooldowns.length === 4, `4名成员应有4条冷却记录，实际 ${cooldowns.length}`);
        assert(cooldowns[0].reason === 'cleared', `冷却原因应为 cleared，实际 ${cooldowns[0].reason}`);
        assert(cooldowns[0].cooldown_hours === 48, `冷却时长应为48小时，实际 ${cooldowns[0].cooldown_hours}`);

        // ============ 步骤10：验证 status 接口返回落云秘圃专属字段 ============
        console.log('\n[步骤10] 验证 status 接口返回落云秘圃专属字段（通过第二个副本）...');

        // ============ 步骤11：测试 branch_care 路径（验证灵眼树胚低几率掉落） ============
        console.log('\n[步骤11] 创建第二个副本测试 branch_care 路径（灵眼树胚低几率掉落）...');

        const leader2 = await createTestPlayer('测试队长2_落云', 23);
        testPlayerIds.push(leader2.id);
        await InventoryService.addItem(leader2.id, 'luoyun_secret_key', 1);
        const members2 = [
            await createTestPlayer('测试队员4_落云', 21),
            await createTestPlayer('测试队员5_落云', 21),
            await createTestPlayer('测试队员6_落云', 21)
        ];
        testPlayerIds.push(...members2.map(p => p.id));

        const createResult2 = await MultiDungeonService.create(leader2.id, 'luoyun');
        const instanceId2 = createResult2.data.instance_id;
        testInstanceIds.push(instanceId2);
        for (const m of members2) {
            await MultiDungeonService.join(m.id, instanceId2);
        }
        await MultiDungeonService.enter(leader2.id);

        // 推进到第3幕
        // 第1幕：ritual_open（无损，但灵气-15）
        await MultiDungeonService.choose(leader2.id, 'ritual_open');
        // 第2幕：wait_calm（无损，根脉+5 枝桠+5）
        await MultiDungeonService.choose(leader2.id, 'wait_calm');

        // 验证第二个副本 status 返回 luoyun 专属字段
        const statusResult2 = await MultiDungeonService.getStatus(leader2.id);
        assert(statusResult2.success, 'status 接口应成功');
        assert(statusResult2.data.has_instance === true, '应存在进行中的副本');
        assert(statusResult2.data.instance.dungeon_key === 'luoyun', '副本键应为 luoyun');
        const statusVars = statusResult2.data.variables;
        assert(statusVars.spirit_vein_power !== undefined, '应返回 spirit_vein_power 字段');
        assert(statusVars.root_stability !== undefined, '应返回 root_stability 字段');
        assert(statusVars.branch_vigor !== undefined, '应返回 branch_vigor 字段');
        assert(statusVars.spirit_plant_aura !== undefined, '应返回 spirit_plant_aura 字段');
        assert(statusVars.act3_choice !== undefined, '应返回 act3_choice 字段');
        console.log(`  第二副本变量：灵脉=${statusVars.spirit_vein_power} 根脉=${statusVars.root_stability} 枝桠=${statusVars.branch_vigor} 灵气=${statusVars.spirit_plant_aura}`);

        // 第3幕：branch_care（25% 几率掉落灵眼树胚）
        const act3Result2 = await MultiDungeonService.choose(leader2.id, 'branch_care');
        assert(act3Result2.success, '第二副本第三幕 branch_care 抉择应成功: ' + (act3Result2.message || ''));

        const finalInstance2 = await MultiDungeonInstance.findByPk(instanceId2);
        assert(finalInstance2.act3_choice === 'branch_care', `act3_choice 应为 branch_care，实际 ${finalInstance2.act3_choice}`);

        // 验证 branch_care 路径下灵眼树胚掉落信息
        const rewards2 = act3Result2.data.rewards;
        assert(rewards2.luoyun_sapling_drop_info, '应返回灵眼树胚掉落信息');
        assert(rewards2.luoyun_sapling_drop_info.act3_choice === 'branch_care', `act3_choice 应为 branch_care，实际 ${rewards2.luoyun_sapling_drop_info.act3_choice}`);
        assert(rewards2.luoyun_sapling_drop_info.drop_rate === 0.25, `branch_care 路径掉落率应为 0.25，实际 ${rewards2.luoyun_sapling_drop_info.drop_rate}`);
        assert(rewards2.luoyun_sapling_drop_info.rolled === true, `应已掷骰，实际 rolled=${rewards2.luoyun_sapling_drop_info.rolled}`);
        console.log(`  灵眼树胚掉落：branch_care 路径（25%几率），掷骰=${rewards2.luoyun_sapling_drop_info.roll_value?.toFixed(4)}, dropped=${rewards2.luoyun_sapling_drop_info.dropped}`);

        // branch_care 路径下应能完美通关（根脉保持，灵气+20）
        console.log(`  branch_care 路径完美通关判定：${rewards2.luoyun_perfect_clear}`);

        // ============ 步骤12：验证 getHelp 包含 luoyun ============
        console.log('\n[步骤12] 验证 getHelp 包含 luoyun...');

        const helpResult = await MultiDungeonService.getHelp();
        assert(helpResult.success, 'getHelp 应成功');
        assert(helpResult.data.dungeons.luoyun, 'getHelp 应包含 luoyun');
        assert(helpResult.data.dungeons.luoyun.name === '落云秘圃', `luoyun 名称应正确，实际 "${helpResult.data.dungeons.luoyun.name}"`);
        assert(helpResult.data.dungeons.luoyun.member_max === 5, `luoyun 成员上限应为5`);
        assert(helpResult.data.dungeons.luoyun.member_min === 3, `luoyun 成员下限应为3`);

        // ============ 步骤13：验证 getRewards 包含 luoyun 奖励池 ============
        console.log('\n[步骤13] 验证 getRewards 包含 luoyun 奖励池...');

        const rewardsInfoResult = await MultiDungeonService.getRewards('luoyun');
        assert(rewardsInfoResult.success, 'getRewards 应成功');
        assert(rewardsInfoResult.data, '应返回奖励数据');

        // ============ 步骤14：验证 getCooldown 包含 luoyun 冷却 ============
        console.log('\n[步骤14] 验证 getCooldown 包含 luoyun 冷却...');

        const cooldownResult = await MultiDungeonService.getCooldown(leaderPlayer.id);
        assert(cooldownResult.success, 'getCooldown 应成功');
        // getCooldown 返回 data.cooldowns.<key> 结构（与 HTTP 路由一致）
        assert(cooldownResult.data.cooldowns, '应返回 cooldowns 字典');
        assert(cooldownResult.data.cooldowns.luoyun, '应返回 luoyun 冷却状态');
        assert(cooldownResult.data.cooldowns.luoyun.in_cooldown === true, '主队长应处于 luoyun 冷却中');
        console.log(`  luoyun 冷却到期时间: ${cooldownResult.data.cooldowns.luoyun.cooldown_end_time}`);

        // ============ 步骤15：验证 GM 调整落云秘圃变量 ============
        console.log('\n[步骤15] 验证 GM 调整落云秘圃变量（仅做白名单校验）...');

        // 由于副本已通关，这里仅验证 GM 接口的 variable 白名单接受 luoyun 专属变量
        const gmInvalidVarResult = await MultiDungeonService.gmAdjustVariable(99999, 'invalid_var', 50, 1);
        assert(!gmInvalidVarResult.success, '非法 variable 应被拒绝');

        // 验证 act3_choice 字符串变量可调整（用第二副本，已通关但实例仍存在）
        const gmAct3ChoiceResult = await MultiDungeonService.gmAdjustVariable(instanceId2, 'act3_choice', 'cut_seal', 1);
        assert(gmAct3ChoiceResult.success, 'GM 调整 act3_choice 字符串变量应成功: ' + (gmAct3ChoiceResult.message || ''));

        // ============ 总结 ============
        console.log('\n' + '='.repeat(80));
        console.log(`[测试结果] 总计 ${stats.total} 项，通过 ${stats.passed} 项，失败 ${stats.failed} 项`);
        console.log('='.repeat(80));
        if (stats.failed > 0) {
            console.error('\n[失败项详情]');
            stats.failedDetails.forEach((d, i) => console.error(`  ${i + 1}. ${d}`));
        }

    } catch (err) {
        console.error('\n[测试异常]', err);
        console.error(err.stack);
        stats.failed++;
        stats.failedDetails.push(`测试异常: ${err.message}`);
    } finally {
        await cleanupTestData(testPlayerIds, testInstanceIds);
        await sequelize.close();
        process.exit(stats.failed > 0 ? 1 : 0);
    }
}

// 启动测试
runTests().catch(err => {
    console.error('[启动测试失败]', err);
    process.exit(1);
});
