/**
 * 复活并提升已死亡玩家到化神期，用于神识对决多人测试
 *
 * 操作内容：
 *   1. 选择 id=9（叶天帝）已死亡玩家复活
 *   2. 设置密码为 username（w225155）便于登录
 *   3. 提升到化神初期（realm_rank=23）
 *   4. 设置足够的神识余额（500）和灵石（100000）
 *   5. 寿元充足（lifespan_current=2000, lifespan_max=2000）
 *   6. HP/MP 满
 *
 * 注意：此脚本仅用于测试环境，生产环境禁用
 */
'use strict';

require('dotenv').config();
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');

async function main() {
    const targetPlayerId = 9;
    const targetPassword = 'w225155';

    console.log('========================================================');
    console.log(`  复活并提升玩家 id=${targetPlayerId} 到化神期`);
    console.log('========================================================');

    // 1. 查询目标玩家当前状态
    const [rows] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, is_dead, is_banned, hp_current, mp_current,
                lifespan_current, lifespan_max, divine_sense_balance, spirit_stones
         FROM players WHERE id = ?`,
        { replacements: [targetPlayerId] }
    );
    if (rows.length === 0) {
        console.log(`  ❌ 玩家 id=${targetPlayerId} 不存在`);
        process.exit(1);
    }
    const before = rows[0];
    console.log('\n修改前：');
    console.log(`  id=${before.id}, username=${before.username}, nickname=${before.nickname}`);
    console.log(`  ${before.realm}(rank=${before.realm_rank}), is_dead=${before.is_dead}, is_banned=${before.is_banned}`);
    console.log(`  HP=${before.hp_current}, MP=${before.mp_current}, 神识=${before.divine_sense_balance}, 灵石=${before.spirit_stones}`);
    console.log(`  寿元=${before.lifespan_current}/${before.lifespan_max}`);

    // 2. 生成 bcrypt 密码哈希
    const saltRounds = 10;
    const salt = await bcrypt.genSalt(saltRounds);
    const hashedPassword = await bcrypt.hash(targetPassword, salt);
    console.log(`\n生成密码哈希成功（${targetPassword}）`);

    // 3. 更新玩家：复活 + 提升化神期 + 设置资源（不显式设置 updated_at，由数据库/Sequelize 自动处理）
    // 注意：lifespan_current 必须小于 lifespan_max，否则 LifespanService 立即触发寿元耗尽
    await sequelize.query(
        `UPDATE players SET
            is_dead = 0,
            is_banned = 0,
            death_reason = NULL,
            death_time = NULL,
            realm = '化神初期',
            realm_rank = 23,
            hp_current = 10000,
            mp_current = 100000,
            lifespan_current = 100,
            lifespan_max = 2000,
            divine_sense_balance = 500,
            spirit_stones = 100000,
            password = ?,
            bottleneck_state = 'none',
            is_secluded = 0,
            is_meditating = 0,
            divine_duel_challenge_date = NULL,
            divine_duel_accept_date = NULL
         WHERE id = ?`,
        { replacements: [hashedPassword, targetPlayerId] }
    );
    console.log(`\n✅ 玩家已复活并提升到化神初期`);

    // 4. 查询修改后状态
    const [afterRows] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, is_dead, is_banned, hp_current, mp_current,
                lifespan_current, lifespan_max, divine_sense_balance, spirit_stones
         FROM players WHERE id = ?`,
        { replacements: [targetPlayerId] }
    );
    const after = afterRows[0];
    console.log('\n修改后：');
    console.log(`  id=${after.id}, username=${after.username}, nickname=${after.nickname}`);
    console.log(`  ${after.realm}(rank=${after.realm_rank}), is_dead=${after.is_dead}, is_banned=${after.is_banned}`);
    console.log(`  HP=${after.hp_current}, MP=${after.mp_current}, 神识=${after.divine_sense_balance}, 灵石=${after.spirit_stones}`);
    console.log(`  寿元=${after.lifespan_current}/${after.lifespan_max}`);

    // 5. 验证当前化神期玩家数
    const [huashenCount] = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM players WHERE realm_rank >= 23 AND is_banned = 0 AND is_dead = 0`
    );
    console.log(`\n当前活跃化神期玩家数：${huashenCount[0].cnt}`);

    console.log('\n========================================================');
    console.log('  完成！现在可以运行 e2e 测试');
    console.log(`  账号1: 1592363624 / 1592363624 (韩天尊)`);
    console.log(`  账号2: ${targetPassword} / ${targetPassword} (叶天帝)`);
    console.log('========================================================');

    process.exit(0);
}

main().catch(e => {
    console.error('脚本异常:', e);
    process.exit(1);
});
