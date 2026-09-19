/**
 * 数据库迁移脚本
 * 版本: 0017
 * 描述: 创建股市系统相关表
 * 创建时间: 2026-07-05
 *
 * 创建表（共 7 张）：
 *   1. stocks - 股票定义表
 *      存储股票基本信息：代码、名称、当前价、涨跌幅、波动率、熔断状态等
 *   2. stock_holdings - 玩家持仓表
 *      存储玩家持有的股票数量、可用数量（T+1 冻结）、平均成本等
 *   3. stock_transactions - 交易流水表
 *      存储玩家买卖记录：成交价、金额、手续费、印花税、融资标记等
 *   4. stock_market_history - 股价K线历史表
 *      存储各周期（1h/1d/1w）的开高低收成交量，用于绘制K线图
 *   5. stock_events - 股价事件表
 *      存储影响股价的事件：副本通关、宗门战胜等，含影响百分比与持续时间
 *   6. stock_margin_accounts - 融资账户表
 *      存储玩家融资账户的总资产、负债、保证金率、爆仓状态
 *   7. stock_dividends - 分红记录表
 *      存储玩家获得的股票分红记录
 *
 * 设计要点：
 *   - stocks 表 code 唯一索引，保证股票代码唯一
 *   - stock_holdings 表 player_id + stock_id 唯一索引，保证一人一股一条
 *   - stock_transactions 表含 player_id + created_at 索引，便于查询交易历史
 *   - stock_market_history 表含 stock_id + period + period_start 索引，便于按周期查询K线
 *   - stock_events 表含 is_active + expire_at 索引，便于查询生效中的事件
 *   - stock_margin_accounts 表 player_id 唯一索引，保证一人一融资账户
 *
 * 幂等性：使用 CREATE TABLE IF NOT EXISTS
 *
 * MySQL 5.6 兼容性：
 *   - 时间戳字段使用 created_at/updated_at（snake_case），配合模型 underscored: true
 *   - BOOLEAN 使用 TINYINT(1)
 *   - DECIMAL(5,4) 用于百分比字段（0.0000 ~ 0.9999）
 *   - BIGINT 用于股价、金额、股本，避免溢出
 */

module.exports = {
    description: '创建股市系统相关表（股票定义/持仓/交易/K线/事件/融资/分红共7张表）',
    version: 17,

    /**
     * 执行迁移：创建股市系统相关表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0017] 开始创建股市系统表...');

        // 股票定义表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stocks (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '股票ID',
                code VARCHAR(20) NOT NULL COMMENT '股票代码（如ZM01）',
                name VARCHAR(50) NOT NULL COMMENT '股票名称',
                category VARCHAR(20) NOT NULL DEFAULT 'sect' COMMENT '类型：sect宗门/mine灵矿/dungeon副本/event事件',
                current_price BIGINT NOT NULL DEFAULT 100 COMMENT '当前价',
                open_price BIGINT NOT NULL DEFAULT 100 COMMENT '今日开盘价',
                yesterday_close_price BIGINT NOT NULL DEFAULT 100 COMMENT '昨日收盘价',
                daily_change_pct DECIMAL(5,4) NOT NULL DEFAULT 0 COMMENT '今日涨跌幅（0.0000-0.1500）',
                daily_volume BIGINT NOT NULL DEFAULT 0 COMMENT '今日成交量',
                total_shares BIGINT NOT NULL DEFAULT 1000000 COMMENT '总股本',
                float_shares BIGINT NOT NULL DEFAULT 1000000 COMMENT '流通股本',
                base_volatility DECIMAL(5,4) NOT NULL DEFAULT 0.0300 COMMENT '基础波动率',
                is_trading_halted TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否熔断暂停交易',
                halt_until DATETIME NULL COMMENT '暂停交易截止时间',
                description VARCHAR(200) NULL COMMENT '股票描述',
                is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
                last_price_update DATETIME NULL COMMENT '最后价格更新时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_code (code),
                INDEX idx_category (category, is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='股票定义表'
        `);
        console.log('  ✓ 创建表: stocks');

        // 玩家持仓表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_holdings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '持仓ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                stock_id BIGINT NOT NULL COMMENT '股票ID',
                quantity BIGINT NOT NULL DEFAULT 0 COMMENT '持有数量',
                available_quantity BIGINT NOT NULL DEFAULT 0 COMMENT '可用数量（扣除T+1冻结）',
                average_cost BIGINT NOT NULL DEFAULT 0 COMMENT '平均成本',
                total_cost BIGINT NOT NULL DEFAULT 0 COMMENT '总成本',
                market_value BIGINT NOT NULL DEFAULT 0 COMMENT '最新市值（缓存）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_player_stock (player_id, stock_id),
                INDEX idx_player (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家股票持仓表'
        `);
        console.log('  ✓ 创建表: stock_holdings');

        // 交易流水表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_transactions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '交易ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                stock_id BIGINT NOT NULL COMMENT '股票ID',
                trade_type VARCHAR(10) NOT NULL COMMENT '交易类型：buy/sell',
                quantity BIGINT NOT NULL COMMENT '交易数量',
                price BIGINT NOT NULL COMMENT '成交价',
                amount BIGINT NOT NULL COMMENT '成交金额',
                fee BIGINT NOT NULL DEFAULT 0 COMMENT '手续费',
                tax BIGINT NOT NULL DEFAULT 0 COMMENT '印花税',
                is_margin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否融资交易',
                status VARCHAR(20) NOT NULL DEFAULT 'completed' COMMENT '状态：pending/completed/cancelled',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_player (player_id, created_at),
                INDEX idx_stock (stock_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='股票交易流水表'
        `);
        console.log('  ✓ 创建表: stock_transactions');

        // 股价历史表（K线）
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_market_history (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                stock_id BIGINT NOT NULL COMMENT '股票ID',
                period VARCHAR(10) NOT NULL DEFAULT '1h' COMMENT '周期：1h/1d/1w',
                open_price BIGINT NOT NULL COMMENT '开盘价',
                close_price BIGINT NOT NULL COMMENT '收盘价',
                high_price BIGINT NOT NULL COMMENT '最高价',
                low_price BIGINT NOT NULL COMMENT '最低价',
                volume BIGINT NOT NULL DEFAULT 0 COMMENT '成交量',
                period_start DATETIME NOT NULL COMMENT '周期开始时间',
                period_end DATETIME NOT NULL COMMENT '周期结束时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_stock_period (stock_id, period, period_start),
                INDEX idx_period_start (period_start)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='股价K线历史表'
        `);
        console.log('  ✓ 创建表: stock_market_history');

        // 股价事件表（用于价格波动事件记录）
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_events (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '事件ID',
                stock_id BIGINT NULL COMMENT '关联股票ID（NULL表示全市场事件）',
                event_type VARCHAR(50) NOT NULL COMMENT '事件类型：sect_dungeon_success/war_victory等',
                impact_pct DECIMAL(5,4) NOT NULL COMMENT '影响百分比（正数上涨，负数下跌）',
                duration_hours INT NOT NULL DEFAULT 24 COMMENT '影响持续时间',
                triggered_at DATETIME NOT NULL COMMENT '触发时间',
                expire_at DATETIME NOT NULL COMMENT '影响结束时间',
                description VARCHAR(200) NULL COMMENT '事件描述',
                is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否生效中',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_stock (stock_id, is_active, expire_at),
                INDEX idx_active (is_active, expire_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='股价事件表'
        `);
        console.log('  ✓ 创建表: stock_events');

        // 融资账户表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_margin_accounts (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '账户ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                total_assets BIGINT NOT NULL DEFAULT 0 COMMENT '总资产（持仓市值+现金）',
                debt BIGINT NOT NULL DEFAULT 0 COMMENT '融资负债',
                margin_ratio DECIMAL(5,4) NOT NULL DEFAULT 0 COMMENT '维持保证金率',
                is_liquidated TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已爆仓',
                last_liquidation_check DATETIME NULL COMMENT '最后强平检查时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_player (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='融资账户表'
        `);
        console.log('  ✓ 创建表: stock_margin_accounts');

        // 分红记录表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS stock_dividends (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                stock_id BIGINT NOT NULL COMMENT '股票ID',
                quantity BIGINT NOT NULL COMMENT '持股数量',
                dividend_per_share BIGINT NOT NULL COMMENT '每股分红',
                total_dividend BIGINT NOT NULL COMMENT '总分红金额',
                dividend_type VARCHAR(20) NOT NULL DEFAULT 'monthly' COMMENT '分红类型：monthly/quarterly/event',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_player (player_id, created_at),
                INDEX idx_stock (stock_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='股票分红记录表'
        `);
        console.log('  ✓ 创建表: stock_dividends');

        console.log('[Migration v0017] 股市系统表创建完成（共 7 张表）');
    },

    /**
     * 回滚迁移：删除股市相关表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0017] 开始回滚：删除股市系统表...');
        // 按依赖关系倒序删除
        await sequelize.query('DROP TABLE IF EXISTS stock_dividends');
        console.log('  ✓ 删除表: stock_dividends');
        await sequelize.query('DROP TABLE IF EXISTS stock_margin_accounts');
        console.log('  ✓ 删除表: stock_margin_accounts');
        await sequelize.query('DROP TABLE IF EXISTS stock_events');
        console.log('  ✓ 删除表: stock_events');
        await sequelize.query('DROP TABLE IF EXISTS stock_market_history');
        console.log('  ✓ 删除表: stock_market_history');
        await sequelize.query('DROP TABLE IF EXISTS stock_transactions');
        console.log('  ✓ 删除表: stock_transactions');
        await sequelize.query('DROP TABLE IF EXISTS stock_holdings');
        console.log('  ✓ 删除表: stock_holdings');
        await sequelize.query('DROP TABLE IF EXISTS stocks');
        console.log('  ✓ 删除表: stocks');
        console.log('[Migration v0017] 回滚完成');
    }
};
