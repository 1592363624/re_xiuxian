const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./config/database');
const Player = require('./models/player');

async function setupHighLifespan() {
    try {
        await sequelize.authenticate();
        
        const player = await Player.findOne({ where: { id: 1 } }); // Assuming ID 1
        if (!player) return;

        console.log(`Setting player ${player.nickname} lifespan to 90 (Max: ${player.lifespan_max})`);
        player.lifespan_current = 90;
        await player.save();
        console.log('Done.');

    } catch (error) {
        console.error('Setup failed:', error);
    } finally {
        await sequelize.close();
    }
}

setupHighLifespan();
