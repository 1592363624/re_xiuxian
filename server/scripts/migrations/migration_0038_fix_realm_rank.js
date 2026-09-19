/**
 * 迁移脚本 0038：修复所有玩家的 realm_rank（境界排名）
 *
 * 背景：
 *   历史 bug：breakthrough.js 突破时只更新 player.realm（境界名字符串），
 *   未同步更新 player.realm_rank（境界排名数值），导致：
 *     1. DaoCompanionService 等依赖 realm_rank 的业务判断错误（化神期 rank=23 被读成 0/1）
 *     2. 排行榜按 realm_rank 排序失准
 *     3. 瓶颈境界判断（bottleneck_realm_rank）失效
 *
 *   代码修复已提交（breakthrough.js 突破成功时同步 player.realm_rank = nextRealm.rank），
 *   但存量玩家数据需要批量修复：根据当前 realm 字段从配置文件读取正确的 rank。
 *
 * 修复策略：
 *   1. 加载 realm_breakthrough.json 配置
 *   2. 构建 境界名 → rank 映射表
 *   3. 遍历所有玩家
 *   4. 根据玩家 realm 字段查配置中的 rank
 *   5. 如果数据库值与配置值不一致，更新数据库
 *
 * 幂等性：重复执行不会重复更新（值已一致则跳过）
 */
'use strict';

const path = require('path');
const sequelize = require('../config/database');
const Player = require('../models/player');

module.exports = {
    id: '0038_fix_realm_rank',
    description: '修复所有玩家的 realm_rank（突破后未同步更新存量数据）',

    /**
     * 执行迁移
     * @returns {Promise<{total: number, updated: number, skipped: number, errors: string[]}>}
     */
    async up() {
        const result = { total: 0, updated: 0, skipped: 0, errors: [] };

        try {
            // 直接 require 配置文件（避免依赖 ConfigLoader 异步初始化）
            const realmConfigPath = path.join(__dirname, '..', 'config', 'realm_breakthrough.json');
            const realmConfig = require(realmConfigPath);

            // 构建境界名 → rank 映射表
            const realmRankMap = {};
            const realms = realmConfig.realms || realmConfig.realm_breakthrough || [];
            for (const realm of realms) {
                if (realm.name && realm.rank !== undefined) {
                    realmRankMap[realm.name] = realm.rank;
                }
            }

            console.log('[Migration 0038] 配置中找到', Object.keys(realmRankMap).length, '个境界的 rank');

            if (Object.keys(realmRankMap).length === 0) {
                result.errors.push('配置文件中未找到任何境界的 rank，迁移终止');
                return result;
            }

            // 查询所有玩家
            const players = await Player.findAll({
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            });

            result.total = players.length;
            console.log('[Migration 0038] 扫描', result.total, '个玩家');

            for (const player of players) {
                try {
                    const expectedRank = realmRankMap[player.realm];
                    if (expectedRank === undefined) {
                        // 配置中无此境界（可能是测试境界或凡人），跳过
                        result.skipped++;
                        continue;
                    }

                    const currentRank = Number(player.realm_rank) || 0;
                    if (currentRank === Number(expectedRank)) {
                        // 已一致，跳过
                        result.skipped++;
                        continue;
                    }

                    // 需要更新：先记录旧值
                    const oldRank = currentRank;
                    player.realm_rank = expectedRank;
                    await player.save();
                    result.updated++;
                    console.log(`[Migration 0038] 玩家 ${player.id}(${player.nickname}, ${player.realm}) realm_rank: ${oldRank} → ${expectedRank}`);
                } catch (err) {
                    result.errors.push(`玩家 ${player.id}(${player.nickname}) 更新失败: ${err.message}`);
                }
            }

            console.log(`[Migration 0038] 完成: 总计 ${result.total}, 更新 ${result.updated}, 跳过 ${result.skipped}, 错误 ${result.errors.length}`);
            return result;
        } catch (err) {
            result.errors.push(`迁移脚本异常: ${err.message}`);
            console.error('[Migration 0038] 异常:', err);
            return result;
        }
    },

    /**
     * 回滚迁移（不实际回滚，仅记录）
     * realm_rank 修复后不应回滚，否则会导致依赖 realm_rank 的业务判断错误
     */
    async down() {
        console.log('[Migration 0038] 回滚操作被跳过：realm_rank 修复不应回滚');
        return { rolled_back: 0 };
    }
};
