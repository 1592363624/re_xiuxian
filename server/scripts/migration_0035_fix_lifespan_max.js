/**
 * 迁移脚本 0035：修复所有玩家的 lifespan_max（寿命上限）
 *
 * 背景：
 *   历史bug：breakthrough.js 突破时读 nextRealm.base_lifespan（数据库字段名），
 *   但配置文件 realm_breakthrough.json 中字段名为 lifespan_max，
 *   导致突破后玩家 lifespan_max 始终未更新，停留在初始境界（凡人）的 800。
 *
 *   代码修复已提交（breakthrough.js 优先读 lifespan_max 兜底 base_lifespan），
 *   但存量玩家数据需要批量修复：根据当前境界从配置文件读取正确的 lifespan_max。
 *
 * 修复策略：
 *   1. 加载 realm_breakthrough.json 配置
 *   2. 遍历所有玩家
 *   3. 根据玩家 realm 字段查配置中的 lifespan_max
 *   4. 如果数据库值与配置值不一致，更新数据库
 *   5. 不修改 lifespan_current（已活寿命），只修 lifespan_max（寿命上限）
 *   6. 如果玩家 lifespan_current > 新的 lifespan_max（不可能但兜底），截断
 *
 * 幂等性：重复执行不会重复更新（值已一致则跳过）
 */
'use strict';

const path = require('path');
const sequelize = require('../config/database');
const Player = require('../models/player');

module.exports = {
    id: '0035_fix_lifespan_max',
    description: '修复所有玩家的 lifespan_max（突破后未更新存量数据）',

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

            // 构建境界名→lifespan_max 映射表
            const realmLifespanMap = {};
            const realms = realmConfig.realms || realmConfig.realm_breakthrough || [];
            for (const realm of realms) {
                if (realm.name && realm.lifespan_max) {
                    realmLifespanMap[realm.name] = realm.lifespan_max;
                }
            }

            console.log('[Migration 0035] 配置中找到', Object.keys(realmLifespanMap).length, '个境界的 lifespan_max');

            if (Object.keys(realmLifespanMap).length === 0) {
                result.errors.push('配置文件中未找到任何境界的 lifespan_max，迁移终止');
                return result;
            }

            // 查询所有玩家
            const players = await Player.findAll({
                attributes: ['id', 'nickname', 'realm', 'lifespan_current', 'lifespan_max']
            });

            result.total = players.length;
            console.log('[Migration 0035] 扫描', result.total, '个玩家');

            for (const player of players) {
                try {
                    const expectedLifespanMax = realmLifespanMap[player.realm];
                    if (!expectedLifespanMax) {
                        // 配置中无此境界（可能是测试境界），跳过
                        result.skipped++;
                        continue;
                    }

                    const currentLifespanMax = Number(player.lifespan_max) || 0;
                    if (currentLifespanMax === Number(expectedLifespanMax)) {
                        // 已一致，跳过
                        result.skipped++;
                        continue;
                    }

                    // 需要更新：先记录旧值
                    const oldLifespanMax = currentLifespanMax;
                    player.lifespan_max = expectedLifespanMax;

                    // 兜底：如果 lifespan_current 超过新的 lifespan_max，截断
                    // （理论上不会发生，但防止数据异常导致玩家立即死亡）
                    const currentLifespanCurrent = Number(player.lifespan_current) || 0;
                    if (currentLifespanCurrent > Number(expectedLifespanMax)) {
                        player.lifespan_current = expectedLifespanMax;
                        console.log(`[Migration 0035] 玩家 ${player.id}(${player.nickname}) lifespan_current 截断: ${currentLifespanCurrent} → ${expectedLifespanMax}`);
                    }

                    await player.save();
                    result.updated++;
                    console.log(`[Migration 0035] 玩家 ${player.id}(${player.nickname}, ${player.realm}) lifespan_max: ${oldLifespanMax} → ${expectedLifespanMax}`);
                } catch (err) {
                    result.errors.push(`玩家 ${player.id}(${player.nickname}) 更新失败: ${err.message}`);
                }
            }

            console.log(`[Migration 0035] 完成: 总计 ${result.total}, 更新 ${result.updated}, 跳过 ${result.skipped}, 错误 ${result.errors.length}`);
            return result;
        } catch (err) {
            result.errors.push(`迁移脚本异常: ${err.message}`);
            console.error('[Migration 0035] 异常:', err);
            return result;
        }
    },

    /**
     * 回滚迁移（不实际回滚，仅记录）
     * 寿命上限修复后不应回滚，否则会导致玩家突破后寿命上限错误
     */
    async down() {
        console.log('[Migration 0035] 回滚操作被跳过：lifespan_max 修复不应回滚');
        return { rolled_back: 0 };
    }
};
