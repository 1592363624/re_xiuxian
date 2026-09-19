/**
 * 数据库迁移脚本
 * 版本: 0004
 * 描述: 创建 AI 配置表 ai_configs，用于 GM 后台管理 AI 服务参数
 * 创建时间: 2026-07-02
 *
 * 表用途：
 *   - 存储 GM 在后台配置的 AI 提供商参数（Base URL、模型、加密 API Key 等）
 *   - API Key 字段使用 AES-256-CBC 加密存储，避免明文落库
 *   - 支持"测试连接"功能，记录测试结果（last_test_status）
 *
 * 安全设计：
 *   - encrypted_api_key 字段存储加密后的密文，非明文
 *   - 加密密钥从环境变量 AI_CONFIG_ENCRYPTION_KEY 读取，不入库
 *   - 接口返回时 API Key 脱敏处理（仅显示后4位）
 */

module.exports = {
    description: '创建 AI 配置表 ai_configs',
    version: 4,

    /**
     * 执行迁移：创建 ai_configs 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0004] 开始创建 ai_configs 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ai_configs (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键 ID',
                provider VARCHAR(50) NOT NULL COMMENT '提供商标识（对应 ai_config.json 的 providers 键名）',
                display_name VARCHAR(100) NOT NULL COMMENT '提供商显示名称',
                base_url VARCHAR(255) NOT NULL COMMENT 'API 基础 URL（含版本号路径）',
                model VARCHAR(100) NOT NULL COMMENT '模型名称',
                encrypted_api_key TEXT NULL COMMENT 'AES-256-CBC 加密后的 API Key',
                protocol VARCHAR(20) NOT NULL DEFAULT 'openai' COMMENT '通信协议：openai / anthropic',
                temperature DECIMAL(3,2) NOT NULL DEFAULT 0.70 COMMENT '采样温度',
                max_tokens INT NOT NULL DEFAULT 1000 COMMENT '最大输出 token 数',
                timeout INT NOT NULL DEFAULT 30000 COMMENT '请求超时时间（毫秒）',
                is_active TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用（同一时间仅允许一条启用）',
                last_tested_at DATETIME NULL COMMENT '上次测试连接时间',
                last_test_status VARCHAR(20) NULL COMMENT '上次测试状态：success / failed',
                last_test_message VARCHAR(500) NULL COMMENT '上次测试返回消息',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_provider (provider)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 配置表（GM 后台管理）'
        `);

        console.log('  ✓ 创建表: ai_configs');
        console.log('[Migration v0004] ai_configs 表创建完成');
    },

    /**
     * 回滚迁移：删除 ai_configs 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0004] 回滚：删除 ai_configs 表...');
        await sequelize.query('DROP TABLE IF EXISTS ai_configs');
        console.log('[Migration v0004] 回滚完成');
    }
};
