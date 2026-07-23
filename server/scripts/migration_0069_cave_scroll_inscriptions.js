/**
 * 迁移脚本 0069：创建洞天绘卷题词记录表
 *
 * 设计依据：xiuxian_game_guide.md 第26节·洞府社交
 *   `.洞天绘卷` 查看洞府画卷
 *
 * 系统定位：
 *   洞天绘卷是洞府的"全景画卷"，以结构化数据展示洞府全貌（设施/景观/展品/药园/人气），
 *   并通过"风貌评级"形成全服排行竞争。其他玩家查看绘卷后可"题词"留下诗意评价，
 *   被题词的洞府主人获得声望奖励（每日上限），形成轻量级社交互动。
 *   与万宝阁展品系统差异化：万宝阁是"物品展示+鉴赏获修为"（个人收益），
 *   洞天绘卷是"洞府全景+评级排行+题词互动"（社交竞争）。
 *
 * 表设计：
 *   cave_scroll_inscriptions：题词记录表
 *     · target_player_id：被题词的洞府主人玩家ID
 *     · inscriber_id：题词者玩家ID
 *     · content：题词内容（限20字，诗意评价）
 *     · created_at：题词时间
 *
 * 索引设计：
 *   - idx_csi_target_date：按洞府主人+时间倒序查询题词列表（绘卷展示用）
 *   - idx_csi_inscriber_date：按题词者+时间查询每日题词次数（每日上限校验）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

module.exports = {
    name: '0069_cave_scroll_inscriptions',
    description: '创建 cave_scroll_inscriptions 表用于洞天绘卷题词系统',

    /**
     * 执行迁移：创建洞天绘卷题词记录表
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

        // ===== 创建题词记录表 cave_scroll_inscriptions =====
        if (await tableExists('cave_scroll_inscriptions')) {
            console.log('[migration_0069] cave_scroll_inscriptions 表已存在，跳过创建');
        } else {
            await sequelize.query(`
                CREATE TABLE cave_scroll_inscriptions (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    target_player_id BIGINT NOT NULL COMMENT '被题词的洞府主人玩家ID',
                    inscriber_id BIGINT NOT NULL COMMENT '题词者玩家ID',
                    content VARCHAR(60) NOT NULL COMMENT '题词内容（限20字诗意评价）',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '题词时间',
                    PRIMARY KEY (id),
                    INDEX idx_csi_target_date (target_player_id, created_at),
                    INDEX idx_csi_inscriber_date (inscriber_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='洞天绘卷题词记录表';
            `);
            console.log('[migration_0069] cave_scroll_inscriptions 表创建成功');
        }
    },

    /**
     * 回滚迁移：删除洞天绘卷题词记录表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        await sequelize.query('DROP TABLE IF EXISTS cave_scroll_inscriptions;');
        console.log('[migration_0069] 洞天绘卷题词记录表已删除');
    }
};
