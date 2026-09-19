/**
 * 数据库迁移脚本
 * 版本: 0003
 * 描述: 初始化系统配置表 system_configs 的默认配置项
 * 创建时间: 2026-07-02
 *
 * 背景：
 *   - system_configs 表此前为空，导致 /api/system/config 返回空数组
 *   - 管理后台 SystemConfig.vue 依赖这些配置项进行展示和修改
 *   - 白名单（system.json 的 client_config_keys）内的配置项才会下发给游戏客户端
 *
 * 数据来源：
 *   - 默认值与 server/config/system.json、server/config/seclusion.json 保持一致
 *   - 避免数据库与 JSON 配置文件出现不一致
 */

module.exports = {
    description: '初始化系统配置表默认配置项',
    version: 3,

    /**
     * 执行迁移：插入默认配置项
     * 使用 INSERT IGNORE 避免重复插入（key 为主键，重复插入会被忽略）
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0003] 开始初始化系统配置...');

        // 默认配置项列表（key, value, description）
        // value 统一存储为字符串，读取时由业务层做类型转换
        const configs = [
            {
                key: 'auto_save_interval',
                value: '10000',
                description: '自动存档间隔（毫秒）- 游戏客户端可见（白名单内）'
            },
            {
                key: 'seclusion_cooldown',
                value: '60',
                description: '闭关冷却时间（秒）'
            },
            {
                key: 'seclusion_exp_rate',
                value: '1',
                description: '闭关基础修为收益倍率'
            },
            {
                key: 'cultivate_interval',
                value: '60',
                description: '修炼时间间隔（秒，默认1分钟）'
            },
            {
                key: 'deep_seclusion_exp_rate',
                value: '2',
                description: '深度闭关修为收益倍率'
            },
            {
                key: 'deep_seclusion_interval',
                value: '72000',
                description: '深度闭关时间间隔（秒）'
            }
        ];

        for (const config of configs) {
            // 使用 INSERT IGNORE，若 key 已存在则跳过，避免覆盖管理员已修改的配置
            await sequelize.query(
                `INSERT IGNORE INTO system_configs (\`key\`, \`value\`, \`description\`, \`createdAt\`, \`updatedAt\`)
                 VALUES (?, ?, ?, NOW(), NOW())`,
                {
                    replacements: [config.key, config.value, config.description],
                    type: QueryTypes.INSERT
                }
            );
            console.log(`  ✓ 插入配置项: ${config.key} = ${config.value}`);
        }

        console.log('[Migration v0003] 系统配置初始化完成');
    },

    /**
     * 回滚迁移：删除本次插入的配置项
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0003] 回滚：删除初始化的配置项...');
        const keys = [
            'auto_save_interval',
            'seclusion_cooldown',
            'seclusion_exp_rate',
            'cultivate_interval',
            'deep_seclusion_exp_rate',
            'deep_seclusion_interval'
        ];
        // 使用参数化查询避免 SQL 注入
        await sequelize.query(
            `DELETE FROM system_configs WHERE \`key\` IN (?, ?, ?, ?, ?, ?)`,
            {
                replacements: keys,
                type: QueryTypes.DELETE
            }
        );
        console.log('[Migration v0003] 回滚完成');
    }
};
