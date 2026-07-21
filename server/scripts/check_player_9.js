/**
 * 直接查询玩家 id=9 的状态
 */
'use strict';

require('dotenv').config();
const sequelize = require('../config/database');

async function main() {
    const [rows] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, is_dead, is_banned, hp_current,
                lifespan_current, lifespan_max, divine_sense_balance, spirit_stones,
                death_reason, death_time, bottleneck_state
         FROM players WHERE id = 9`
    );
    console.log('玩家 id=9 状态：');
    console.log(JSON.stringify(rows[0], null, 2));

    // 同时查询所有活跃玩家（不限 rank）
    const [active] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, is_dead, is_banned
         FROM players WHERE is_banned = 0 AND is_dead = 0
         ORDER BY id ASC`
    );
    console.log('\n所有活跃玩家：');
    active.forEach(p => {
        console.log(`  - id=${p.id}, username=${p.username}, nickname=${p.nickname}, ${p.realm}(rank=${p.realm_rank})`);
    });

    process.exit(0);
}

main().catch(e => {
    console.error('脚本异常:', e);
    process.exit(1);
});
