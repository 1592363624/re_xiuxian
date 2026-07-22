/**
 * 多人副本成员模型
 *
 * 对应数据库表 multi_dungeon_member，记录每个副本实例的成员信息：
 *   - 基础信息：player_id / player_nickname / player_realm（冗余便于查询）
 *   - 角色与状态：role（leader/member）/ is_ready / is_present
 *   - 战斗与贡献：contribution（贡献度）/ hp_remaining（剩余HP）/ zongzi_invested（投粽数）
 *   - 冷却字段：cooldown_end_time（个人冷却到期时间）
 *
 * 表设计要点：
 *   - (instance_id, player_id) UNIQUE KEY，防止同一玩家重复加入同一副本
 *   - 索引 idx_mdm_instance 支持按实例查成员列表
 *   - 索引 idx_mdm_player 支持按玩家查参与副本
 *
 * 关联关系：
 *   - belongsTo MultiDungeonInstance
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MultiDungeonMember = sequelize.define('MultiDungeonMember', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    instance_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '副本实例ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称（冗余）'
    },
    player_realm: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '玩家境界（冗余）'
    },
    player_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家境界rank'
    },
    role: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'member',
        comment: '成员角色：leader/member'
    },
    join_time: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '加入时间'
    },
    is_ready: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已准备（0否1是）'
    },
    is_present: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: '是否在场（0离线1在场）'
    },
    contribution: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本副本贡献度'
    },
    hp_remaining: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '剩余HP（副本内）'
    },
    zongzi_invested: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已投粽数量（端午用）'
    },
    // 血色试炼专属字段（2026-07-21 新增，migration_0058）
    // blood_qi：个人血气（0-100），第1-3幕由抉择影响，归零或被淘汰后标记 is_eliminated=1
    //   - 第1/3幕末按 blood_qi 升序排序，末位淘汰
    blood_qi: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '血色试炼·个人血气（0-100，归零即被淘汰）'
    },
    // kill_score：杀戮分（0-200），第1-3幕抉择累加，影响最终奖励结算
    kill_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '血色试炼·杀戮分（0-200，影响最终奖励）'
    },
    // is_eliminated：是否已被淘汰（0=幸存，1=淘汰）
    //   - 被淘汰后 is_present 同步置 0，不再参与后续抉择与决战
    is_eliminated: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '血色试炼·是否已被淘汰（0=幸存，1=淘汰）'
    },
    // 坠魔谷专属字段（2026-07-21 新增，migration_0059）
    // heart_demon：个人心魔（0-100），满100则堕魔淘汰
    //   - 第1-3幕抉择累加（试道+自身静心降低、血祭+他人试道增加）
    //   - 心魔达到100立即标记 is_fallen=1 并 is_present=0
    heart_demon: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '坠魔谷·个人心魔（0-100，满100则堕魔淘汰）'
    },
    // dao_heart：个人道心（0-100），归0则道心破碎淘汰
    //   - 第1-3幕抉择累加（守道+护道提升、入魔+心魔侵蚀降低）
    //   - 道心归0立即标记 is_fallen=1 并 is_present=0
    dao_heart: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '坠魔谷·个人道心（0-100，归0则道心破碎淘汰）'
    },
    // is_fallen：是否已堕魔（0=未堕魔，1=已堕魔）
    //   - 心魔满100或道心归0都会触发堕魔，堕魔后 is_present 同步置 0
    //   - 与血色试炼的 is_eliminated 区分：堕魔是心魔/道心失衡导致的自我淘汰
    is_fallen: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '坠魔谷·是否已堕魔（0=未堕魔，1=已堕魔）'
    },
    // 黄龙山专属字段（2026-07-21 新增，migration_0060）
    // huanglong_eye_position：阵眼位置（默认 unassigned，第1幕选择后更新为 forward/center/rear/left/right）
    //   - 同一相同阵眼≥2人触发共鸣，5人同阵眼可触发 5 共鸣
    //   - 第1幕入阵固守抉择后由队长统一分配或队员各自选择
    huanglong_eye_position: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'unassigned',
        comment: '黄龙山·阵眼位置（unassigned/forward/center/rear/left/right）'
    },
    // huanglong_contribution_score：个人贡献分（默认 0，影响最终奖励分配）
    //   - 由第1-3幕抉择累加，叛道成员获得双倍贡献分
    //   - 影响首通奖励分配权重和宗门贡献奖励加成
    //   - 与 contribution 区分：contribution 是通用贡献度，huanglong_contribution_score 是黄龙山专属
    huanglong_contribution_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '黄龙山·个人贡献分（影响奖励分配，叛道双倍）'
    },
    // huanglong_is_defecting：是否已叛道（0=未叛道，1=已叛道）
    //   - 叛道后成员不再参与共鸣判定，但保留已获得的贡献分
    //   - 影响完美通关判定（perfect_clear_no_defect=true 时全员未叛道才完美通关）
    //   - 叛道是黄龙山独有的博弈机制：放弃团队共鸣换个人贡献分双倍
    huanglong_is_defecting: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '黄龙山·是否已叛道（0=未叛道，1=已叛道）'
    },
    cooldown_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '个人冷却到期时间'
    }
}, {
    tableName: 'multi_dungeon_member',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['instance_id'], name: 'idx_mdm_instance' },
        { fields: ['player_id'], name: 'idx_mdm_player' },
        // 复合唯一约束防止重复加入同一副本
        { fields: ['instance_id', 'player_id'], unique: true, name: 'uk_mdm_instance_player' }
    ]
});

module.exports = MultiDungeonMember;
