/**
 * 清理切磋木人排行榜结算测试产生的 SystemConfig 记录
 * 仅清理 key 以 'sparring_settle_' 开头的记录，安全无副作用
 *
 * 运行方式：node server/scripts/cleanup_sparring_settle_configs.js
 */
'use strict';

// 显式加载 server/.env（脚本可能从项目根目录运行，dotenv 默认只读 cwd/.env）
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const SystemConfig = require('../models/system_config');
const { Op } = require('sequelize');

(async () => {
    try {
        const deleted = await SystemConfig.destroy({
            where: {
                key: { [Op.like]: 'sparring_settle_%' }
            }
        });
        console.log(`✓ 已清理 ${deleted} 条 sparring_settle_* 记录`);
    } catch (err) {
        console.error('清理失败:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
    process.exit(0);
})();
