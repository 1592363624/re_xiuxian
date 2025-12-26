/**
 * 经验服务模块
 * 处理经验获取、等级成长等核心业务逻辑
 */
class ExperienceService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化经验服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取当前境界配置
     * @param {string} realmName - 境界名称
     * @returns {Object|null} 境界配置
     */
    getRealmConfig(realmName) {
        const config = this.configLoader?.getConfig('realm_breakthrough');
        if (!config?.realms) return null;
        return config.realms.find(r => r.name === realmName) || null;
    }

    /**
     * 获取角色初始化配置
     * @returns {Object} 角色初始化配置
     */
    getRoleInitConfig() {
        return this.configLoader?.getConfig('role_init') || {};
    }

    /**
     * 计算修为上限
     * @param {Object} player - 玩家对象
     * @returns {BigInt} 修为上限
     */
    getExpCap(player) {
        const realm = this.getRealmConfig(player.realm);
        if (realm && realm.exp_cap) {
            return BigInt(realm.exp_cap);
        }
        const rank = realm?.rank || 1;
        const roleConfig = this.getRoleInitConfig();
        const expGrowthRate = roleConfig.expGrowthRate || 3;
        return BigInt(Math.floor(1000 * Math.pow(rank, expGrowthRate)));
    }

    /**
     * 获取当前境界下一境界所需修为
     * @param {Object} player - 玩家对象
     * @returns {BigInt} 下一境界所需修为
     */
    getNextRealmExpCap(player) {
        const realm = this.getRealmConfig(player.realm);
        if (!realm) return BigInt(0);
        
        const nextRank = realm.rank + 1;
        const roleConfig = this.getRoleInitConfig();
        const expGrowthRate = roleConfig.expGrowthRate || 3;
        return BigInt(Math.floor(1000 * Math.pow(nextRank, expGrowthRate)));
    }

    /**
     * 计算境界突破成功率
     * @param {Object} player - 玩家对象
     * @param {Object} targetRealm - 目标境界配置
     * @returns {number} 成功率 (0-100)
     */
    calculateBreakthroughProbability(player, targetRealm) {
        if (!targetRealm) return 0;
        return targetRealm.breakthrough_probability || 50;
    }

    /**
     * 增加经验
     * @param {Object} player - 玩家对象
     * @param {BigInt|number} expAmount - 经验增加量
     * @returns {Object} 增加结果
     */
    async addExp(player, expAmount) {
        const exp = BigInt(player.exp) + BigInt(expAmount);
        const expCap = this.getExpCap(player);
        let isLevelUp = false;
        let overflowExp = BigInt(0);

        if (exp >= expCap) {
            overflowExp = exp - expCap;
            isLevelUp = true;
        }

        return {
            success: true,
            currentExp: exp.toString(),
            expCap: expCap.toString(),
            isLevelUp: isLevelUp,
            overflowExp: overflowExp.toString()
        };
    }

    /**
     * 计算修为升级所需的经验成长率
     * @param {number} currentRank - 当前境界等级
     * @returns {number} 成长率
     */
    calculateExpGrowthRate(currentRank) {
        const roleConfig = this.getRoleInitConfig();
        const baseRate = roleConfig.expGrowthRate || 3;
        return Math.pow(currentRank, baseRate);
    }

    /**
     * 获取境界突破属性提升
     * @param {string} currentRealm - 当前境界名称
     * @param {string} nextRealm - 下一境界名称
     * @returns {Object} 属性提升
     */
    getBreakthroughAttributeGain(currentRealm, nextRealm) {
        const current = this.getRealmConfig(currentRealm);
        const next = this.getRealmConfig(nextRealm);
        
        if (!current || !next) return null;

        return {
            hp_max: next.base_hp - current.base_hp,
            mp_max: next.base_mp - current.base_mp,
            atk: next.base_atk - current.base_atk,
            def: next.base_def - current.base_def,
            speed: (next.base_speed || 0) - (current.base_speed || 0),
            sense: (next.base_sense || 0) - (current.base_sense || 0)
        };
    }

    /**
     * 检查是否满足突破条件
     * @param {Object} player - 玩家对象
     * @returns {Object} 检查结果
     */
    canBreakthrough(player) {
        const expCap = this.getExpCap(player);
        const currentExp = BigInt(player.exp);
        
        if (currentExp < expCap) {
            return {
                canBreak: false,
                reason: '修为不足',
                currentExp: currentExp.toString(),
                requiredExp: expCap.toString()
            };
        }

        return {
            canBreak: true,
            currentExp: currentExp.toString(),
            expCap: expCap.toString()
        };
    }
}

module.exports = new ExperienceService();
