/**
 * 玩家服务
 * 核心逻辑层 - 处理玩家相关的核心玩法逻辑
 */
const configLoader = require('../infrastructure/ConfigLoader');
const Player = require('../../models/player');

class PlayerService {
    /**
     * 获取玩家完整数据
     */
    async getPlayerData(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        const playerData = player.toJSON();
        playerData.attributes = typeof playerData.attributes === 'string' 
            ? JSON.parse(playerData.attributes) 
            : (playerData.attributes || {});
        playerData.spirit_roots = typeof playerData.spirit_roots === 'string' 
            ? JSON.parse(playerData.spirit_roots) 
            : (playerData.spirit_roots || {});

        return playerData;
    }

    /**
     * 获取玩家属性面板
     */
    async getPlayerAttributes(playerId) {
        const player = await this.getPlayerData(playerId);
        if (!player) return null;

        return {
            hp_max: player.attributes?.hp_max || 100,
            mp_max: player.attributes?.mp_max || 0,
            atk: player.attributes?.atk || 10,
            def: player.attributes?.def || 5,
            speed: player.attributes?.speed || 10,
            sense: player.attributes?.sense || 10,
            luck: player.attributes?.luck || 10,
            wisdom: player.attributes?.wisdom || 10
        };
    }

    /**
     * 初始化玩家数据
     */
    async initializePlayer(username, password, nickname) {
        const roleInitConfig = configLoader.getConfig('role_init');
        
        const initialAttributes = roleInitConfig?.initialAttributes || {
            hp_max: 100,
            mp_max: 0,
            atk: 10,
            def: 5,
            speed: 10,
            sense: 10,
            luck: 10,
            wisdom: 10
        };

        const probabilities = roleInitConfig?.spiritRootProbabilities || {
            '金': 0.2, '木': 0.2, '水': 0.2, '火': 0.2, '土': 0.2
        };
        
        let random = Math.random();
        let selectedRoot = '木';
        let cumulative = 0;
        for (const [root, prob] of Object.entries(probabilities)) {
            cumulative += prob;
            if (random <= cumulative) {
                selectedRoot = root;
                break;
            }
        }

        const spiritRoots = {};
        spiritRoots[`${selectedRoot}灵根`] = {
            level: '基础',
            affinity: Math.floor(Math.random() * 20) + 80
        };

        const player = await Player.create({
            username,
            password,
            nickname,
            realm: '凡人',
            exp: 0,
            cultivation: 0,
            spirit_stones: 0,
            hp_current: initialAttributes.hp_max,
            mp_current: 0,
            toxicity: 0,
            lifespan_current: roleInitConfig?.initialAge || 16,
            lifespan_max: roleInitConfig?.initialLifespan || 60,
            attributes: initialAttributes,
            spirit_roots: spiritRoots,
            role: 'user'
        });

        return player;
    }

    /**
     * 更新玩家属性
     */
    async updateAttributes(playerId, newAttributes) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        const currentAttrs = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});

        const updatedAttrs = { ...currentAttrs, ...newAttributes };
        player.attributes = updatedAttrs;
        await player.save();

        return updatedAttrs;
    }

    /**
     * 增加玩家修为
     */
    async addExp(playerId, amount) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.cultivation = BigInt(player.cultivation) + BigInt(amount);
        await player.save();

        return {
            currentCultivation: player.cultivation.toString(),
            canBreakthrough: false
        };
    }

    /**
     * 更新玩家气血
     */
    async updateHp(playerId, currentHp, maxHp) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        // 检查是否死亡
        if (currentHp <= 0) {
            await this.handlePlayerDeath(playerId);
            // 死亡处理后，返回更新后的玩家数据（HP已重置）
            return await Player.findByPk(playerId);
        }

        player.hp_current = currentHp;
        if (maxHp !== undefined) {
            const attrs = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            attrs.hp_max = maxHp;
            player.attributes = attrs;
        }
        await player.save();

        return player;
    }

    /**
     * 更新玩家灵力
     */
    async updateMp(playerId, currentMp, maxMp) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.mp_current = currentMp;
        if (maxMp !== undefined) {
            const attrs = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            attrs.mp_max = maxMp;
            player.attributes = attrs;
        }
        await player.save();

        return player;
    }

    /**
     * 更新玩家灵石
     */
    async updateSpiritStones(playerId, amount) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.spirit_stones = BigInt(player.spirit_stones) + BigInt(amount);
        if (player.spirit_stones < 0n) player.spirit_stones = 0n;
        await player.save();

        return player.spirit_stones.toString();
    }

    /**
     * 玩家死亡处理
     */
    async handlePlayerDeath(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        const expLoss = BigInt(Math.floor(Number(player.exp) * 0.1));
        player.exp = BigInt(player.exp) - expLoss;
        if (player.exp < 0n) player.exp = 0n;
        
        player.hp_current = player.attributes?.hp_max || 100;
        player.lifespan_current = (player.lifespan_current || 0) + 10;
        
        await player.save();

        return {
            expLoss: expLoss.toString(),
            ageIncrease: 10,
            respawnAt: '出生地'
        };
    }

    /**
     * 查找玩家
     */
    async findPlayerByUsername(username) {
        return await Player.findOne({ where: { username } });
    }

    /**
     * 查找玩家ByID
     */
    async findPlayerById(id) {
        return await Player.findByPk(id);
    }

    /**
     * 获取在线玩家列表
     */
    async getOnlinePlayers() {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        return await Player.findAll({
            where: {
                last_online: {
                    [require('sequelize').Op.gte]: fiveMinutesAgo
                }
            }
        });
    }
}

module.exports = new PlayerService();
