/**
 * 检查 system_configs 表中所有配置
 * 确定哪些应该迁移到 JSON 文件
 */
const { sequelize } = require('../config/database');
const SystemConfig = require('../models/system_config');

async function analyzeConfigs() {
    try {
        console.log('=== system_configs 表分析 ===\n');

        const configs = await SystemConfig.findAll();
        
        console.log(`共 ${configs.length} 条配置:\n`);
        
        configs.forEach(c => {
            console.log(`  • ${c.key} = ${c.value} (${c.description || '无描述'})`);
        });

        console.log('\n=== 建议迁移到 JSON 的配置 ===\n');
        console.log('以下配置属于系统级固定配置，建议迁移到 config/ 目录下的 JSON 文件：');
        console.log('');
        configs.forEach(c => {
            console.log(`  - ${c.key}`);
        });
        console.log('');
        console.log('迁移后：');
        console.log('  • 系统固定配置 → config/*.json (可版本控制，方便同步)');
        console.log('  • 玩家动态数据 → 数据库 (需要持久化的玩家状态)');
        console.log('');
        console.log('注意：玩家产生的数据如：');
        console.log('  • 玩家角色信息 (exp, realm, lifespan 等)');
        console.log('  • 背包物品');
        console.log('  • 宗门贡献');
        console.log('  • 聊天记录');
        console.log('  • 管理员操作日志');
        console.log('这些应该保留在数据库中');

    } catch (err) {
        console.error('错误:', err);
    } finally {
        await sequelize.close();
    }
}

analyzeConfigs();
