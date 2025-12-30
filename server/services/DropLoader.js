/**
 * 掉落配置加载器
 * 
 * 从 drop_data.json 加载怪物掉落配置
 */
const path = require('path');
const fs = require('fs');

class DropLoader {
    constructor() {
        this.configPath = path.join(__dirname, '../config/drop_data.json');
        this.dropsCache = null;
        this.bossDropsCache = null;
        this.monsterDropsMap = new Map();
        this.initialized = false;
    }

    load() {
        if (this.initialized) return;

        if (!fs.existsSync(this.configPath)) {
            throw new Error(`掉落配置文件不存在: ${this.configPath}`);
        }

        const content = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(content);

        this.dropsCache = config.drops || [];
        this.bossDropsCache = config.boss_drops || [];

        for (const drop of this.dropsCache) {
            this.monsterDropsMap.set(drop.monster_id, drop);
        }
        for (const drop of this.bossDropsCache) {
            this.monsterDropsMap.set(drop.monster_id, drop);
        }

        this.initialized = true;
        console.log(`[DropLoader] 已加载 ${this.dropsCache.length} 个普通掉落配置, ${this.bossDropsCache.length} 个Boss掉落配置`);
    }

    getAllDrops() {
        this.load();
        return this.dropsCache;
    }

    getBossDrops() {
        this.load();
        return this.bossDropsCache;
    }

    getMonsterDrop(monsterId) {
        this.load();
        return this.monsterDropsMap.get(monsterId) || null;
    }

    rollDrop(monsterId, playerLuck = 0) {
        const dropData = this.getMonsterDrop(monsterId);
        if (!dropData) return null;

        const droppedItems = [];
        const baseExp = dropData.exp_reward || 0;

        for (const drop of dropData.drops) {
            let chance = drop.chance;
            chance = Math.min(1, chance + (playerLuck * 0.01));
            
            if (Math.random() < chance) {
                const quantity = Array.isArray(drop.quantity) 
                    ? Math.floor(Math.random() * (drop.quantity[1] - drop.quantity[0] + 1)) + drop.quantity[0]
                    : drop.quantity;
                
                droppedItems.push({
                    item_id: drop.item_id,
                    quantity: quantity
                });
            }
        }

        return {
            monster_id: monsterId,
            monster_name: dropData.monster_name,
            exp: baseExp,
            items: droppedItems
        };
    }

    getMonsterExp(monsterId) {
        const dropData = this.getMonsterDrop(monsterId);
        return dropData ? (dropData.exp_reward || 0) : 0;
    }
}

const dropLoader = new DropLoader();
module.exports = dropLoader;
