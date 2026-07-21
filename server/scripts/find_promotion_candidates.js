/**
 * 查找可提升为化神期的候选玩家
 *
 * 策略：
 *   1. 优先选择境界最高的非化神期玩家（最接近化神期）
 *   2. 不影响已存在的化神期玩家
 *   3. 显示前 5 名候选玩家信息
 */
'use strict';

require('dotenv').config();
const sequelize = require('../config/database');

async function main() {
    console.log('========================================================');
    console.log('  查找可提升为化神期的候选玩家');
    console.log('========================================================');

    // 列出当前化神期玩家
    const [huashenPlayers] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank FROM players
         WHERE realm_rank >= 23 AND is_banned = 0 AND is_dead = 0
         ORDER BY id ASC`
    );
    console.log(`\n当前化神期玩家 (${huashenPlayers.length} 人)：`);
    huashenPlayers.forEach(p => {
        console.log(`  - id=${p.id}, username=${p.username}, nickname=${p.nickname}, ${p.realm}(rank=${p.realm_rank})`);
    });

    // 列出候选玩家（非化神期，放宽条件以查看所有玩家）
    const [candidates] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, spirit_stones, hp_current,
                mp_current, lifespan_current, lifespan_max, mortal_age, heavenly_age,
                divine_sense_balance, is_banned, is_dead
         FROM players
         WHERE realm_rank < 23
         ORDER BY realm_rank DESC, id ASC
         LIMIT 10`
    );
    console.log(`\n候选提升玩家（按境界降序，前 10，含已死亡/封禁）：`);
    candidates.forEach((p, idx) => {
        const status = [];
        if (p.is_banned) status.push('封禁');
        if (p.is_dead) status.push('已死亡');
        const statusStr = status.length > 0 ? ` [${status.join(',')}]` : '';
        console.log(`  ${idx + 1}. id=${p.id}, username=${p.username}, nickname=${p.nickname}, ${p.realm}(rank=${p.realm_rank})${statusStr}`);
        console.log(`     灵石=${p.spirit_stones}, HP=${p.hp_current}, MP=${p.mp_current}`);
        console.log(`     寿元=${p.lifespan_current}/${p.lifespan_max}, 凡龄=${p.mortal_age}, 天龄=${p.heavenly_age}, 神识=${p.divine_sense_balance}`);
    });

    // 同时查询玩家总数（不限 is_banned/is_dead）
    const [totalAllRow] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM players`
    );
    console.log(`\n数据库总玩家数（含封禁/死亡）：${totalAllRow[0].total}`);

    // 列出所有玩家数量
    const [totalRow] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM players WHERE is_banned = 0 AND is_dead = 0`
    );
    console.log(`\n总活跃玩家数：${totalRow[0].total}`);

    process.exit(0);
}

main().catch(e => {
    console.error('脚本异常:', e);
    process.exit(1);
});
