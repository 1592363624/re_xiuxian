/**
 * 数据库迁移主控脚本
 * 管理所有数据库迁移的版本控制和执行
 */
const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

const MIGRATION_DIR = __dirname;

/**
 * 迁移版本记录表名
 */
const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * 已执行的迁移记录
 */
const executedMigrations = new Set();

/**
 * 初始化迁移表
 */
async function initMigrationTable() {
    const query = `
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            migration_name VARCHAR(191) NOT NULL,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            checksum VARCHAR(64),
            description TEXT,
            UNIQUE KEY unique_migration_name (migration_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
    await sequelize.query(query);
    console.log(`[Migration] 表 ${MIGRATIONS_TABLE} 已就绪`);
}

/**
 * 获取所有迁移文件（按版本号排序）
 */
function getMigrationFiles() {
    const files = fs.readdirSync(MIGRATION_DIR)
        .filter(f => f.startsWith('migration_') && f.endsWith('.js'))
        .sort();
    return files;
}

/**
 * 从文件名解析版本号和描述
 */
function parseMigrationFilename(filename) {
    const match = filename.match(/^migration_(\d+)_+(.+)\.js$/);
    if (!match) return null;
    return {
        version: parseInt(match[1], 10),
        name: match[2],
        filename
    };
}

/**
 * 获取已执行的迁移列表
 */
async function getExecutedMigrations() {
    try {
        const [results] = await sequelize.query(
            `SELECT migration_name FROM ${MIGRATIONS_TABLE}`,
            { type: QueryTypes.SELECT }
        );
        return new Set(results.map(r => r.migration_name));
    } catch (error) {
        console.error('[Migration] 获取已执行迁移失败:', error.message);
        return new Set();
    }
}

/**
 * 计算文件 checksum
 */
function calculateChecksum(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return require('crypto').createHash('sha256').update(content).digest('hex');
}

/**
 * 执行单个迁移
 */
async function executeMigration(filename) {
    const migration = require(path.join(MIGRATION_DIR, filename));
    
    console.log(`[Migration] 执行迁移: ${filename}`);
    
    try {
        await migration.up(sequelize, QueryTypes);
        
        const checksum = calculateChecksum(path.join(MIGRATION_DIR, filename));
        await sequelize.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (migration_name, checksum, description) VALUES (?, ?, ?)`,
            {
                replacements: [filename, checksum, migration.description || ''],
                type: QueryTypes.INSERT
            }
        );
        
        console.log(`[Migration] ✓ 迁移成功: ${filename}`);
        return true;
    } catch (error) {
        console.error(`[Migration] ✗ 迁移失败: ${filename}`);
        console.error(`  错误: ${error.message}`);
        throw error;
    }
}

/**
 * 回滚单个迁移
 */
async function rollbackMigration(filename) {
    const migration = require(path.join(MIGRATION_DIR, filename));
    
    console.log(`[Migration] 回滚迁移: ${filename}`);
    
    try {
        if (typeof migration.down === 'function') {
            await migration.down(sequelize, QueryTypes);
        }
        
        await sequelize.query(
            `DELETE FROM ${MIGRATIONS_TABLE} WHERE migration_name = ?`,
            {
                replacements: [filename],
                type: QueryTypes.DELETE
            }
        );
        
        console.log(`[Migration] ✓ 回滚成功: ${filename}`);
        return true;
    } catch (error) {
        console.error(`[Migration] ✗ 回滚失败: ${filename}`);
        console.error(`  错误: ${error.message}`);
        throw error;
    }
}

/**
 * 运行所有待执行的迁移
 */
async function migrate(options = {}) {
    const { force = false, toVersion = null } = options;
    
    console.log('='.repeat(50));
    console.log('[Migration] 开始数据库迁移...');
    console.log('='.repeat(50));
    
    try {
        await sequelize.authenticate();
        console.log('[Migration] 数据库连接成功');
        
        await initMigrationTable();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();
        
        let pendingMigrations = [];
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            if (toVersion !== null && info.version > toVersion) {
                continue;
            }
            
            if (!executed.has(file) || force) {
                pendingMigrations.push({ file, info });
            }
        }
        
        if (pendingMigrations.length === 0) {
            console.log('[Migration] 所有迁移已执行完成，无需迁移');
            return { success: true, executed: 0 };
        }
        
        console.log(`[Migration] 待执行迁移数: ${pendingMigrations.length}`);
        
        for (const { file, info } of pendingMigrations) {
            await executeMigration(file);
        }
        
        console.log('='.repeat(50));
        console.log(`[Migration] ✓ 迁移完成！共执行 ${pendingMigrations.length} 个迁移`);
        console.log('='.repeat(50));
        
        return { success: true, executed: pendingMigrations.length };
    } catch (error) {
        console.error('[Migration] 迁移失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 回滚到指定版本
 */
async function rollback(targetVersion) {
    console.log('='.repeat(50));
    console.log(`[Migration] 回滚到版本 ${targetVersion}...`);
    console.log('='.repeat(50));
    
    try {
        await sequelize.authenticate();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();
        
        const toRollback = [];
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            if (info.version > targetVersion && executed.has(file)) {
                toRollback.push({ file, info });
            }
        }
        
        toRollback.sort((a, b) => b.info.version - a.info.version);
        
        for (const { file } of toRollback) {
            await rollbackMigration(file);
        }
        
        console.log('='.repeat(50));
        console.log(`[Migration] ✓ 回滚完成！共回滚 ${toRollback.length} 个迁移`);
        console.log('='.repeat(50));
        
        return { success: true, rolledBack: toRollback.length };
    } catch (error) {
        console.error('[Migration] 回滚失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 显示迁移状态
 */
async function status() {
    try {
        await sequelize.authenticate();
        await initMigrationTable();
        
        const executed = await getExecutedMigrations();
        const files = getMigrationFiles();
        
        console.log('='.repeat(50));
        console.log('[Migration] 迁移状态');
        console.log('='.repeat(50));
        
        let pendingCount = 0;
        for (const file of files) {
            const info = parseMigrationFilename(file);
            if (!info) continue;
            
            const isExecuted = executed.has(file);
            const status = isExecuted ? '✓' : '⏳';
            const version = String(info.version).padStart(4, '0');
            
            console.log(`  ${status} [v${version}] ${file}`);
            
            if (!isExecuted) pendingCount++;
        }
        
        console.log('='.repeat(50));
        console.log(`总计: ${files.length} 个迁移, 已执行: ${executed.size}, 待执行: ${pendingCount}`);
        console.log('='.repeat(50));
        
        return { total: files.length, executed: executed.size, pending: pendingCount };
    } catch (error) {
        console.error('[Migration] 获取状态失败:', error);
    }
}

/**
 * 创建新的迁移文件
 */
function createMigration(version, description) {
    const versionStr = String(version).padStart(4, '0');
    const filename = `migration_${versionStr}_${description}.js`;
    const filepath = path.join(MIGRATION_DIR, filename);
    
    const template = `/**
 * 数据库迁移脚本
 * 版本: ${version}
 * 描述: ${description}
 * 创建时间: ${new Date().toISOString()}
 */

module.exports = {
    /**
     * 迁移说明
     */
    description: '${description}',
    
    /**
     * 版本号
     */
    version: ${version},
    
    /**
     * 执行迁移
     */
    async up(queryInterface, Sequelize) {
        // 在这里编写添加字段、创建表等操作
        // 示例:
        // await queryInterface.addColumn('players', 'new_field', {
        //     type: Sequelize.INTEGER,
        //     defaultValue: 0
        // });
    },
    
    /**
     * 回滚迁移
     */
    async down(queryInterface, Sequelize) {
        // 在这里编写回滚操作，与 up 相反
        // 示例:
        // await queryInterface.removeColumn('players', 'new_field');
    }
};
`;
    
    fs.writeFileSync(filepath, template);
    console.log(`[Migration] 已创建迁移文件: ${filename}`);
    return filename;
}

module.exports = {
    migrate,
    rollback,
    status,
    createMigration,
    initMigrationTable,
    MIGRATIONS_TABLE
};
