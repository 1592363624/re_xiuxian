/**
 * 资源产出配置加载器
 * 
 * 从 resource_data.json 加载资源产出配置
 */
const path = require('path');
const fs = require('fs');

class ResourceLoader {
    constructor() {
        this.configPath = path.join(__dirname, '../config/resource_data.json');
        this.resourceYieldsCache = null;
        this.proficiencyRulesCache = null;
        this.resourceMap = new Map();
        this.initialized = false;
    }

    load() {
        if (this.initialized) return;

        if (!fs.existsSync(this.configPath)) {
            throw new Error(`资源配置文件不存在: ${this.configPath}`);
        }

        const content = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(content);

        this.resourceYieldsCache = config.resource_yields || [];
        this.proficiencyRulesCache = config.proficiency_rules || {};

        for (const resource of this.resourceYieldsCache) {
            this.resourceMap.set(resource.resource_id, resource);
        }

        this.initialized = true;
        console.log(`[ResourceLoader] 已加载 ${this.resourceYieldsCache.length} 个资源产出配置`);
    }

    getAllResources() {
        this.load();
        return this.resourceYieldsCache;
    }

    getResource(resourceId) {
        this.load();
        return this.resourceMap.get(resourceId) || null;
    }

    getResourceByItemId(itemId) {
        this.load();
        return this.resourceYieldsCache.find(r => r.item_id === itemId) || null;
    }

    getYield(resourceId, proficiencyLevel) {
        const resource = this.getResource(resourceId);
        if (!resource) return [1, 1];

        const yields = resource.yields_by_proficiency || {};
        
        const levels = Object.keys(yields).map(Number).sort((a, b) => b - a);
        for (const level of levels) {
            if (proficiencyLevel >= level) {
                return yields[level];
            }
        }

        return resource.base_yield || [1, 1];
    }

    getMpCost(resourceId) {
        const resource = this.getResource(resourceId);
        return resource ? (resource.base_mp_cost || 5) : 5;
    }

    getCooldown(resourceId) {
        const resource = this.getResource(resourceId);
        return resource ? (resource.cooldown_seconds || 0) : 0;
    }

    getCritChance(resourceId) {
        const resource = this.getResource(resourceId);
        return resource ? (resource.crit_chance || 0) : 0;
    }

    getCritMultiplier(resourceId) {
        const resource = this.getResource(resourceId);
        return resource ? (resource.crit_multiplier || 2) : 2;
    }

    getProficiencyExpToNextLevel(currentLevel) {
        if (!this.proficiencyRulesCache.exp_to_level) {
            return 100;
        }
        const expTable = this.proficiencyRulesCache.exp_to_level;
        if (currentLevel >= expTable.length) {
            return expTable[expTable.length - 1] || 100;
        }
        return expTable[currentLevel] || 100;
    }

    getExpPerGather() {
        return this.proficiencyRulesCache.exp_per_gather || 10;
    }
}

const resourceLoader = new ResourceLoader();
module.exports = resourceLoader;
