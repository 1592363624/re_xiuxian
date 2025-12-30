/**
 * 数据库清理脚本
 * 
 * 删除不需要的数据库表，保留核心业务表
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sequelize = require('../config/database');

const KEEP_TABLES = [
    'players',
    'player_items',
    'maps',
    'realms',
    'system_notifications',
    'system_configs',
    'admin_logs',
    'chats'
];

async function cleanupTables() {
    let connection;
    try {
        console.log('正在连接数据库...');
        await sequelize.authenticate();
        console.log('数据库连接成功。\n');

        console.log('正在查询所有数据库表...');
        connection = await sequelize.connectionManager.getConnection();
        const [tables] = await connection.query("SHOW TABLES");
        
        console.log('当前数据库中的表:');
        const existingTables = tables.map(t => Object.values(t)[0]);
        existingTables.forEach(t => {
            const keep = KEEP_TABLES.includes(t) ? ' [保留]' : ' [待删除]';
            console.log(`  - ${t}${keep}`);
        });
        console.log();

        const tablesToDelete = existingTables.filter(t => !KEEP_TABLES.includes(t));
        
        if (tablesToDelete.length === 0) {
            console.log('没有需要删除的表。');
            process.exit(0);
        }

        console.log(`准备删除以下 ${tablesToDelete.length} 个表:`);
        tablesToDelete.forEach(t => console.log(`  - ${t}`));
        console.log();

        console.log('正在删除表...');
        for (const table of tablesToDelete) {
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
            console.log(`  已删除表: ${table}`);
        }

        console.log('\n数据库清理完成！');
        console.log(`保留了以下 ${KEEP_TABLES.length} 个核心表:`);
        KEEP_TABLES.forEach(t => console.log(`  - ${t}`));

        process.exit(0);
    } catch (error) {
        console.error('清理失败:', error);
        process.exit(1);
    } finally {
        if (connection) {
            sequelize.connectionManager.releaseConnection(connection);
        }
        await sequelize.close();
    }
}

cleanupTables();
