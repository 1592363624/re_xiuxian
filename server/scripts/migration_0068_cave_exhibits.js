/**
 * 迁移脚本 0068：创建万宝阁展品系统表
 *
 * 设计依据：xiuxian_game_guide.md 第26节·洞府社交
 *   `.上架至万宝阁 <物品>`、`.从万宝阁取下 <物品>` 展示或取下展品
 *   `.洞天绘卷` 查看洞府画卷（绘卷系统单独实现，此处仅展品）
 *
 * 系统定位：
 *   万宝阁是洞府的"文化展示厅"，与洞天寻宝的"掠夺博弈"形成正负向社交平衡。
 *   洞府主人上架珍宝彰显实力 → 拜访者鉴赏获得修为灵感 → 主人积累声望。
 *   同时展品越多"财富外露"，被寻宝成功率上升，形成策略博弈。
 *
 * 表设计：
 *   1. cave_exhibits：展品表
 *      · player_id：洞府主人玩家ID
 *      · item_key：物品配置键名（上架时从背包扣除并存入此表，取下时归还）
 *      · item_name：物品名称（冗余，展示用，避免每次联查 item_data.json）
 *      · quality：品质（冗余，用于鉴赏奖励计算与展示排序）
 *      · exhibit_slot：展位编号（1-6，限制展品数量上限）
 *      · heat_count：热度值（被鉴赏次数累计，用于热度榜与声望结算）
 *      · created_at：上架时间
 *
 *   2. cave_exhibit_appreciations：鉴赏记录表
 *      · exhibit_id：展品ID
 *      · appreciator_id：鉴赏者玩家ID
 *      · is_enlightened：是否触发顿悟（0=普通鉴赏，1=顿悟，奖励翻倍+临时buff）
 *      · exp_gained：获得的修为值
 *      · created_at：鉴赏时间
 *
 * 索引设计：
 *   - idx_ce_player：按洞府主人查询展品列表（万宝阁主界面）
 *   - idx_ce_heat：按热度排序查询热度榜（声望结算）
 *   - idx_cea_exhibit_date：按展品+日期查询每日鉴赏次数（防刷校验）
 *   - idx_cea_appreciator_date：按鉴赏者+日期查询每日鉴赏次数（每日上限校验）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-22
 */
'use strict';

module.exports = {
    name: '0068_cave_exhibits',
    description: '创建 cave_exhibits 和 cave_exhibit_appreciations 表用于万宝阁展品系统',

    /**
     * 执行迁移：创建万宝阁展品系统表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    up: async (sequelize, QueryTypes) => {
        /**
         * 检查表是否已存在（幂等性保障，支持重复执行不报错）
         * @param {string} tableName - 表名
         * @returns {Promise<boolean>} 是否存在
         */
        async function tableExists(tableName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = :tbl`,
                { replacements: { tbl: tableName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        // ===== 创建展品表 cave_exhibits =====
        if (await tableExists('cave_exhibits')) {
            console.log('[migration_0068] cave_exhibits 表已存在，跳过创建');
        } else {
            await sequelize.query(`
                CREATE TABLE cave_exhibits (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '洞府主人玩家ID',
                    item_key VARCHAR(100) NOT NULL COMMENT '物品配置键名（上架时从背包扣除）',
                    item_name VARCHAR(100) NOT NULL COMMENT '物品名称（冗余，展示用）',
                    quality VARCHAR(20) NOT NULL DEFAULT 'common' COMMENT '品质：common/uncommon/rare/epic/legendary/mythic',
                    exhibit_slot INT NOT NULL COMMENT '展位编号（1-max_exhibits）',
                    heat_count INT NOT NULL DEFAULT 0 COMMENT '热度值（被鉴赏次数累计）',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上架时间',
                    PRIMARY KEY (id),
                    INDEX idx_ce_player (player_id, exhibit_slot),
                    INDEX idx_ce_heat (heat_count DESC),
                    UNIQUE KEY uk_player_slot (player_id, exhibit_slot)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='万宝阁展品表';
            `);
            console.log('[migration_0068] cave_exhibits 表创建成功');
        }

        // ===== 创建鉴赏记录表 cave_exhibit_appreciations =====
        if (await tableExists('cave_exhibit_appreciations')) {
            console.log('[migration_0068] cave_exhibit_appreciations 表已存在，跳过创建');
        } else {
            await sequelize.query(`
                CREATE TABLE cave_exhibit_appreciations (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    exhibit_id BIGINT NOT NULL COMMENT '展品ID',
                    appreciator_id BIGINT NOT NULL COMMENT '鉴赏者玩家ID',
                    is_enlightened TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否触发顿悟（0=普通，1=顿悟）',
                    exp_gained INT NOT NULL DEFAULT 0 COMMENT '获得的修为值',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '鉴赏时间',
                    PRIMARY KEY (id),
                    INDEX idx_cea_exhibit_date (exhibit_id, created_at),
                    INDEX idx_cea_appreciator_date (appreciator_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='万宝阁展品鉴赏记录表';
            `);
            console.log('[migration_0068] cave_exhibit_appreciations 表创建成功');
        }
    },

    /**
     * 回滚迁移：删除万宝阁展品系统表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        await sequelize.query('DROP TABLE IF EXISTS cave_exhibit_appreciations;');
        await sequelize.query('DROP TABLE IF EXISTS cave_exhibits;');
        console.log('[migration_0068] 万宝阁展品系统表已删除');
    }
};
