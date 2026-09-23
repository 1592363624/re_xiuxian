/**
 * 玩家个人 AI 配置数据模型
 *
 * 用于存储玩家在游戏设置里自己填写的 AI 服务参数（Base URL、模型、API Key）。
 * 玩家启用个人配置后，其触发的大模型调用（历练事件、副本剧情等）会优先走
 * 自己的接口与额度，而不是消耗服务器公共配置的额度。
 *
 * API Key 字段（encrypted_api_key）使用 AES-256-CBC 加密存储（utils/cryptoHelper.js），
 * 与 GM 后台的 ai_configs 表同一套加解密密钥（环境变量 AI_CONFIG_ENCRYPTION_KEY）。
 *
 * 表结构：user_ai_configs
 *   - id: 自增主键
 *   - player_id: 玩家 ID（唯一，一人一条配置）
 *   - base_url: API 基础 URL（含版本号路径，如 https://api.deepseek.com/v1）
 *   - model: 模型名称
 *   - encrypted_api_key: AES-256-CBC 加密后的 API Key
 *   - temperature / max_tokens / timeout: 采样参数（留空则继承全局配置）
 *   - enabled: 是否启用个人配置（关闭后回落到服务器公共配置）
 */

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserAiConfig = sequelize.define('UserAiConfig', {
    // 自增主键
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键 ID'
    },

    // 玩家 ID（players.id，BIGINT），一人一条配置
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        comment: '玩家 ID（唯一索引，一人一条）'
    },

    // API 基础 URL，应包含版本号路径（如 https://api.deepseek.com/v1）
    base_url: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'API 基础 URL（含版本号路径）'
    },

    // 模型名称（如 deepseek-chat、gemini-2.5-flash）
    model: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '模型名称'
    },

    // AES-256-CBC 加密后的 API Key（base64 编码），加解密用 utils/cryptoHelper.js
    encrypted_api_key: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'AES-256-CBC 加密后的 API Key'
    },

    // 采样温度；null 表示继承全局配置
    temperature: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: true,
        comment: '采样温度（null=继承全局）'
    },

    // 最大输出 token 数；null 表示继承全局配置
    max_tokens: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '最大输出 token 数（null=继承全局）'
    },

    // 请求超时毫秒数；null 表示继承全局配置
    timeout: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '请求超时毫秒数（null=继承全局）'
    },

    // 是否启用个人配置：关闭后该玩家的 AI 调用回落到服务器公共配置
    enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: '是否启用个人 AI 配置'
    }
}, {
    tableName: 'user_ai_configs',
    timestamps: true,
    indexes: [
        // 唯一索引：一个玩家最多一条个人 AI 配置
        {
            unique: true,
            fields: ['player_id']
        }
    ]
});

module.exports = UserAiConfig;
