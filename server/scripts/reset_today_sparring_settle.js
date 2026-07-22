/**
 * 重置今日切磋结算状态（清理 SystemConfig + settled_at）
 * 用于业务流程测试前的数据准备
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const SystemConfig = require('../models/system_config');
const PlayerSparring = require('../models/playerSparring');
const { Op } = require('sequelize');

(async () => {
    try {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const configKey = `sparring_settle_${todayStr}`;
        const deleted = await SystemConfig.destroy({ where: { key: configKey } });
        console.log(`✓ 已清理 ${deleted} 条今日(${todayStr})结算标记`);

        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        const [updatedCount] = await PlayerSparring.update(
            { settled_at: null },
            { where: { created_at: { [Op.between]: [todayStart, todayEnd] } } }
        );
        console.log(`✓ 已重置 ${updatedCount} 条今日切磋记录的 settled_at 字段`);
        process.exit(0);
    } catch (err) {
        console.error('重置失败:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
