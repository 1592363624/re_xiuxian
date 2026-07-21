/**
 * 数据库索引超限排查脚本
 *
 * 问题：服务器启动报错 "Too many keys specified; max 64 keys allowed"
 * MySQL 5.6 限制每张表最多 64 个索引，需找出超限的表
 *
 * 排查步骤：
 *   1. 查询所有表的索引数量
 *   2. 找出索引数 >= 64 的表
 *   3. 列出这些表的索引详情，供人工分析是否可以合并/删除
 *
 * 运行方式：node server/scripts/check_table_indexes.js
 */
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

async function main() {
    console.log('========== 数据库索引超限排查 ==========\n');

    try {
        await sequelize.authenticate();
        console.log('[1] 数据库连接成功\n');

        // 查询所有表的索引数量
        console.log('[2] 查询所有表的索引数量...');
        const tableIndexes = await sequelize.query(`
            SELECT 
                TABLE_NAME AS table_name,
                COUNT(DISTINCT INDEX_NAME) AS index_count
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = 'xiuxian'
            GROUP BY TABLE_NAME
            ORDER BY index_count DESC
        `, { type: QueryTypes.SELECT });

        console.log(`  共 ${tableIndexes.length} 张表\n`);

        // 找出索引数 >= 50 的表（接近或超过限制）
        const heavyTables = tableIndexes.filter(t => t.index_count >= 50);
        if (heavyTables.length === 0) {
            console.log('  ✓ 没有索引数 >= 50 的表\n');
        } else {
            console.log(`  ⚠ 发现 ${heavyTables.length} 张索引数 >= 50 的表：\n`);
            for (const t of heavyTables) {
                console.log(`    - ${t.table_name}: ${t.index_count} 个索引`);
            }
            console.log('');
        }

        // 列出 top 5 表的索引详情
        console.log('[3] 索引数 Top 5 表的详情：');
        const top5 = tableIndexes.slice(0, 5);
        for (const t of top5) {
            const tableName = t.table_name;
            console.log(`\n  ─── ${tableName}（${t.index_count} 个索引）───`);
            const indexDetails = await sequelize.query(`
                SELECT 
                    INDEX_NAME AS index_name,
                    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS columns,
                    NON_UNIQUE AS non_unique,
                    INDEX_TYPE AS index_type
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = 'xiuxian' AND TABLE_NAME = ?
                GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE
                ORDER BY INDEX_NAME
            `, {
                replacements: [tableName],
                type: QueryTypes.SELECT
            });

            for (const idx of indexDetails) {
                const unique = idx.non_unique === 0 ? 'UNIQUE' : 'INDEX';
                console.log(`    ${unique} ${idx.index_name} (${idx.columns}) [${idx.index_type}]`);
            }
        }

        console.log('\n========== 排查结论 ==========');
        const overLimit = tableIndexes.filter(t => t.index_count >= 64);
        if (overLimit.length > 0) {
            console.log(`✗ 发现 ${overLimit.length} 张表索引数 >= 64，违反 MySQL 5.6 限制：`);
            for (const t of overLimit) {
                console.log(`  - ${t.table_name}: ${t.index_count} 个索引`);
            }
            console.log('\n建议：');
            console.log('  1. 检查 Sequelize 模型定义，删除冗余索引');
            console.log('  2. 合并功能相近的索引');
            console.log('  3. 检查 associations 自动生成的索引是否重复');
        } else {
            console.log('✓ 所有表索引数 < 64，未发现超限');
            console.log('  但仍需检查 sync({ alter: true }) 是否在添加新字段时失败');
        }

    } catch (err) {
        console.error('排查失败:', err.message);
        console.error(err.stack);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

main();
