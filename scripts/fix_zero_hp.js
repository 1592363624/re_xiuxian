
const path = require('path');
// 加载 server/.env
try {
    require('dotenv').config({ path: path.join(__dirname, '../server/.env') });
} catch (e) {
    require('../server/node_modules/dotenv').config({ path: path.join(__dirname, '../server/.env') });
}

const sequelize = require('../server/config/database');
const Player = require('../server/models/player');
const { core } = require('../server/modules');
const PlayerService = require('../server/modules/core/PlayerService');

async function fixZeroHpPlayers() {
    try {
        console.log('开始扫描 HP <= 0 的玩家...');
        
        // 查找所有 hp_current <= 0 的玩家
        const { Op } = require('../server/node_modules/sequelize');
        const players = await Player.findAll({
            where: {
                hp_current: {
                    [Op.lte]: 0
                }
            }
        });

        console.log(`发现 ${players.length} 名玩家需要修复。`);

        for (const player of players) {
            console.log(`正在修复玩家: ${player.nickname} (ID: ${player.id}, HP: ${player.hp_current})...`);
            
            // 调用死亡处理逻辑
            const result = await PlayerService.handlePlayerDeath(player.id);
            
            console.log(`玩家 ${player.nickname} 已修复: 损失修为 ${result.expLoss}, 增加年龄 ${result.ageIncrease}`);
        }

        console.log('修复完成！');
    } catch (error) {
        console.error('修复过程中出错:', error);
    } finally {
        await sequelize.close();
    }
}

// 确保数据库连接后执行
sequelize.authenticate().then(() => {
    console.log('数据库连接成功');
    fixZeroHpPlayers();
}).catch(err => {
    console.error('无法连接到数据库:', err);
});
