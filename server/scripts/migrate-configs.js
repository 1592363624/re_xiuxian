/**
 * 数据库配置表检查脚本
 * 检查 system_configs 表中的数据，确定哪些可以迁移/删除
 */
const { sequelize } = require('../config/database');
const SystemConfig = require('../models/system_config');
const fs = require('fs');
const path = require('path');

const SECLUSION_CONFIG_KEYS = [
    'seclusion_cooldown',
    'seclusion_exp_rate',
    'cultivate_interval',
    'deep_seclusion_exp_rate',
    'deep_seclusion_interval'
];

const SECLUSION_CONFIG_FILE = path.join(__dirname, '../config/seclusion.json');

async function checkAndMigrateConfigs() {
    try {
        console.log('=== 检查 system_configs 表 ===\n');

        const configs = await SystemConfig.findAll();
        const toDelete = [];
        const toKeep = [];

        configs.forEach(c => {
            if (SECLUSION_CONFIG_KEYS.includes(c.key)) {
                toDelete.push(c);
                console.log(`[可迁移到JSON] ${c.key} = ${c.value}`);
            } else {
                toKeep.push(c);
                console.log(`[保留在数据库] ${c.key} = ${c.value}`);
            }
        });

        console.log(`\n统计: ${toDelete.length} 条可迁移, ${toKeep.length} 条保留`);

        if (toDelete.length > 0) {
            console.log('\n=== 迁移配置到 seclusion.json ===\n');

            let seclusionConfig = { settings: {} };

            if (fs.existsSync(SECLUSION_CONFIG_FILE)) {
                try {
                    const content = fs.readFileSync(SECLUSION_CONFIG_FILE, 'utf-8');
                    seclusionConfig = JSON.parse(content);
                } catch (e) {
                    console.log('创建新的 seclusion.json');
                }
            }

            for (const config of toDelete) {
                const displayNames = {
                    'seclusion_cooldown': '闭关冷却时间',
                    'seclusion_exp_rate': '闭关基础收益',
                    'cultivate_interval': '修炼时间间隔',
                    'deep_seclusion_exp_rate': '深度闭关收益倍率',
                    'deep_seclusion_interval': '深度闭关时间间隔'
                };

                seclusionConfig.settings[config.key] = {
                    value: parseFloat(config.value) || parseInt(config.value),
                    displayName: displayNames[config.key] || config.key
                };
                console.log(`迁移: ${config.key} = ${config.value}`);
            }

            seclusionConfig.lastUpdated = new Date().toISOString();
            seclusionConfig.version = '1.0.1';

            fs.writeFileSync(SECLUSION_CONFIG_FILE, JSON.stringify(seclusionConfig, null, 2), 'utf-8');
            console.log('\n已更新 seclusion.json');

            // 从数据库删除已迁移的配置
            for (const config of toDelete) {
                await config.destroy();
            }
            console.log(`已从数据库删除 ${toDelete.length} 条配置`);

            console.log('\n✅ 迁移完成！需要重启服务使配置生效');
        }

    } catch (err) {
        console.error('错误:', err);
    } finally {
        try {
            await sequelize.close();
        } catch (e) {}
    }
}

checkAndMigrateConfigs();
