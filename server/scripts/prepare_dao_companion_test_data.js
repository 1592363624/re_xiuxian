/**
 * 道侣护道机制测试数据准备脚本
 *
 * 创建一对测试道侣关系：
 *   - 玩家1（韩天尊，化神初期）作为 player_a_id
 *   - 玩家2（测试玩家）作为 player_b_id
 *   - status = accepted
 *   - intimacy = 60（满足护道最低 50 要求）
 *   - heart_contract_level = 2（满足护道最低 L2 要求）
 *
 * 若已存在道侣关系，先清理后重建
 */
'use strict';

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const { initializeModules } = require('../modules');

async function main() {
    await initializeModules();

    console.log('===== 道侣护道机制测试数据准备 =====\n');

    // 1. 检查玩家1和玩家2是否存在
    const [player1Check] = await sequelize.query(
        `SELECT id, nickname, realm, realm_rank FROM players WHERE id = 1`,
        { type: QueryTypes.SELECT }
    );
    const [player2Check] = await sequelize.query(
        `SELECT id, nickname, realm, realm_rank FROM players WHERE id = 2`,
        { type: QueryTypes.SELECT }
    );

    if (!player1Check) {
        console.error('❌ 玩家1 不存在，无法创建测试道侣关系');
        process.exit(1);
    }
    if (!player2Check) {
        console.error('❌ 玩家2 不存在，无法创建测试道侣关系');
        process.exit(1);
    }

    console.log(`玩家1: ${player1Check.nickname} (${player1Check.realm}, rank=${player1Check.realm_rank})`);
    console.log(`玩家2: ${player2Check.nickname} (${player2Check.realm}, rank=${player2Check.realm_rank})`);

    // 2. 清理玩家1和玩家2的现有道侣关系
    console.log('\n[步骤1] 清理玩家1和玩家2的现有道侣关系...');
    await sequelize.query(
        `DELETE FROM dao_companions WHERE player_a_id IN (1, 2) OR player_b_id IN (1, 2)`
    );
    console.log('  已清理（如有）');

    // 同时清理护道日志
    console.log('[步骤2] 清理现有护道日志...');
    await sequelize.query(
        `DELETE FROM dao_companion_protect_log WHERE defender_id IN (1, 2) OR protector_id IN (1, 2)`
    );
    console.log('  已清理（如有）');

    // 3. 创建测试道侣关系
    console.log('[步骤3] 创建测试道侣关系（玩家1 ↔ 玩家2）...');
    await sequelize.query(
        `INSERT INTO dao_companions (player_a_id, player_b_id, status, intimacy, dual_cultivation_count,
                                     heart_contract_level, heart_imprint_count, created_at, updated_at)
         VALUES (1, 2, 'accepted', 60, 5, 2, 0, NOW(), NOW())`,
        { type: QueryTypes.INSERT }
    );

    // 4. 验证创建结果
    console.log('[步骤4] 验证创建结果...');
    const [newCompanion] = await sequelize.query(
        `SELECT id, player_a_id, player_b_id, status, intimacy, heart_contract_level
         FROM dao_companions WHERE player_a_id = 1 AND player_b_id = 2 AND status = 'accepted'`,
        { type: QueryTypes.SELECT }
    );

    if (newCompanion) {
        console.log('  ✅ 道侣关系创建成功:');
        console.log(`     ID=${newCompanion.id}`);
        console.log(`     A=${newCompanion.player_a_id} B=${newCompanion.player_b_id}`);
        console.log(`     status=${newCompanion.status}`);
        console.log(`     intimacy=${newCompanion.intimacy}`);
        console.log(`     heart_contract_level=${newCompanion.heart_contract_level}`);
        console.log('\n===== 测试数据准备完成 =====');
        console.log('现在可以运行: node scripts/test_dao_companion_protect.js');
        process.exit(0);
    } else {
        console.error('  ❌ 道侣关系创建失败');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('执行失败:', err);
    process.exit(1);
});
