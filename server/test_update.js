const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./config/database');
const Player = require('./models/player');
const LifespanService = require('./services/LifespanService');

async function triggerUpdate() {
    try {
        await sequelize.authenticate();
        
        console.log('Calling LifespanService.updateLifespan(1 second)...');
        // Add 1 second. Should be enough to trigger check.
        await LifespanService.updateLifespan(1); 
        
        const player = await Player.findOne({ where: { id: 1 } });
        console.log(`Player after update: Lifespan: ${player.lifespan_current}/${player.lifespan_max}, Realm: ${player.realm}`);

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await sequelize.close();
    }
}

triggerUpdate();
