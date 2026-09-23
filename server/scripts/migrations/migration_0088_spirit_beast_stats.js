/**
 * 迁移脚本 0088：spirit_beasts 增加 stat_block 列（灵兽属性块的落脚点）
 *
 * 用途：把"资料片给灵兽加一档新属性"从改表变成改数据。
 * spirit_beasts 上原本只有 hp_max/atk/def/speed 四个属性列，内容里声明的其它 `base_<属性>`
 * （注册表认识的，如 crit_damage / dodge_rate）算出来之后没有地方存，
 * SpiritBeastService.computeStats 只能警告一声丢掉 —— 玩家永远拿不到。
 * 现在这类属性进 stats 这一列，消费端统一由 SpiritBeastService.statBlockOf 合并（列 + blob），
 * 所以加一档新属性只要：注册表登记 + 内容写 base_<属性>，不碰 schema。
 *
 * 兼容性：纯新增可空列，旧行 stat_block 为 NULL，读出来按空属性块处理；
 * 现有四个属性仍走各自的列（列优先，见 computeStats），所以**已上线灵兽的数值一格不变**。
 * 与 migration_0084（players.state_version）同形状：SHOW COLUMNS 预检，幂等，可重复执行。
 */
const sequelize = require('../../config/database');

const migrationInfo = {
    description: 'spirit_beasts 增加 stat_block JSON 列，存放没有专属列的灵兽属性',
    version: '1.0.0'
};

const TABLE = 'spirit_beasts';
const COLUMN_SQL = '`stat_block` JSON NULL COMMENT \'无专属列的属性块（注册表认识但没有列的属性）\'';

async function up() {
    const [tables] = await sequelize.query(`SHOW TABLES LIKE '${TABLE}'`);
    if (tables.length === 0) {
        console.log(`[Migration 0088] 表 ${TABLE} 不存在（尚未建库），跳过`);
        return;
    }
    const [columns] = await sequelize.query(`SHOW COLUMNS FROM ${TABLE} LIKE 'stat_block'`);
    if (columns.length > 0) {
        console.log('[Migration 0088] spirit_beasts.stat_block 已存在，跳过');
        return;
    }
    await sequelize.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN_SQL}`);
    console.log('[Migration 0088] spirit_beasts.stat_block 已添加');
}

async function down() {
    await sequelize.query(`ALTER TABLE ${TABLE} DROP COLUMN \`stat_block\``);
    console.log('[Migration 0088] 已回滚 spirit_beasts.stat_block');
}

module.exports = { up, down, migrationInfo };
