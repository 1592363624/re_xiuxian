const Player = require('./models/player');
const sequelize = require('./config/database');
require('dotenv').config();

async function checkPlayer() {
    try {
        await sequelize.authenticate();
        console.log('Database connected.');

        const player = await Player.findByPk(1);
        if (player) {
            console.log('Player 1 Data:', JSON.stringify(player.toJSON(), null, 2));
            
            // 模拟后端计算逻辑
            const hpMax = 100 + Math.floor(player.exp / 10);
            const expNext = 100 * Math.pow(2, Math.floor(player.exp / 1000));
            
            console.log('Calculated hp_max:', hpMax);
            console.log('Calculated exp_next:', expNext);
        } else {
            console.log('Player 1 not found.');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await sequelize.close();
    }
}

checkPlayer();
