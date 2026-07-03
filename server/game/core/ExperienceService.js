/**
 * 经验服务模块
 * 处理经验获取、等级成长等核心业务逻辑
 */
// 引入宗门服务（导出单例实例），用于获取经验加成
const SectService = require('../services/SectService');

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
        // 获取宗门经验加成（如落云宗 exp_multiplier=1.1 表示修为获取 1.1 倍，即 +10%）
        // 使用 try-catch 包裹，宗门加成获取失败不应阻断经验获取主流程
        let sectMultiplier = 1.0;
        try {
            const sectInfo = await SectService.getPlayerSectBonus(player.id);
            if (sectInfo.bonus?.exp_multiplier) {
                // exp_multiplier 配置为总乘数（如 1.1 表示 1.1 倍），直接覆盖默认值
                sectMultiplier = sectInfo.bonus.exp_multiplier;
            }
        } catch (e) {
            // 宗门加成获取失败时按无加成处理，使用默认乘数 1.0
            sectMultiplier = 1.0;
        }
        // 使用 BigInt 计算避免浮点精度损失：乘以百分比整数再除以 100
        // 例如 exp_multiplier=1.1 时，乘以 110 再除以 100，得到 1.1 倍结果
        const finalExpAmount = BigInt(expAmount) * BigInt(Math.floor(sectMultiplier * 100)) / BigInt(100);
        const exp = BigInt(player.exp) + finalExpAmount;
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
            overflowExp: overflowExp.toString(),
            // 返回宗门经验加成乘数，便于前端展示加成来源
            sect_bonus_multiplier: sectMultiplier
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
     * 计算经验进度百分比
     * @param {BigInt|number|string} currentExp - 当前经验值
     * @param {BigInt|number|string} maxExp - 最大经验值
     * @param {number} decimalPlaces - 保留小数位数，默认2位
     * @returns {number} 经验进度百分比 (0-100)
     */
    calculateExpProgress(currentExp, maxExp, decimalPlaces = 2) {
        const current = BigInt(currentExp || 0);
        const max = BigInt(maxExp || 0);

        if (max <= 0n) return 0;
        if (current <= 0n) return 0;
        if (current >= max) return 100;

        // 使用乘数法保持精度：先乘 10^(decimalPlaces+2) 再除，最后转 Number 还原
        const precision = BigInt(Math.pow(10, decimalPlaces + 2));
        const scaled = (current * 100n * precision) / max;
        const result = Number(scaled) / Number(precision);

        const roundFactor = Math.pow(10, decimalPlaces);
        return Math.round(result * roundFactor) / roundFactor;
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
