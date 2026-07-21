/**
 * 临战刻印子服务（慕兰战线支线 #7）
 *
 * 实现玩法文档第16节"慕兰战线"中"临战刻印"完整闭环：
 *   - apply(player, artifactId, imprintType) : 给已有法宝施加一次性刻印
 *   - getStatus(player) : 查询今日临战刻印状态
 *
 * 设计要点：
 *   - 每日每玩家仅可施加 1 次刻印（player.border_imprint_date 标记）
 *   - 同时最多 1 个未触发的 active 刻印（max_active_imprints）
 *   - 刻印24小时过期（settings.imprint_duration_seconds）
 *   - matched_route 配置可能是字符串或数组（如 scout_stealth 适配 scout+raid）
 *   - 在 BorderMilitaryService.supportMulanan 中自动检查匹配并触发
 *   - 触发后刻印标记 triggered=true，不再可用
 *
 * 数据库：border_war_imprints 表
 * 配置：border_military_data.json#war_imprint
 */
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerEquipment = require('../../models/playerEquipment');
const BorderWarImprint = require('../../models/border_war_imprint');
const BorderMilitaryService = require('./BorderMilitaryService');
const game = require('../index');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');

// 单例状态
let _initialized = false;
let _config = null;

class WarImprintSubService {
    /**
     * 初始化子服务
     */
    initialize() {
        if (_initialized) return;
        try {
            _config = configLoader.getConfig('border_military_data');
        } catch (e) {
            console.warn('[WarImprintSubService] 配置 border_military_data 未加载:', e.message);
            return;
        }
        if (!_config) return;
        _initialized = true;
        console.log('[WarImprintSubService] 临战刻印子服务初始化完成');
    }

    /**
     * 获取配置（懒加载兜底）
     */
    _getConfig() {
        if (!_initialized || !_config) {
            try {
                _config = configLoader.getConfig('border_military_data');
                _initialized = !!_config;
            } catch (e) {
                return null;
            }
        }
        return _config;
    }

    /**
     * 工具：今日日期字符串
     */
    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * 工具：规范化 matched_route（数组或字符串）为逗号分隔字符串
     */
    _normalizeMatchedRoute(matchedRoute) {
        if (Array.isArray(matchedRoute)) {
            return matchedRoute.join(',');
        }
        return String(matchedRoute || '');
    }

    /**
     * 查询玩家今日临战刻印状态
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 刻印状态
     */
    static async getStatus(player) {
        const self = WarImprintSubService._instance;
        const config = self._getConfig();
        if (!config) return { success: false, message: '配置未加载' };

        const today = self._todayStr();
        const todayDone = player.border_imprint_date === today;

        // 查询所有 active 刻印（未触发且未过期）
        const activeImprints = await BorderWarImprint.findAll({
            where: {
                player_id: player.id,
                triggered: false,
                expires_at: { [Op.gt]: new Date() }
            },
            order: [['created_at', 'DESC']]
        });

        // 查询最近 10 条历史刻印
        const recentImprints = await BorderWarImprint.findAll({
            where: { player_id: player.id },
            order: [['created_at', 'DESC']],
            limit: 10
        });

        const imprintTypes = config.war_imprint?.imprint_types || {};
        const availableTypes = Object.entries(imprintTypes).map(([key, val]) => ({
            type: key,
            name: val.name,
            description: val.description,
            matched_route: self._normalizeMatchedRoute(val.matched_route),
            materials: val.materials,
            bonus_rate: val.bonus_rate
        }));

        return {
            success: true,
            data: {
                today_done: todayDone,
                max_active_imprints: config.war_imprint?.max_active_imprints || 1,
                active_count: activeImprints.length,
                active_imprints: activeImprints.map(i => ({
                    id: i.id,
                    artifact_id: i.artifact_id,
                    artifact_name: i.artifact_name,
                    imprint_type: i.imprint_type,
                    matched_route: i.matched_route,
                    bonus_rate: parseFloat(i.bonus_rate),
                    materials_consumed: JSON.parse(i.materials_consumed || '[]'),
                    expires_at: i.expires_at,
                    created_at: i.created_at
                })),
                recent_imprints: recentImprints.map(i => ({
                    id: i.id,
                    artifact_id: i.artifact_id,
                    artifact_name: i.artifact_name,
                    imprint_type: i.imprint_type,
                    matched_route: i.matched_route,
                    bonus_rate: parseFloat(i.bonus_rate),
                    triggered: i.triggered,
                    triggered_at: i.triggered_at,
                    trigger_route: i.trigger_route,
                    expires_at: i.expires_at,
                    created_at: i.created_at
                })),
                available_types: availableTypes
            }
        };
    }

    /**
     * 给已有法宝施加临战刻印
     * @param {Object} player - 玩家对象
     * @param {number} artifactId - 玩家装备实例ID（PlayerEquipment.id）
     * @param {string} imprintType - 刻印类型：lamp_breaker/array_guard/scout_stealth
     * @returns {Promise<Object>} 刻印结果
     */
    static async apply(player, artifactId, imprintType) {
        const self = WarImprintSubService._instance;
        const config = self._getConfig();
        if (!config) throw new Error('配置未加载');

        // 境界检查
        const realmCheck = BorderMilitaryService._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        // 死亡校验
        if (player.is_dead) {
            return { success: false, message: '玩家已死亡，无法刻印' };
        }

        // 刻印类型校验
        const imprintConfig = config.war_imprint?.imprint_types?.[imprintType];
        if (!imprintConfig) {
            return {
                success: false,
                message: `无效刻印类型：${imprintType}（可选：lamp_breaker/array_guard/scout_stealth）`
            };
        }

        // 每日次数校验
        const today = self._todayStr();
        if (player.border_imprint_date === today) {
            return { success: false, message: '今日已施加过临战刻印，明日再来' };
        }

        // 法宝归属与状态校验
        const artifact = await PlayerEquipment.findOne({
            where: { id: artifactId, player_id: player.id }
        });
        if (!artifact) {
            return { success: false, message: '法宝不存在或不属于您' };
        }

        // 获取法宝名称（优先从物品配置取，fallback 到 item_key）
        let artifactName = artifact.item_key;
        try {
            const InventoryService = game.InventoryService;
            const itemConfig = InventoryService.getItemConfig(artifact.item_key);
            if (itemConfig?.name) artifactName = itemConfig.name;
        } catch (e) {
            // ignore
        }

        // 检查耐久度（破碎法宝不可刻印）
        if (artifact.durability <= 0) {
            return { success: false, message: `法宝【${artifactName}】已破碎，无法刻印` };
        }

        const InventoryService = game.InventoryService;

        // 事务：扣材料+创建刻印记录+标记玩家今日已刻印
        const t = await sequelize.transaction();
        try {
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!freshPlayer) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 并发双重校验
            if (freshPlayer.border_imprint_date === today) {
                await t.rollback();
                return { success: false, message: '今日已施加过临战刻印（并发拦截）' };
            }

            // 检查 active 刻印数量限制
            const maxActive = config.war_imprint?.max_active_imprints || 1;
            const activeCount = await BorderWarImprint.count({
                where: {
                    player_id: freshPlayer.id,
                    triggered: false,
                    expires_at: { [Op.gt]: new Date() }
                },
                transaction: t
            });
            if (activeCount >= maxActive) {
                await t.rollback();
                return {
                    success: false,
                    message: `active 刻印数量已达上限（${maxActive}），请等待已有刻印触发或过期`
                };
            }

            // 校验材料
            const materials = imprintConfig.materials || [];
            for (const mat of materials) {
                const has = await InventoryService.hasItem(freshPlayer.id, mat.key, mat.quantity, t);
                if (!has) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `材料不足：缺少 ${mat.key} × ${mat.quantity}`
                    };
                }
            }

            // 扣除材料
            for (const mat of materials) {
                await InventoryService.removeItem(freshPlayer.id, mat.key, mat.quantity, t);
            }

            // 创建刻印记录
            const durationSec = config.settings?.imprint_duration_seconds || 86400;
            const expiresAt = new Date(Date.now() + durationSec * 1000);
            const matchedRouteStr = self._normalizeMatchedRoute(imprintConfig.matched_route);

            const imprintRecord = await BorderWarImprint.create({
                player_id: freshPlayer.id,
                artifact_id: artifactId,
                artifact_name: artifactName,
                imprint_type: imprintType,
                matched_route: matchedRouteStr,
                bonus_rate: imprintConfig.bonus_rate || 0,
                materials_consumed: JSON.stringify(materials),
                triggered: false,
                triggered_at: null,
                trigger_route: null,
                expires_at: expiresAt
            }, { transaction: t });

            // 标记玩家今日已刻印
            freshPlayer.border_imprint_date = today;
            await freshPlayer.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `临战刻印完成！法宝【${artifactName}】已施加${imprintConfig.name}，匹配路线：${matchedRouteStr}，加成比例 ${(imprintConfig.bonus_rate * 100).toFixed(0)}%，24小时内支援对应路线自动触发`,
                data: {
                    imprint_id: imprintRecord.id,
                    artifact_id: artifactId,
                    artifact_name: artifactName,
                    imprint_type: imprintType,
                    imprint_name: imprintConfig.name,
                    matched_route: matchedRouteStr,
                    bonus_rate: imprintConfig.bonus_rate,
                    materials_consumed: materials,
                    expires_at: expiresAt
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[WarImprintSubService] apply 异常:', err);
            return { success: false, message: `刻印失败：${err.message}` };
        }
    }
}

// 创建单例并暴露
WarImprintSubService._instance = new WarImprintSubService();
WarImprintSubService._instance.initialize();

module.exports = WarImprintSubService;
