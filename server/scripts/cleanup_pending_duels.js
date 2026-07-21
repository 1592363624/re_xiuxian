/**
 * 清理数据库中所有未完成的神识对决对局
 * 用于 e2e 测试前的环境清理
 */
'use strict';

require('dotenv').config();
const sequelize = require('../config/database');

async function main() {
    // 查询所有未完成对局
    const [pending] = await sequelize.query(
        `SELECT id, challenger_id, defender_id, status, bet_type, bet_amount, created_at
         FROM player_divine_duels
         WHERE status IN ('pending', 'active')
         ORDER BY id ASC`
    );
    console.log(`未完成对局数：${pending.length}`);
    pending.forEach(d => {
        console.log(`  - duel_id=${d.id}, challenger=${d.challenger_id}, defender=${d.defender_id}, status=${d.status}, bet=${d.bet_type}:${d.bet_amount}`);
    });

    if (pending.length === 0) {
        console.log('无需清理 pending/active 对局');
    } else {
        // 退还赌注（保险起见，避免资产流失）
        // 实际上对局取消时应该已经退款，这里仅清理对局记录
        console.log('\n清理未完成对局...');

        // 将所有 pending/active 对局标记为 cancelled
        const [result] = await sequelize.query(
            `UPDATE player_divine_duels
             SET status = 'cancelled',
                 settle_reason = 'manual_cleanup',
                 finished_at = NOW()
             WHERE status IN ('pending', 'active')`
        );
        console.log(`已清理 ${result.affectedRows} 条对局记录（标记为 cancelled）`);
    }

    // 同时删除所有 cancelled 对局（_countTodayChallenges 按 created_at 计数，不限 status）
    // 这样可以重置今日发起/接受次数
    const [delResult] = await sequelize.query(
        `DELETE FROM player_divine_duels WHERE status = 'cancelled'`
    );
    console.log(`已删除 ${delResult.affectedRows} 条 cancelled 对局记录（重置每日次数计数）`);

    // 重置双方玩家的 divine_duel_challenge_date 和 divine_duel_accept_date
    await sequelize.query(
        `UPDATE players SET divine_duel_challenge_date = NULL WHERE divine_duel_challenge_date IS NOT NULL`
    );
    await sequelize.query(
        `UPDATE players SET divine_duel_accept_date = NULL WHERE divine_duel_accept_date IS NOT NULL`
    );
    console.log('已重置双方玩家的每日对决次数标记');

    // 验证清理后状态
    const [remaining] = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM player_divine_duels WHERE status IN ('pending', 'active')`
    );
    console.log(`\n清理后未完成对局数：${remaining[0].cnt}`);

    process.exit(0);
}

main().catch(e => {
    console.error('脚本异常:', e);
    process.exit(1);
});
