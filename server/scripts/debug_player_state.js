/**
 * 验证测试账号当前数据（exp/spirit_stones/titles）
 * 用于诊断业务流程测试失败原因
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Player = require('../models/player');
const PlayerSparring = require('../models/playerSparring');
const SystemConfig = require('../models/system_config');
const { Op } = require('sequelize');

(async () => {
    try {
        const player = await Player.findByPk(1);
        if (!player) {
            console.log('❌ 玩家ID=1 不存在');
            process.exit(1);
        }
        console.log('===== 玩家数据 =====');
        console.log(`ID: ${player.id}, 昵称: ${player.nickname}, 境界: ${player.realm}`);
        console.log(`exp: ${player.exp}`);
        console.log(`spirit_stones: ${player.spirit_stones}`);
        console.log(`titles: ${JSON.stringify(player.titles)}`);
        console.log(`equipped_title_id: ${player.equipped_title_id}`);
        console.log(`role: ${player.role}, is_dead: ${player.is_dead}`);

        // 查询今日切磋记录
        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        const todayRecords = await PlayerSparring.findAll({
            where: {
                player_id: 1,
                created_at: { [Op.between]: [todayStart, todayEnd] }
            },
            order: [['created_at', 'DESC']]
        });
        console.log('\n===== 今日切磋记录 =====');
        console.log(`共 ${todayRecords.length} 条`);
        for (const r of todayRecords) {
            console.log(`  ID=${r.id}, 木人=${r.woodman_name}, 结果=${r.result}, 评分=${r.score}, settled_at=${r.settled_at?.toISOString() || 'null'}`);
        }

        // 查询今日 SystemConfig 结算记录
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const configKey = `sparring_settle_${todayStr}`;
        const config = await SystemConfig.findByPk(configKey);
        console.log('\n===== 今日 SystemConfig 结算记录 =====');
        if (config) {
            console.log(`key: ${config.key}`);
            console.log(`value: ${config.value}`);
        } else {
            console.log('不存在');
        }

        process.exit(0);
    } catch (err) {
        console.error('查询失败:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
