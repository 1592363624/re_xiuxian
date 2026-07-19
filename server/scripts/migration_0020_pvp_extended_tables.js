/**
 * 数据库迁移脚本 0020：PVP 扩展系统
 *
 * 功能：
 *   1. 给 players 表新增 pvp_mode 字段（避世入世开关）
 *   2. 创建 player_bounties 表（悬赏追杀系统）
 *   3. 创建 fengshen_rankings 表（封神台镜像排名战）
 *
 * 设计说明：
 *   - pvp_mode: active=入世（可被攻击/可获奖励），recluse=避世（免疫攻击/无奖励）
 *   - 悬赏系统：发布者花费灵石发布悬赏，接单者完成悬赏获得悬赏金
 *   - 封神台：赛季制排名竞技场，玩家设置防守阵容，挑战者挑战排名
 */
const sequelize = require('../config/database');
const DataTypes = require('sequelize').DataTypes;

async function up() {
    console.log('[Migration 0020] 开始 PVP 扩展系统迁移...');

    // 1. 给 players 表新增 pvp_mode 字段
    const playerDesc = await sequelize.getQueryInterface().describeTable('players');
    if (!playerDesc.pvp_mode) {
        await sequelize.getQueryInterface().addColumn('players', 'pvp_mode', {
            type: DataTypes.STRING(20),
            defaultValue: 'active',
            allowNull: false,
            comment: 'PVP模式：active=入世，recluse=避世'
        });
        console.log('[Migration 0020] players.pvp_mode 字段添加成功');
    } else {
        console.log('[Migration 0020] players.pvp_mode 字段已存在，跳过');
    }

    // 2. 创建悬赏表 player_bounties
    const bountyTableName = 'player_bounties';
    const tables = await sequelize.getQueryInterface().showAllTables();
    if (!tables.includes(bountyTableName)) {
        await sequelize.getQueryInterface().createTable(bountyTableName, {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            publisher_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '悬赏发布者ID'
            },
            target_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                comment: '悬赏目标玩家ID'
            },
            bounty_amount: {
                type: DataTypes.BIGINT,
                allowNull: false,
                defaultValue: 0,
                comment: '悬赏金额（灵石）'
            },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: 'active',
                comment: '状态：active=悬赏中，accepted=已接单，completed=已完成，expired=已过期，cancelled=已取消'
            },
            acceptor_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                comment: '接单者ID'
            },
            accepted_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '接单时间'
            },
            completed_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '完成时间'
            },
            expire_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '悬赏过期时间'
            },
            battle_record_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                comment: '关联的PVP战斗记录ID'
            },
            reason: {
                type: DataTypes.STRING(200),
                allowNull: true,
                comment: '悬赏理由（可选）'
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

        // 添加索引
        await sequelize.getQueryInterface().addIndex(bountyTableName, ['publisher_id'], { name: 'idx_bounty_publisher' });
        await sequelize.getQueryInterface().addIndex(bountyTableName, ['target_id'], { name: 'idx_bounty_target' });
        await sequelize.getQueryInterface().addIndex(bountyTableName, ['status'], { name: 'idx_bounty_status' });
        await sequelize.getQueryInterface().addIndex(bountyTableName, ['acceptor_id'], { name: 'idx_bounty_acceptor' });

        console.log('[Migration 0020] player_bounties 表创建成功');
    } else {
        console.log('[Migration 0020] player_bounties 表已存在，跳过');
    }

    // 3. 创建封神台排名表 fengshen_rankings
    const fengshenTableName = 'fengshen_rankings';
    if (!tables.includes(fengshenTableName)) {
        await sequelize.getQueryInterface().createTable(fengshenTableName, {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            player_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                unique: 'uk_fengshen_player',
                comment: '玩家ID'
            },
            rank: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: '当前排名（0=未上榜）'
            },
            season: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
                comment: '当前赛季编号'
            },
            fengshen_score: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1000,
                comment: '封神积分（用于排名计算）'
            },
            defense_config: {
                type: DataTypes.TEXT,
                allowNull: true,
                comment: '防守阵容配置JSON（装备/法宝/灵兽快照）'
            },
            defense_set_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '防守阵容设置时间'
            },
            daily_challenge_count: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: '今日挑战次数'
            },
            daily_defend_count: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: '今日被挑战次数'
            },
            total_wins: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: '累计胜利次数'
            },
            total_losses: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: '累计失败次数'
            },
            last_challenge_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '最后挑战日期（用于跨日重置每日次数）'
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

        await sequelize.getQueryInterface().addIndex(fengshenTableName, ['rank'], { name: 'idx_fengshen_rank' });
        await sequelize.getQueryInterface().addIndex(fengshenTableName, ['season'], { name: 'idx_fengshen_season' });
        await sequelize.getQueryInterface().addIndex(fengshenTableName, ['fengshen_score'], { name: 'idx_fengshen_score' });

        console.log('[Migration 0020] fengshen_rankings 表创建成功');
    } else {
        console.log('[Migration 0020] fengshen_rankings 表已存在，跳过');
    }

    console.log('[Migration 0020] PVP 扩展系统迁移完成');
}

async function down() {
    await sequelize.getQueryInterface().dropTable('fengshen_rankings');
    await sequelize.getQueryInterface().dropTable('player_bounties');
    await sequelize.getQueryInterface().removeColumn('players', 'pvp_mode');
    console.log('[Migration 0020] 回滚完成');
}

module.exports = { up, down };
