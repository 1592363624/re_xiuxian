/**
 * 数据库迁移脚本
 * 版本: 0001
 * 描述: 添加玩家境界相关扩展字段
 * 创建时间: 2024-01-01
 */

module.exports = {
    description: '添加玩家境界相关扩展字段',
    version: 1,
    
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0001] 开始添加扩展字段...');
        
        try {
            const checkColumnSQL = `
                SELECT COUNT(*) as count 
                FROM information_schema.columns 
                WHERE table_schema = DATABASE() 
                AND table_name = 'players' 
                AND column_name = ?
            `;
            
            const [result] = await sequelize.query(checkColumnSQL, {
                replacements: ['realm_max_lifespan'],
                type: QueryTypes.SELECT
            });
            
            if (result.count === 0) {
                await sequelize.query(`
                    ALTER TABLE players 
                    ADD COLUMN realm_max_lifespan INT DEFAULT NULL 
                    COMMENT '当前境界对应的最大寿元（只读，来源于境界配置）'
                `);
                console.log('  ✓ 添加字段: realm_max_lifespan');
            } else {
                console.log('  ⊘ 字段已存在: realm_max_lifespan');
            }
            
            const [result2] = await sequelize.query(checkColumnSQL, {
                replacements: ['database_version'],
                type: QueryTypes.SELECT
            });
            
            if (result2.count === 0) {
                await sequelize.query(`
                    ALTER TABLE players 
                    ADD COLUMN database_version INT DEFAULT 1 
                    COMMENT '玩家数据版本号，用于兼容性检查'
                `);
                console.log('  ✓ 添加字段: database_version');
            } else {
                console.log('  ⊘ 字段已存在: database_version');
            }
            
            const [result3] = await sequelize.query(checkColumnSQL, {
                replacements: ['realm_rank'],
                type: QueryTypes.SELECT
            });
            
            if (result3.count === 0) {
                await sequelize.query(`
                    ALTER TABLE players 
                    ADD COLUMN realm_rank INT DEFAULT NULL 
                    COMMENT '当前境界排名（用于快速排序和计算）'
                `);
                console.log('  ✓ 添加字段: realm_rank');
            } else {
                console.log('  ⊘ 字段已存在: realm_rank');
            }
            
            console.log('[Migration v0001] ✓ 迁移完成');
        } catch (error) {
            console.error('[Migration v0001] ✗ 迁移失败:', error.message);
            throw error;
        }
    },
    
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0001] 开始回滚...');
        
        try {
            await sequelize.query(`
                ALTER TABLE players 
                DROP COLUMN IF EXISTS realm_max_lifespan
            `);
            await sequelize.query(`
                ALTER TABLE players 
                DROP COLUMN IF EXISTS database_version
            `);
            await sequelize.query(`
                ALTER TABLE players 
                DROP COLUMN IF EXISTS realm_rank
            `);
            console.log('[Migration v0001] ✓ 回滚完成');
        } catch (error) {
            console.error('[Migration v0001] ✗ 回滚失败:', error.message);
            throw error;
        }
    }
};
