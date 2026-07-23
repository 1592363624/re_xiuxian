/**
 * 迁移脚本 0070：创建拍卖系统数据表（auctions + auction_bids）
 *
 * 设计依据：xiuxian_game_guide.md 第21节·经济与博彩补充 + 第27节·市场、股市与资产路线
 *   `.拍卖 <物品> <数量> 起拍价 <价格> 时长 <小时>`
 *   `.竞拍 <编号> <价格>`
 *   `.拍卖行 [页数]`
 *   `.撤销拍卖 <编号>`
 *
 * 系统定位：
 *   拍卖系统是多人经济博弈玩法，与万宝楼"以物换物"差异化：
 *   万宝楼是"标价直购"（卖家定价、买家即时购买），拍卖是"竞价博弈"（多人竞价、倒计时、防秒杀延长）。
 *   形成完整经济闭环：直购（万宝楼）+ 典当（当铺）+ 竞价（拍卖）+ 股票（股市）。
 *
 * 表设计：
 *   auctions：拍卖主表
 *     · seller_id：拍卖者玩家ID
 *     · item_key/item_name/item_quality：拍卖物品信息（拍下时物品已从卖家背包扣除）
 *     · quantity：拍卖数量
 *     · starting_price：起拍价（灵石，BIGINT）
 *     · current_price：当前最高出价（BIGINT）
 *     · current_bidder_id：当前最高出价者ID（可空，无人竞价时为 NULL）
 *     · status：拍卖状态（open/closed/cancelled）
 *     · start_at/end_at：拍卖开始/结束时间
 *     · winner_id：最终得标者ID（结算后写入，可空表示流拍）
 *     · final_price：最终成交价（结算后写入）
 *     · fee_rate：手续费率（创建时快照配置，避免后续配置变更影响在拍拍卖）
 *     · extension_count：防秒杀延长次数（最后1分钟竞价自动延长1分钟，最多3次）
 *     · cancel_reason：撤销原因（仅 cancelled 状态使用）
 *
 *   auction_bids：竞价历史表
 *     · auction_id：拍卖ID
 *     · bidder_id：竞价者ID
 *     · bid_price：出价（BIGINT）
 *
 * 索引设计：
 *   - idx_auc_status_end：按状态+结束时间查询到期拍卖（调度器结算用）
 *   - idx_auc_seller_status：按卖家+状态查询我的拍卖
 *   - idx_bid_auc_date：按拍卖+时间查询竞价历史
 *   - idx_bid_bidder_date：按竞价者+时间查询我的竞价
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

module.exports = {
    name: '0070_auctions',
    description: '创建 auctions + auction_bids 表用于拍卖系统',

    /**
     * 执行迁移：创建拍卖系统数据表
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

        // ===== 创建拍卖主表 auctions =====
        if (await tableExists('auctions')) {
            console.log('[migration_0070] auctions 表已存在，跳过创建');
        } else {
            await sequelize.query(`
                CREATE TABLE auctions (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    seller_id BIGINT NOT NULL COMMENT '拍卖者玩家ID',
                    item_key VARCHAR(80) NOT NULL COMMENT '拍卖物品配置键名',
                    item_name VARCHAR(120) NOT NULL COMMENT '拍卖物品名称（创建时快照，避免后续配置改名导致显示错乱）',
                    item_quality VARCHAR(20) NOT NULL DEFAULT 'common' COMMENT '物品品质（common/uncommon/rare/epic/legendary/mythic）',
                    quantity INT NOT NULL DEFAULT 1 COMMENT '拍卖数量',
                    starting_price BIGINT NOT NULL COMMENT '起拍价（灵石）',
                    current_price BIGINT NOT NULL COMMENT '当前最高出价（无人竞价时等于起拍价）',
                    current_bidder_id BIGINT NULL COMMENT '当前最高出价者ID（无人竞价时为NULL）',
                    status VARCHAR(20) NOT NULL DEFAULT 'open' COMMENT '拍卖状态：open=进行中/closed=已结算/cancelled=已撤销',
                    start_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '拍卖开始时间',
                    end_at DATETIME NOT NULL COMMENT '拍卖结束时间（含防秒杀延长）',
                    winner_id BIGINT NULL COMMENT '最终得标者ID（结算后写入，NULL表示流拍）',
                    final_price BIGINT NULL COMMENT '最终成交价（结算后写入）',
                    fee_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0500 COMMENT '手续费率（创建时快照配置）',
                    extension_count INT NOT NULL DEFAULT 0 COMMENT '防秒杀延长次数（上限3次）',
                    cancel_reason VARCHAR(120) NULL COMMENT '撤销原因（仅cancelled状态使用）',
                    settled_at DATETIME NULL COMMENT '结算时间（调度器自动结算或手动结算时写入）',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (id),
                    INDEX idx_auc_status_end (status, end_at),
                    INDEX idx_auc_seller_status (seller_id, status, created_at),
                    INDEX idx_auc_bidder_status (current_bidder_id, status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='拍卖主表';
            `);
            console.log('[migration_0070] auctions 表创建成功');
        }

        // ===== 创建竞价历史表 auction_bids =====
        if (await tableExists('auction_bids')) {
            console.log('[migration_0070] auction_bids 表已存在，跳过创建');
        } else {
            await sequelize.query(`
                CREATE TABLE auction_bids (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    auction_id BIGINT NOT NULL COMMENT '拍卖ID',
                    bidder_id BIGINT NOT NULL COMMENT '竞价者玩家ID',
                    bid_price BIGINT NOT NULL COMMENT '出价（灵石）',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '竞价时间',
                    PRIMARY KEY (id),
                    INDEX idx_bid_auc_date (auction_id, created_at),
                    INDEX idx_bid_bidder_date (bidder_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='拍卖竞价历史表';
            `);
            console.log('[migration_0070] auction_bids 表创建成功');
        }
    },

    /**
     * 回滚迁移：删除拍卖系统数据表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        await sequelize.query('DROP TABLE IF EXISTS auction_bids;');
        await sequelize.query('DROP TABLE IF EXISTS auctions;');
        console.log('[migration_0070] 拍卖系统数据表已删除');
    }
};
