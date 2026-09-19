/**
 * 数据库迁移脚本 0063：聊天红包系统
 *
 * 功能：
 *   1. 创建 chat_red_packets 表（红包主表）
 *   2. 创建 chat_red_packet_claims 表（红包领取记录表）
 *   3. 修改 chats 表 type 字段 ENUM，新增 'red_packet' 类型
 *
 * 设计说明：
 *   - 红包玩法：玩家在聊天频道发红包（拼手气/普通两种），其他玩家可领取
 *   - 拼手气红包(lucky)：金额随机分配，手气最佳者获得最多
 *   - 普通红包(equal)：每个领取者获得相同金额
 *   - 过期未领取的剩余金额退还发送者（由 StateCleanerService 定期处理）
 *   - 红包消息通过 chats 表 type='red_packet' 记录，content 存储红包元信息 JSON
 *
 * 创建时间：2026-07-22
 */
const sequelize = require('../config/database');
const DataTypes = require('sequelize').DataTypes;

async function up() {
    console.log('[Migration 0063] 开始聊天红包系统迁移...');

    const tables = await sequelize.getQueryInterface().showAllTables();

    // 1. 创建红包主表 chat_red_packets
    if (!tables.includes('chat_red_packets')) {
        await sequelize.getQueryInterface().createTable('chat_red_packets', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            sender_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '发送者玩家ID'
            },
            sender_nickname: {
                type: DataTypes.STRING(50),
                allowNull: false,
                comment: '发送者昵称（冗余字段，便于查询展示）'
            },
            channel: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: 'world',
                comment: '所属频道（world=全局频道，预留 sect/realm 扩展）'
            },
            total_amount: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '红包总金额（灵石）'
            },
            total_count: {
                type: DataTypes.INTEGER,
                allowNull: false,
                comment: '红包总个数'
            },
            remain_amount: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '剩余金额（领取时递减）'
            },
            remain_count: {
                type: DataTypes.INTEGER,
                allowNull: false,
                comment: '剩余个数（领取时递减）'
            },
            packet_type: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: 'lucky',
                comment: '红包类型：lucky=拼手气，equal=普通均分'
            },
            status: {
                type: DataTypes.STRING(15),
                allowNull: false,
                defaultValue: 'active',
                comment: '红包状态：active=可领取，exhausted=已被领完，expired=已过期，refunded=已退款'
            },
            message: {
                type: DataTypes.STRING(100),
                allowNull: true,
                comment: '红包附言（可选，最多100字）'
            },
            expire_at: {
                type: DataTypes.DATE,
                allowNull: false,
                comment: '过期时间（默认创建后24小时）'
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

        await sequelize.getQueryInterface().addIndex('chat_red_packets', ['sender_id'], { name: 'idx_red_packet_sender' });
        await sequelize.getQueryInterface().addIndex('chat_red_packets', ['channel'], { name: 'idx_red_packet_channel' });
        await sequelize.getQueryInterface().addIndex('chat_red_packets', ['status'], { name: 'idx_red_packet_status' });
        await sequelize.getQueryInterface().addIndex('chat_red_packets', ['expire_at'], { name: 'idx_red_packet_expire' });

        console.log('[Migration 0063] chat_red_packets 表创建成功');
    } else {
        console.log('[Migration 0063] chat_red_packets 表已存在，跳过');
    }

    // 2. 创建红包领取记录表 chat_red_packet_claims
    if (!tables.includes('chat_red_packet_claims')) {
        await sequelize.getQueryInterface().createTable('chat_red_packet_claims', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            red_packet_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '关联红包ID'
            },
            receiver_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '领取者玩家ID'
            },
            receiver_nickname: {
                type: DataTypes.STRING(50),
                allowNull: false,
                comment: '领取者昵称（冗余字段）'
            },
            amount: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '领取金额（灵石）'
            },
            is_lucky_king: {
                type: DataTypes.TINYINT,
                allowNull: false,
                defaultValue: 0,
                comment: '是否手气最佳（仅lucky类型，0=否，1=是）'
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await sequelize.getQueryInterface().addIndex('chat_red_packet_claims', ['red_packet_id'], { name: 'idx_red_packet_claim_rp' });
        await sequelize.getQueryInterface().addIndex('chat_red_packet_claims', ['receiver_id'], { name: 'idx_red_packet_claim_receiver' });
        // 唯一索引：同一玩家对同一红包只能领取一次
        await sequelize.getQueryInterface().addIndex('chat_red_packet_claims', ['red_packet_id', 'receiver_id'], {
            name: 'uk_red_packet_claim',
            unique: true
        });

        console.log('[Migration 0063] chat_red_packet_claims 表创建成功');
    } else {
        console.log('[Migration 0063] chat_red_packet_claims 表已存在，跳过');
    }

    // 3. 修改 chats 表 type 字段 ENUM，新增 'red_packet' 类型
    // MySQL 5.6 ENUM 修改需用 ALTER TABLE MODIFY COLUMN
    try {
        const chatDesc = await sequelize.getQueryInterface().describeTable('chats');
        if (chatDesc.type) {
            // 检查当前 ENUM 是否已包含 red_packet（通过 COLUMN_TYPE 字符串判断）
            const [typeInfo] = await sequelize.query(
                "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chats' AND COLUMN_NAME = 'type'",
                { type: sequelize.QueryTypes.SELECT }
            );
            const columnType = (typeInfo && typeInfo.COLUMN_TYPE) || '';
            if (columnType.includes('red_packet')) {
                console.log('[Migration 0063] chats.type ENUM 已包含 red_packet，跳过');
            } else {
                // 新增 red_packet 到 ENUM（保留原有 system/player + 新增 red_packet）
                await sequelize.query(
                    "ALTER TABLE chats MODIFY COLUMN type ENUM('system','player','red_packet') NOT NULL DEFAULT 'player'"
                );
                console.log('[Migration 0063] chats.type ENUM 新增 red_packet 类型成功');
            }
        }
    } catch (err) {
        console.warn('[Migration 0063] 修改 chats.type ENUM 时出错（可能已包含或表结构不同）:', err.message);
    }

    console.log('[Migration 0063] 聊天红包系统迁移完成');
}

async function down() {
    // 回滚：删除红包相关表，恢复 chats.type ENUM
    try {
        await sequelize.query("ALTER TABLE chats MODIFY COLUMN type ENUM('system','player') NOT NULL DEFAULT 'player'");
    } catch (e) {
        console.warn('[Migration 0063] 回滚 chats.type 失败:', e.message);
    }
    await sequelize.getQueryInterface().dropTable('chat_red_packet_claims');
    await sequelize.getQueryInterface().dropTable('chat_red_packets');
    console.log('[Migration 0063] 回滚完成');
}

module.exports = { up, down };
