/**
 * 检查数据库中的玩家和道侣关系
 */
'use strict';

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const { initializeModules } = require('../modules');

async function main() {
    await initializeModules();

    // 1. 查询前 10 个玩家
    console.log('\n===== 玩家列表 =====');
    const players = await sequelize.query(
        `SELECT id, nickname, realm, realm_rank FROM players ORDER BY id LIMIT 10`,
        { type: QueryTypes.SELECT }
    );
    players.forEach(p => console.log(`  ID=${p.id} | ${p.nickname} | ${p.realm} (rank=${p.realm_rank})`));

    // 2. 查询所有道侣关系
    console.log('\n===== 道侣关系列表 =====');
    const companions = await sequelize.query(
        `SELECT id, player_a_id, player_b_id, status, intimacy, heart_contract_level, heart_imprint_count,
                last_interaction_time, last_dual_cultivation_time
         FROM dao_companions ORDER BY id LIMIT 20`,
        { type: QueryTypes.SELECT }
    );
    if (companions.length === 0) {
        console.log('  （无道侣关系）');
    } else {
        companions.forEach(c => {
            console.log(`  ID=${c.id} | A=${c.player_a_id} B=${c.player_b_id} | status=${c.status} | intimacy=${c.intimacy} heartLv=${c.heart_contract_level} imprint=${c.heart_imprint_count}`);
        });
    }

    // 3. 查询护道日志表
    console.log('\n===== 护道日志（dao_companion_protect_log） =====');
    const protectLogs = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM dao_companion_protect_log`,
        { type: QueryTypes.SELECT }
    );
    console.log(`  总记录数: ${protectLogs[0].cnt}`);

    process.exit(0);
}

main().catch(err => {
    console.error('执行失败:', err);
    process.exit(1);
});
