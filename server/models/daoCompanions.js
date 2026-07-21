/**
 * 道侣关系模型（玩家间 1v1 长期社交关系）
 *
 * 与 server/models/daoCompanion.js 区别：
 *   - 旧 daoCompanion 表用于批次3 道侣/侍妾系统（player_a_id/player_b_id 双向 UNIQUE，无 intimacy）
 *   - 新 dao_companions 表用于"道侣/双修系统"重做版（含 intimacy 0-100、心契 0-9、心印、心劫冷却）
 *
 * 表设计：
 *   - player_a_id 为求婚方，player_b_id 为被求婚方
 *   - status: pending(待响应) / accepted(已缔结) / refused(已拒绝) / broken(已解除)
 *   - intimacy: 亲密度 0-100，影响双修加成比例
 *   - heart_contract_level: 心契等级 0-9，每级提升双修加成
 *   - last_interaction_time: 道侣互动（每日问安）冷却时间戳
 *   - last_dual_cultivation_time: 双修冷却时间戳
 *
 * 索引设计：
 *   - idx_dc_player_a / idx_dc_player_b: 按玩家ID查询道侣关系
 *   - uk_active_pair: 防止同一对玩家在 active 状态下重复缔结
 *
 * 注意：player_a_id 与 player_b_id 不强制 UNIQUE，因为玩家解除后可以再次与他人结侣
 */
'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DaoCompanions = sequelize.define('DaoCompanions', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '道侣关系主键ID'
    },
    player_a_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '求婚方玩家ID'
    },
    player_b_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被求婚方玩家ID'
    },
    status: {
        type: DataTypes.ENUM('pending', 'accepted', 'refused', 'broken'),
        allowNull: false,
        defaultValue: 'pending',
        comment: '关系状态：pending=待响应，accepted=已缔结，refused=已拒绝，broken=已解除'
    },
    intimacy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '亲密度（0-100），影响双修加成比例'
    },
    dual_cultivation_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史双修总次数'
    },
    heart_contract_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '心契等级（0-9），每级提升双修加成'
    },
    heart_imprint_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '心印数量（每凝聚3个提升1级心契）'
    },
    last_interaction_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后互动（每日问安）时间，用于24小时冷却'
    },
    last_dual_cultivation_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后双修时间，用于24小时冷却'
    },
    last_heart_tribulation_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后心劫触发时间'
    },
    broken_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '解除时间（用于重新求婚冷却期计算）'
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '创建时间'
    },
    updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '更新时间'
    }
}, {
    tableName: 'dao_companions',
    timestamps: true,
    underscored: true,
    indexes: [
        // 按求婚方查询：检查玩家外发求婚
        { fields: ['player_a_id'], name: 'idx_dc_player_a' },
        // 按被求婚方查询：检查玩家收到的求婚
        { fields: ['player_b_id'], name: 'idx_dc_player_b' },
        // 按状态查询：统计 pending/accepted 关系
        { fields: ['status'], name: 'idx_dc_status' },
        // 唯一约束：同一对玩家在 accepted 状态下不能重复缔结
        // 注意：UNIQUE 仅对 (player_a_id, player_b_id, status='accepted') 生效，
        //       MySQL 不支持条件唯一索引，故用普通复合索引 + 业务层校验
        { fields: ['player_a_id', 'player_b_id', 'status'], name: 'idx_dc_pair_status' }
    ]
});

module.exports = DaoCompanions;
