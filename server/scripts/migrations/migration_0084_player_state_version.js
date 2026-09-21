/**
 * 迁移脚本 0084：players 增加 state_version 列
 *
 * 用途：给玩家状态一个单调递增的写入版本号。
 * players.attributes 是整块回写的 TEXT JSON，此前没有任何标记能判断
 * "我手上这份快照是不是已经过期"，因此并发写互相覆盖时既不报错也不自愈。
 * PlayerStateStore 在行锁内 +1；整块写回前由 blobWriteGuard 在同一事务里锁读比对，
 * 手上那份比库里旧就直接抛错，而不是把别人的改动覆盖掉。
 */
const sequelize = require('../../config/database');

const migrationInfo = {
    description: 'players 增加 state_version 列，为玩家状态写入提供乐观并发控制标记',
    version: '1.0.0'
};

const COLUMN_SQL = '`state_version` BIGINT NOT NULL DEFAULT 0 COMMENT \'玩家状态写入版本号\'';

async function up() {
    const [columns] = await sequelize.query("SHOW COLUMNS FROM players LIKE 'state_version'");
    if (columns.length > 0) {
        console.log('[Migration 0084] players.state_version 已存在，跳过');
        return;
    }
    await sequelize.query(`ALTER TABLE players ADD COLUMN ${COLUMN_SQL}`);
    console.log('[Migration 0084] players.state_version 已添加');
}

async function down() {
    await sequelize.query('ALTER TABLE players DROP COLUMN `state_version`');
    console.log('[Migration 0084] 已回滚 players.state_version');
}

module.exports = { up, down, migrationInfo };
