/**
 * AI 配置数据模型
 *
 * 用于在数据库中存储 GM 后台配置的 AI 服务参数（提供商、Base URL、模型、API Key 等）
 * API Key 字段（encrypted_api_key）使用 AES-256-CBC 加密存储，避免明文落库
 *
 * 表结构：ai_configs
 *   - id: 自增主键
 *   - provider: 提供商标识（openai/deepseek/moonshot 等，对应 ai_config.json 的 providers 键）
 *   - display_name: 显示名称（中文友好名）
 *   - base_url: API 基础 URL（含版本号路径，如 https://api.deepseek.com/v1）
 *   - model: 模型名称（如 gpt-4o、deepseek-chat）
 *   - encrypted_api_key: AES-256-CBC 加密后的 API Key
 *   - is_active: 是否启用（同一时间仅允许一条 is_active=1 的记录生效）
 *   - protocol: 通信协议（openai / anthropic）
 *   - temperature: 采样温度
 *   - max_tokens: 最大输出 token 数
 *   - timeout: 请求超时时间（毫秒）
 *   - last_tested_at: 上次测试连接时间
 *   - last_test_status: 上次测试状态（success / failed）
 *   - last_test_message: 上次测试返回消息（成功或失败原因）
 *   - timestamps: createdAt / updatedAt
 */

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AiConfig = sequelize.define('AiConfig', {
    // 自增主键
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键 ID'
    },

    // 提供商标识，对应 ai_config.json 的 providers 节点键名
    // 如 openai / deepseek / moonshot / anthropic / qwen / zhipu / xiaomi / custom 等
    provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '提供商标识（对应 ai_config.json 的 providers 键名）'
    },

    // 中文友好显示名称，用于 GM 界面展示
    display_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '提供商显示名称'
    },

    // API 基础 URL，应包含版本号路径（如 https://api.deepseek.com/v1）
    base_url: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'API 基础 URL（含版本号路径）'
    },

    // 模型名称（如 gpt-4o、deepseek-chat、moonshot-v1-32k）
    model: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '模型名称'
    },

    // AES-256-CBC 加密后的 API Key（base64 编码）
    // 加密/解密使用 utils/cryptoHelper.js
    encrypted_api_key: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'AES-256-CBC 加密后的 API Key'
    },

    // 通信协议：openai（默认，兼容所有 OpenAI 协议模型）或 anthropic
    protocol: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'openai',
        comment: '通信协议：openai / anthropic'
    },

    // 采样温度（0-2，值越大随机性越强）
    temperature: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0.7,
        comment: '采样温度'
    },

    // 最大输出 token 数
    max_tokens: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: '最大输出 token 数'
    },

    // 请求超时时间（毫秒）
    timeout: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30000,
        comment: '请求超时时间（毫秒）'
    },

    // 是否启用：同一时间仅允许一条 is_active=1 的记录生效
    // 切换启用配置时，后端会自动将其他记录置为 is_active=0
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否启用（同一时间仅允许一条启用）'
    },

    // 上次测试连接时间
    last_tested_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次测试连接时间'
    },

    // 上次测试状态：success / failed
    last_test_status: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '上次测试状态：success / failed'
    },

    // 上次测试返回消息（成功或失败原因，不包含完整 API Key）
    last_test_message: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: '上次测试返回消息'
    }
}, {
    tableName: 'ai_configs',
    timestamps: true,
    indexes: [
        // 唯一索引：provider 字段唯一，防止同一提供商配置重复
        {
            unique: true,
            fields: ['provider']
        }
    ]
});

module.exports = AiConfig;
