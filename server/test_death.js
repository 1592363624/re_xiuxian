const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./config/database');
const Player = require('./models/player');
const Realm = require('./models/realm');
const LifespanService = require('./services/LifespanService');

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
            // Manually trigger handleDeath to verify logic
            await LifespanService.handleDeath(player);
            
            // Reload player to check changes
            await player.reload();
            console.log(`Player after death: Realm: ${player.realm}, Lifespan: ${player.lifespan_current}/${player.lifespan_max}`);
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
