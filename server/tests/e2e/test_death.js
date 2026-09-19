const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./config/database');
const Player = require('./models/player');
const Realm = require('./models/realm');
const LifespanService = require('./game/core/LifespanService');

async function testDeath() {
    try {
        await sequelize.authenticate();
        console.log('Database connected.');

        // Find a test player
        const player = await Player.findOne();
        if (!player) {
            console.log('No player found.');
            return;
        }

        console.log(`Player before: ${player.nickname}, Lifespan: ${player.lifespan_current}/${player.lifespan_max}, Realm: ${player.realm}`);

        // Force set lifespan to exceed max
        player.lifespan_current = player.lifespan_max + 10;
        await player.save();
        console.log(`Set lifespan to ${player.lifespan_current}`);

        // Test the query used in LifespanService
        const deadPlayers = await Player.findAll({
            where: {
                lifespan_current: {
                    [Op.gte]: sequelize.col('lifespan_max')
                }
            }
        });

        console.log(`Query found ${deadPlayers.length} dead players.`);
        
        if (deadPlayers.length > 0) {
            console.log('Query works correctly.');
            // 修复 B22：原代码调用 LifespanService.handleDeath，但该方法不存在
            // 实际方法名为 handleLifespanEnd（寿元耗尽处理：设置 is_dead、记录死亡原因与时间、推送通知）
            await LifespanService.handleLifespanEnd(player);

            // Reload player to check changes
            await player.reload();
            console.log(`Player after death: Realm: ${player.realm}, Lifespan: ${player.lifespan_current}/${player.lifespan_max}, is_dead: ${player.is_dead}, death_reason: ${player.death_reason}`);
        } else {
            console.error('Query FAILED to find the dead player!');
        }

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await sequelize.close();
    }
}

testDeath();
