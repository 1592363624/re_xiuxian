/**
 * 境界服务
 * 核心逻辑层 - 处理境界相关的核心玩法逻辑
 */
const configLoader = require('../infrastructure/ConfigLoader');
const Player = require('../../models/player');

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
        const currentRank = currentRealm.rank || 1;
        return this.getRealmByRank(currentRank + 1);
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
}

module.exports = new RealmService();
