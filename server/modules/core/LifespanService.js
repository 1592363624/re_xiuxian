/**
 * 寿命服务
 * 核心逻辑层 - 处理玩家年龄增长与寿命管理
 */
const Player = require('../../models/player');
const configLoader = require('../infrastructure/ConfigLoader');

class LifespanService {
    /**
     * 更新所有在线玩家的寿命
     * @param {number} secondsPassed - 经过的秒数
     */
    async updateLifespan(secondsPassed) {
        try {
            const players = await Player.findAll({
                where: {
                    is_secluded: false
                }
            });

            const roleInitConfig = configLoader.getConfig('role_init');
            const agingRate = this.calculateAgingRate(roleInitConfig);

            for (const player of players) {
                const daysPassed = this.calculateDaysPassed(secondsPassed, player.is_secluded);
                const ageIncrease = daysPassed / 365;
                
                player.lifespan_current = parseFloat((player.lifespan_current || 0) + ageIncrease);

                if (player.lifespan_current >= player.lifespan_max) {
                    player.lifespan_current = player.lifespan_max;
                    await this.handleLifespanEnd(player);
                }

                await player.save();
            }

            return { processed: players.length };
        } catch (error) {
            console.error('寿命更新失败:', error);
            throw error;
        }
    }

    /**
     * 计算衰老速率
     */
    calculateAgingRate(config) {
        if (!config) return 1;
        return config.agingRate || 1;
    }

    /**
     * 计算经过的天数
     */
    calculateDaysPassed(secondsPassed, isSecluded) {
        if (isSecluded) return 0;
        return secondsPassed / 60;
    }

    /**
     * 处理寿命耗尽
     */
    async handleLifespanEnd(player) {
        const expLoss = BigInt(Math.floor(Number(player.exp) * 0.2));
        player.exp = BigInt(player.exp) - expLoss;
        if (player.exp < 0n) player.exp = 0n;
        
        player.hp_current = 0;
        
        return {
            playerId: player.id,
            expLoss: expLoss.toString(),
            message: '寿命耗尽，修为损失20%'
        };
    }

    /**
     * 使用延寿丹
     */
    async useLongevityPill(playerId, years) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.lifespan_max += years;
        await player.save();

        return {
            currentLifespan: player.lifespan_current,
            maxLifespan: player.lifespan_max,
            addedYears: years
        };
    }

    /**
     * 获取寿命状态
     */
    getLifespanStatus(player) {
        const remaining = (player.lifespan_max || 0) - (player.lifespan_current || 0);
        const percentage = player.lifespan_max > 0 
            ? ((player.lifespan_max - player.lifespan_current) / player.lifespan_max * 100).toFixed(1)
            : 0;

        return {
            current: player.lifespan_current,
            max: player.lifespan_max,
            remaining,
            percentage: parseFloat(percentage),
            status: remaining <= 0 ? 'danger' : (remaining < player.lifespan_max * 0.2 ? 'warning' : 'normal')
        };
    }
}

module.exports = new LifespanService();
