/**
 * 修复脚本：为 pawnshop_histories 表补齐 updated_at 列
 *
 * 背景：migration_0016 创建 pawnshop_histories 时遗漏 updated_at 列，
 * 但模型使用 timestamps:true + underscored:true，Sequelize 会查询该列，
 * 导致 "Unknown column 'updated_at' in 'field list'" 错误。
 *
 * 本脚本幂等：检查列是否存在后再添加。
 */
'use strict';

const sequelize = require('../config/database');

async function fixPawnshopHistoriesUpdatedAt() {
    console.log('[Fix] 开始检查 pawnshop_histories 表的 updated_at 列...');

    // 检查列是否已存在
    const [cols] = await sequelize.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pawnshop_histories' AND COLUMN_NAME = 'updated_at'
    `);

    if (cols.length > 0) {
        console.log('[Fix] updated_at 列已存在，无需修复');
        return;
    }

    // 添加缺失的 updated_at 列
    await sequelize.query(`
        ALTER TABLE pawnshop_histories
        ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        AFTER created_at
    `);
    console.log('[Fix] ✓ 已添加 updated_at 列到 pawnshop_histories 表');
}

fixPawnshopHistoriesUpdatedAt()
    .then(() => {
        console.log('[Fix] 修复完成');
        process.exit(0);
    })
    .catch(err => {
        console.error('[Fix] 修复失败:', err);
        process.exit(1);
    });
