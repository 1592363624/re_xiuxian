/**
 * 数据库配置迁移脚本
 * 将 system_configs 表中的所有配置迁移到 JSON 文件
 */
const { sequelize } = require('../config/database');
const SystemConfig = require('../models/system_config');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '../config');

const CONFIG_MAPPING = {
    'auto_save_interval': { file: 'system.json', displayName: '自动存档间隔' },
    'initial_lifespan': { file: 'system.json', displayName: '初始寿元' },
    'seclusion_cooldown': { file: 'seclusion.json', displayName: '闭关冷却时间' },
    'seclusion_exp_rate': { file: 'seclusion.json', displayName: '闭关基础收益' },
    'cultivate_interval': { file: 'seclusion.json', displayName: '修炼时间间隔' },
    'deep_seclusion_exp_rate': { file: 'seclusion.json', displayName: '深度闭关收益倍率' },
    'deep_seclusion_interval': { file: 'seclusion.json', displayName: '深度闭关时间间隔' }
};

async function migrateAllConfigs() {
    console.log('=== 系统配置迁移脚本 ===\n');

    try {
        const configs = await SystemConfig.findAll();
        console.log(`发现 ${configs.length} 条配置待迁移\n`);

        const configsByFile = {};

        for (const config of configs) {
            const mapping = CONFIG_MAPPING[config.key];
            if (!mapping) {
                console.log(`[跳过] ${config.key} - 未在映射表中`);
                continue;
            }

            if (!configsByFile[mapping.file]) {
                configsByFile[mapping.file] = [];
            }

            configsByFile[mapping.file].push({
                key: config.key,
                value: parseFloat(config.value) || config.value,
                displayName: mapping.displayName
            });
        }

        for (const [fileName, items] of Object.entries(configsByFile)) {
            console.log(`\n--- ${fileName} ---`);

            let config = { settings: {} };

            const filePath = path.join(CONFIG_DIR, fileName);
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    config = JSON.parse(content);
                    console.log(`已有文件，更新配置项`);
                } catch (e) {
                    console.log(`创建新文件`);
                }
            } else {
                console.log(`创建新文件`);
            }

            for (const item of items) {
                config.settings[item.key] = {
                    value: item.value,
                    displayName: item.displayName
                };
                console.log(`  ✓ ${item.key} = ${item.value}`);
            }

            config.lastUpdated = new Date().toISOString();
            config.version = config.version || '1.0.0';

            fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
        }

        // 从数据库删除所有已迁移的配置
        const keysToDelete = Object.keys(CONFIG_MAPPING);
        const deletedCount = await SystemConfig.destroy({
            where: { key: keysToDelete }
        });

        console.log(`\n\n✅ 迁移完成！`);
        console.log(`   - 已迁移 ${Object.values(configsByFile).reduce((a, b) => a + b.length, 0)} 条配置到 JSON 文件`);
        console.log(`   - 已从数据库删除 ${deletedCount} 条配置`);
        console.log(`\n需要重启服务使配置生效`);

    } catch (err) {
        console.error('迁移失败:', err);
    } finally {
        try {
            await sequelize.close();
        } catch (e) {}
    }
}

migrateAllConfigs();
