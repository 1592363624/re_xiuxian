/**
 * 数据库迁移脚本 0021：洞府社交系统
 *
 * 功能：
 *   1. 创建 cave_messages 表（洞府留言）
 *   2. 创建 cave_visitors 表（访客记录）
 *   3. 给 player_caves 表新增 landscape_id 字段（已布置景观）
 *   4. 给 player_caves 表新增 merchant_refresh_at 字段（商人货品刷新时间）
 *
 * 设计说明：
 *   - 留言表：访客在他人洞府留言，洞府主人可查看
 *   - 访客表：记录谁拜访了洞府，用于"查看访客"功能
 *   - 景观：玩家可布置景观装饰洞府，部分景观有属性加成
 *   - 商人：洞府商人货品从配置读取，定期刷新，购买记录在 cave_merchant_purchases 表
 */
const sequelize = require('../config/database');
const DataTypes = require('sequelize').DataTypes;

async function up() {
    console.log('[Migration 0021] 开始洞府社交系统迁移...');

    const tables = await sequelize.getQueryInterface().showAllTables();

    // 1. 创建留言表 cave_messages
    if (!tables.includes('cave_messages')) {
        await sequelize.getQueryInterface().createTable('cave_messages', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            cave_owner_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '洞府主人玩家ID'
            },
            visitor_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '留言者玩家ID'
            },
            content: {
                type: DataTypes.STRING(200),
                allowNull: false,
                comment: '留言内容（最长200字）'
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            },
            updated_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await sequelize.getQueryInterface().addIndex('cave_messages', ['cave_owner_id'], { name: 'idx_cave_msg_owner' });
        await sequelize.getQueryInterface().addIndex('cave_messages', ['visitor_id'], { name: 'idx_cave_msg_visitor' });
        await sequelize.getQueryInterface().addIndex('cave_messages', ['created_at'], { name: 'idx_cave_msg_time' });

        console.log('[Migration 0021] cave_messages 表创建成功');
    } else {
        console.log('[Migration 0021] cave_messages 表已存在，跳过');
    }

    // 2. 创建访客记录表 cave_visitors
    if (!tables.includes('cave_visitors')) {
        await sequelize.getQueryInterface().createTable('cave_visitors', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            cave_owner_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '洞府主人玩家ID'
            },
            visitor_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '访客玩家ID'
            },
            visited_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW,
                comment: '拜访时间'
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await sequelize.getQueryInterface().addIndex('cave_visitors', ['cave_owner_id'], { name: 'idx_cave_visitor_owner' });
        await sequelize.getQueryInterface().addIndex('cave_visitors', ['visitor_id'], { name: 'idx_cave_visitors' });
        await sequelize.getQueryInterface().addIndex('cave_visitors', ['visited_at'], { name: 'idx_cave_visited_at' });

        console.log('[Migration 0021] cave_visitors 表创建成功');
    } else {
        console.log('[Migration 0021] cave_visitors 表已存在，跳过');
    }

    // 3. 给 player_caves 表新增景观字段
    const caveDesc = await sequelize.getQueryInterface().describeTable('player_caves');
    if (!caveDesc.landscape_id) {
        await sequelize.getQueryInterface().addColumn('player_caves', 'landscape_id', {
            type: DataTypes.STRING(50),
            allowNull: true,
            defaultValue: null,
            comment: '已布置的景观ID（NULL=未布置）'
        });
        console.log('[Migration 0021] player_caves.landscape_id 字段添加成功');
    } else {
        console.log('[Migration 0021] player_caves.landscape_id 已存在，跳过');
    }

    // 4. 给 player_caves 表新增商人刷新时间字段
    if (!caveDesc.merchant_refresh_at) {
        await sequelize.getQueryInterface().addColumn('player_caves', 'merchant_refresh_at', {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
            comment: '商人货品上次刷新时间'
        });
        console.log('[Migration 0021] player_caves.merchant_refresh_at 字段添加成功');
    } else {
        console.log('[Migration 0021] player_caves.merchant_refresh_at 已存在，跳过');
    }

    // 5. 创建商人购买记录表 cave_merchant_purchases
    if (!tables.includes('cave_merchant_purchases')) {
        await sequelize.getQueryInterface().createTable('cave_merchant_purchases', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            player_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '购买者玩家ID'
            },
            item_key: {
                type: DataTypes.STRING(50),
                allowNull: false,
                comment: '购买的商品物品key'
            },
            quantity: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
                comment: '购买数量'
            },
            total_price: {
                type: DataTypes.BIGINT,
                allowNull: false,
                defaultValue: 0,
                comment: '总价（灵石）'
            },
            refresh_batch: {
                type: DataTypes.STRING(50),
                allowNull: false,
                comment: '购买时所属的刷新批次ID'
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await sequelize.getQueryInterface().addIndex('cave_merchant_purchases', ['player_id'], { name: 'idx_merchant_buy_player' });
        await sequelize.getQueryInterface().addIndex('cave_merchant_purchases', ['refresh_batch'], { name: 'idx_merchant_batch' });

        console.log('[Migration 0021] cave_merchant_purchases 表创建成功');
    } else {
        console.log('[Migration 0021] cave_merchant_purchases 表已存在，跳过');
    }

    console.log('[Migration 0021] 洞府社交系统迁移完成');
}

async function down() {
    await sequelize.getQueryInterface().dropTable('cave_merchant_purchases');
    await sequelize.getQueryInterface().removeColumn('player_caves', 'merchant_refresh_at');
    await sequelize.getQueryInterface().removeColumn('player_caves', 'landscape_id');
    await sequelize.getQueryInterface().dropTable('cave_visitors');
    await sequelize.getQueryInterface().dropTable('cave_messages');
    console.log('[Migration 0021] 回滚完成');
}

module.exports = { up, down };
