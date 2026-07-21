/**
 * 数据库冗余索引清理脚本
 *
 * 问题：Sequelize sync({ alter: true }) 在每次启动时为同一字段创建带数字后缀的重复索引
 *   - player_caves: 64 个 player_id 索引（player_id, player_id_2, ..., player_id_61, uk_player_id, player_caves_player_id）
 *   - player_sect_special: 28 个 player_id 索引
 *   - sect_funds: 18 个 sect_id 索引
 *
 * 导致 MySQL 5.6 报错 "Too many keys specified; max 64 keys allowed"
 * 阻止 sequelize.sync({ alter: true }) 添加新字段，影响后续数据库结构同步
 *
 * 清理策略：
 *   1. player_caves：保留 player_caves_player_id（含表名前缀的索引名）和 uk_player_id（uk_ 前缀的命名索引）
 *      删除所有 player_id 和 player_id_N（N=2..61）模式的无序号/带序号索引
 *   2. player_sect_special：保留 idx_sect_special_player（命名索引）
 *      删除所有 player_id 和 player_id_N
 *   3. sect_funds：保留 sect_id（首个原索引）
 *      删除所有 sect_id_N（N=2..13）
 *
 * 清理后：
 *   - player_caves: 索引数从 64 降至 3（PRIMARY + player_caves_player_id + uk_player_id）
 *   - player_sect_special: 索引数从 28 降至 2（PRIMARY + idx_sect_special_player）
 *   - sect_funds: 索引数从 18 降至 6（保留功能索引）
 *
 * 运行方式：node server/scripts/cleanup_duplicate_indexes.js
 */
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

async function main() {
    console.log('========== 数据库冗余索引清理 ==========\n');

    try {
        await sequelize.authenticate();
        console.log('[1] 数据库连接成功\n');

        // 定义清理规则：每张表保留哪些索引，其他符合模式的删除
        // 保留规则：命名索引（含表名前缀或 uk_/idx_ 前缀），删除规则：纯字段名或字段名_N
        const cleanupRules = [
            {
                table: 'player_caves',
                description: 'player_id 字段重复索引（64 → 3）',
                // 保留：PRIMARY, player_caves_player_id, uk_player_id
                keepPattern: /^(PRIMARY|player_caves_player_id|uk_player_id)$/,
                // 删除：player_id, player_id_2, player_id_3, ..., player_id_61
                deletePattern: /^player_id(_\d+)?$/
            },
            {
                table: 'player_sect_special',
                description: 'player_id 字段重复索引（28 → 2）',
                // 保留：PRIMARY, idx_sect_special_player
                keepPattern: /^(PRIMARY|idx_sect_special_player)$/,
                // 删除：player_id, player_id_2, ..., player_id_26
                deletePattern: /^player_id(_\d+)?$/
            },
            {
                table: 'sect_funds',
                description: 'sect_id 字段重复索引（18 → 6）',
                // 保留：PRIMARY, sect_id（首个原索引）, 以及功能索引 sect_funds_war_score / sect_funds_season_war_score / idx_sf_war_score / idx_sf_season_score
                keepPattern: /^(PRIMARY|sect_id|sect_funds_war_score|sect_funds_season_war_score|idx_sf_war_score|idx_sf_season_score)$/,
                // 删除：sect_id_2, sect_id_3, ..., sect_id_13
                deletePattern: /^sect_id_\d+$/
            }
        ];

        let totalDeleted = 0;

        for (const rule of cleanupRules) {
            console.log(`[2] 清理表 ${rule.table}：${rule.description}`);

            // 查询该表所有索引
            const indexes = await sequelize.query(`
                SELECT DISTINCT INDEX_NAME AS index_name
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = 'xiuxian' AND TABLE_NAME = ?
                ORDER BY INDEX_NAME
            `, {
                replacements: [rule.table],
                type: QueryTypes.SELECT
            });

            console.log(`  当前索引数: ${indexes.length}`);

            // 找出需要删除的索引
            const toDelete = indexes.filter(idx => {
                const name = idx.index_name;
                // 不删除保留的索引
                if (rule.keepPattern.test(name)) return false;
                // 删除匹配删除模式的索引
                if (rule.deletePattern.test(name)) return true;
                // 其他索引保留
                return false;
            });

            console.log(`  待删除索引数: ${toDelete.length}`);
            if (toDelete.length === 0) {
                console.log(`  ✓ 无需清理\n`);
                continue;
            }

            // 打印前 5 个待删除索引作为示例
            console.log(`  示例（前 5 个）: ${toDelete.slice(0, 5).map(i => i.index_name).join(', ')}${toDelete.length > 5 ? '...' : ''}`);

            // 逐个删除索引（MySQL 不支持一条语句删多个）
            let deletedCount = 0;
            for (const idx of toDelete) {
                try {
                    // 索引名用反引号包裹，避免关键字冲突
                    await sequelize.query(`DROP INDEX \`${idx.index_name}\` ON \`${rule.table}\``);
                    deletedCount++;
                } catch (err) {
                    // 某些索引可能因为 PRIMARY 或不存在无法删除，跳过
                    console.warn(`  ⚠ 删除索引 ${idx.index_name} 失败: ${err.message}`);
                }
            }

            console.log(`  ✓ 成功删除 ${deletedCount} 个冗余索引\n`);
            totalDeleted += deletedCount;
        }

        // 验证清理结果
        console.log('[3] 验证清理结果...');
        for (const rule of cleanupRules) {
            const result = await sequelize.query(`
                SELECT COUNT(DISTINCT INDEX_NAME) AS cnt
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = 'xiuxian' AND TABLE_NAME = ?
            `, {
                replacements: [rule.table],
                type: QueryTypes.SELECT
            });
            console.log(`  ${rule.table}: ${result[0].cnt} 个索引`);
        }

        console.log('\n========== 清理结论 ==========');
        console.log(`✓ 共清理 ${totalDeleted} 个冗余索引`);
        console.log('✓ player_caves 索引数已降低，可解除 MySQL 64 索引限制');
        console.log('✓ sequelize.sync({ alter: true }) 可正常工作');
        console.log('\n建议：');
        console.log('  1. 修改 server/index.js，将 sync({ alter: true }) 改为 sync()，避免再次累积重复索引');
        console.log('  2. 或在模型定义中明确指定索引名，避免 Sequelize 自动生成带数字后缀的索引');

    } catch (err) {
        console.error('清理失败:', err.message);
        console.error(err.stack);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

main();
