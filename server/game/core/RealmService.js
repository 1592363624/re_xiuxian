/**
 * 境界服务
 * 核心逻辑层 - 处理境界相关的核心玩法逻辑
 *
 * 提供：
 * 1. 基础查询：getAllRealms / getRealmByName / getRealmById / getRealmByRank / getNextRealm
 * 2. 境界比较：getRealmRank / resolveMinRealmRank / meetsRealmRequirement
 * 3. 突破逻辑：canBreakthrough / breakthrough / calculateBreakthroughProbability
 *
 * 关键设计（2026-07-19 修复 B1 bug）：
 *   历史代码用 REALM_ORDER.indexOf 做境界比较，但"筑基期/化神期"等大境界名
 *   不在 REALM_ORDER 中（玩家实际境界是"筑基初期/化神中期"等子境界名），
 *   导致化神期及以上玩家被深度闭关等系统错误拦截。
 *   现在统一通过 getRealmRank + resolveMinRealmRank 完成"大境界名→rank"解析。
 */
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const { REALM_TIER_MIN_RANK } = require('../../utils/gameConstants');

class RealmService {
    /**
     * 获取所有境界配置
     */
    getAllRealms() {
        const config = configLoader.getConfig('realm_breakthrough');
        return config?.realms || [];
    }

    /**
     * 根据境界名称获取境界信息
     */
    getRealmByName(realmName) {
        const realms = this.getAllRealms();
        return realms.find(r => r.name === realmName);
    }

    /**
     * 根据境界ID获取境界信息
     */
    getRealmById(realmId) {
        const realms = this.getAllRealms();
        return realms.find(r => r.id === realmId);
    }

    /**
     * 根据境界排名获取境界信息
     */
    getRealmByRank(rank) {
        const realms = this.getAllRealms();
        return realms.find(r => r.rank === rank);
    }

    /**
     * 获取下一境界信息
     */
    getNextRealm(currentRealm) {
        if (!currentRealm) return null;
        const currentRank = currentRealm.rank !== undefined ? currentRealm.rank : 1;
        return this.getRealmByRank(currentRank + 1);
    }

    /**
     * 获取境界排名（用于比较境界高低）
     * @param {string} realmName - 境界名称
     * @returns {number} 排名，0 表示未找到
     */
    getRealmRank(realmName) {
        const realm = this.getRealmByName(realmName);
        return realm?.rank || 0;
    }

    /**
     * 解析境界要求为最低 rank
     *
     * 支持两种输入：
     *   1. 大境界名（如"筑基期"）→ 该境界最低子境界 rank（即"筑基初期"的 rank=11）
     *   2. 具体境界名（如"筑基初期"、"化神中期"）→ 直接返回该境界的 rank
     *
     * 用途：配置文件中的 min_realm 字段（如 seclusion.json 的 "min_realm": "筑基期"）
     *      统一通过此函数转换为数值 rank，再与玩家境界 rank 比较。
     *
     * @param {string} minRealmName - 境界要求名称（大境界名或具体境界名）
     * @returns {number} 最低 rank；未匹配返回 0
     */
    resolveMinRealmRank(minRealmName) {
        if (!minRealmName || typeof minRealmName !== 'string') return 0;

        // 1. 优先精确匹配具体境界名（覆盖"筑基初期/化神中期"等所有子境界）
        const exactRealm = this.getRealmByName(minRealmName);
        if (exactRealm) return exactRealm.rank;

        // 2. 兜底：匹配大境界名映射表（"筑基期"→11、"化神期"→23 等）
        if (Object.prototype.hasOwnProperty.call(REALM_TIER_MIN_RANK, minRealmName)) {
            return REALM_TIER_MIN_RANK[minRealmName];
        }

        // 3. 都不匹配：返回 0（调用方应判断 <=0 表示配置错误）
        return 0;
    }

    /**
     * 判断玩家是否满足境界要求
     *
     * 统一封装"玩家境界 rank vs 配置要求 rank"的比较逻辑，
     * 避免 server 中各处再写一遍 getRealmRank + resolveMinRealmRank 的样板代码。
     *
     * @param {Object|string} playerOrRealm - 玩家对象 或 玩家境界名称
     * @param {string} minRealmName - 配置中的境界要求（大境界名或具体境界名）
     * @returns {{ met: boolean, playerRank: number, requiredRank: number, reason?: string }}
     */
    meetsRealmRequirement(playerOrRealm, minRealmName) {
        const playerRealmName = typeof playerOrRealm === 'string'
            ? playerOrRealm
            : playerOrRealm?.realm;
        const playerRank = this.getRealmRank(playerRealmName);
        const requiredRank = this.resolveMinRealmRank(minRealmName);

        if (playerRank <= 0) {
            return { met: false, playerRank, requiredRank, reason: `玩家境界【${playerRealmName}】未在配置中找到` };
        }
        if (requiredRank <= 0) {
            return { met: false, playerRank, requiredRank, reason: `境界要求【${minRealmName}】无法解析为 rank` };
        }
        if (playerRank < requiredRank) {
            return { met: false, playerRank, requiredRank, reason: `需要达到 ${minRealmName}（rank ${requiredRank}），当前 ${playerRealmName}（rank ${playerRank}）` };
        }
        return { met: true, playerRank, requiredRank };
    }

    /**
     * 计算当前境界修为上限
     */
    getCultivationLimit(realmId) {
        const realm = this.getRealmById(realmId);
        return realm?.cultivation_limit || 0;
    }

    /**
     * 检查是否可以突破
     */
    canBreakthrough(player) {
        const realm = this.getRealmByName(player.realm);
        if (!realm) return { can: false, reason: '境界配置不存在' };

        const currentExp = Number(player.exp || 0);
        const expCap = Number(realm.exp_cap || realm.cultivation_limit || 0);

        if (currentExp >= expCap) {
            return { can: true, nextRealm: this.getNextRealm(realm) };
        }

        return { 
            can: false, 
            reason: `修为不足，需要 ${expCap} 点修为才能突破，当前：${currentExp}` 
        };
    }

    /**
     * 执行突破
     */
    async breakthrough(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '角色不存在' };
        }

        const checkResult = this.canBreakthrough(player);
        if (!checkResult.can) {
            return { success: false, message: checkResult.reason };
        }

        const nextRealm = checkResult.nextRealm;
        if (!nextRealm) {
            return { success: false, message: '已达到最高境界，无法继续突破' };
        }

        const newRealm = nextRealm;
        player.realm = newRealm.name;
        player.exp = 0n;
        await player.save();

        return {
            success: true,
            message: `突破成功！当前境界：${newRealm.name}`,
            newRealm: newRealm
        };
    }

    /**
     * 获取境界突破配置
     */
    getBreakthroughConfig(realmId) {
        const config = configLoader.getConfig('realm_breakthrough');
        const realm = this.getRealmById(realmId);
        if (!realm) return null;

        return {
            currentRealm: realm,
            nextRealm: this.getNextRealm(realm),
            requirement: realm.cultivation_limit,
            bonus: config.breakthrough_bonus || {}
        };
    }

    /**
     * 计算突破成功率
     * @param {Object} player - 玩家对象
     * @param {Object} nextRealm - 下一境界配置
     * @returns {number} 成功率 (0-100)
     */
    calculateBreakthroughProbability(player, nextRealm) {
        const currentRealm = this.getRealmByName(player.realm);
        if (!currentRealm || !nextRealm) {
            throw new Error('境界配置不存在，无法计算突破概率');
        }

        if (currentRealm.breakthrough_probability === undefined) {
            throw new Error(`境界【${currentRealm.name}】未配置突破成功率，请检查配置文件`);
        }

        return currentRealm.breakthrough_probability;
    }
}

module.exports = new RealmService();
