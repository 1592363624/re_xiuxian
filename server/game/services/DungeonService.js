/**
 * 副本系统核心服务
 *
 * 功能概述：
 *   - 5章节×5-7关，每关类型：story/battle/puzzle/boss/reward
 *   - 难度三档：normal/hard/nightmare，影响怪物属性与奖励倍率
 *   - HP/MP在关卡间持续，不复位（玩家需策略性管理资源）
 *   - AI剧情可选增强：失败时降级到静态narrative
 *   - 三星评级：HP剩余率≥80%=3星；≥50%=2星；>0%=1星
 *   - 扫荡：三星通关后可扫荡，奖励按比例发放
 *   - 状态机：IN_DUNGEON状态，与一切状态互斥
 *
 * 关键文件依赖：
 *   - server/config/dungeon_data.json：副本静态配置
 *   - server/models/dungeonRecord.js：通关记录模型
 *   - server/models/dungeonProgress.js：进行中进度模型
 *   - server/game/state/PlayerStateMachine.js：状态机
 *   - server/game/services/AIService.js：AI剧情生成（可选）
 *   - server/game/services/InventoryService.js：物品发放
 *   - server/game/services/WebSocketNotificationService.js：实时推送
 */

const { infrastructure } = require('../../modules');
const Player = require('../../models/player');
const DungeonRecord = require('../../models/dungeonRecord');
const DungeonProgress = require('../../models/dungeonProgress');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const RealmService = require('../core/RealmService');
const AttributeService = require('../core/AttributeService');
const AIService = require('./AIService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

/**
 * 工具函数：计算玩家副本战斗属性（HP/MP/ATK/DEF 上限）
 *
 * 修复 B14：原代码直接读取 lockedPlayer.hp_max / lockedPlayer.mp_max / lockedPlayer.attack / lockedPlayer.defense，
 * 但这些字段在 Player 模型上并不存在（hp_max 等是 AttributeService.calculateFullAttributes
 * 计算出来的派生属性）。导致 safeBigInt(undefined) 返回 0n，副本开始时 HP/MP 全部初始化为 0，
 * 战斗计算也使用 0 攻防，玩家进入副本即"秒败"。
 *
 * 正确做法：通过 AttributeService 计算最终属性，取 final.hp_max / final.mp_max / final.atk / final.def。
 * 注意：此处为同步方法，未包含装备加成（_equipmentBonus 未填充）。
 * 对于副本场景这是可接受的——副本开始时玩家应使用"基础+天赋+灵根+称号"的属性快照，
 * 避免副本进行中更换装备导致属性突变。
 *
 * @param {Object} player - 玩家对象（Sequelize 实例）
 * @returns {{hp_max: bigint, mp_max: bigint, atk: bigint, def: bigint}}
 */
function computePlayerBattleAttributes(player) {
    if (!player) return { hp_max: 0n, mp_max: 0n, atk: 0n, def: 0n };
    try {
        const result = AttributeService.calculateFullAttributes(player);
        const final = result?.final || {};
        return {
            hp_max: safeBigInt(final.hp_max || 0),
            mp_max: safeBigInt(final.mp_max || 0),
            atk: safeBigInt(final.atk || 0),
            def: safeBigInt(final.def || 0)
        };
    } catch (e) {
        console.warn('[DungeonService.computePlayerBattleAttributes] 计算玩家属性失败:', e.message);
        return { hp_max: 0n, mp_max: 0n, atk: 0n, def: 0n };
    }
}

/**
 * 工具函数：跨日重置每日次数
 * @param {Object} player - 玩家对象
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 */
function resetDailyCountIfCrossDay(player, dateField, countField) {
    const today = new Date().toISOString().slice(0, 10);
    const lastDate = player[dateField];
    if (lastDate) {
        const lastStr = lastDate instanceof Date
            ? lastDate.toISOString().slice(0, 10)
            : String(lastDate).slice(0, 10);
        if (lastStr !== today) {
            player[countField] = 0;
            player[dateField] = today;
        }
    } else {
        player[countField] = 0;
        player[dateField] = today;
    }
}

/**
 * 工具函数：检查冷却
 * @param {Object} player - 玩家对象
 * @param {string} timeField - 时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(player, timeField, cooldownSec) {
    const lastTime = player[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) return { ready: true, remainingSec: 0 };
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

/**
 * 工具函数：BigInt 安全转换
 * @param {*} value - 任意值
 * @returns {bigint}
 */
function safeBigInt(value) {
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'bigint') return value;
    try { return BigInt(value); } catch (e) { return 0n; }
}

/**
 * 工具函数：根据当前难度获取倍率
 * @param {string} difficulty - 难度
 * @param {string} key - 倍率键（hp/atk/exp/spirit_stones/drop_rate）
 * @returns {number}
 */
function getDifficultyMultiplier(difficulty, key) {
    const cfg = getDungeonConfig();
    const multipliers = cfg.global.difficulty_multipliers?.[difficulty];
    return multipliers?.[key] ?? 1.0;
}

/**
 * 获取副本配置（懒加载，每次调用都从ConfigLoader读取最新）
 * @returns {Object}
 */
function getDungeonConfig() {
    return infrastructure.ConfigLoader.getConfig('dungeon_data') || { global: {}, chapters: [] };
}

/**
 * 根据章节ID获取章节配置
 * @param {string} chapterId - 章节ID
 * @returns {Object|null}
 */
function getChapterById(chapterId) {
    const cfg = getDungeonConfig();
    return cfg.chapters?.find(c => c.id === chapterId) || null;
}

/**
 * 根据节点ID获取节点配置
 * @param {Object} chapter - 章节配置
 * @param {string} nodeId - 节点ID
 * @returns {Object|null}
 */
function getNodeById(chapter, nodeId) {
    return chapter.nodes?.find(n => n.id === nodeId) || null;
}

class DungeonService {
    /**
     * 获取副本全局配置（供前端展示规则说明）
     * @returns {Object}
     */
    getConfig() {
        const cfg = getDungeonConfig();
        return {
            global: cfg.global,
            chapters: cfg.chapters?.map(c => ({
                id: c.id,
                name: c.name,
                description: c.description,
                min_realm_rank: c.min_realm_rank,
                recommended_realm: c.recommended_realm,
                duration_sec: c.duration_sec,
                node_count: c.nodes?.length || 0,
                boss_name: c.boss?.name
            }))
        };
    }

    /**
     * 获取玩家副本状态总览
     * @param {Object} player - 玩家对象
     * @returns {Object}
     */
    async getStatus(player) {
        const cfg = getDungeonConfig();
        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 0;

        // 跨日重置今日次数
        resetDailyCountIfCrossDay(player, 'last_dungeon_date', 'daily_dungeon_count');

        // 冷却检查
        const cooldown = checkCooldown(player, 'last_dungeon_time', cfg.global.cooldown_seconds);

        // 进行中副本
        let inProgress = null;
        if (player.in_dungeon) {
            const progress = await DungeonProgress.findOne({ where: { player_id: player.id } });
            if (progress) {
                const chapter = getChapterById(progress.chapter_id);
                const node = chapter ? getNodeById(chapter, progress.current_node_id) : null;
                const remainingSec = Math.max(0, Math.floor((new Date(progress.expires_at) - Date.now()) / 1000));
                // 修复 B14：返回 hp_max / mp_max 供前端进度条正确显示
                // 否则前端只能用硬编码 1000/500 估算，与实际玩家属性差距大
                const statusBattleAttr = computePlayerBattleAttributes(player);
                inProgress = {
                    chapter_id: progress.chapter_id,
                    chapter_name: chapter?.name || progress.chapter_id,
                    difficulty: progress.difficulty,
                    current_node_id: progress.current_node_id,
                    current_node_type: progress.current_node_type,
                    current_node_title: node?.title || '',
                    hp_remaining: progress.hp_remaining?.toString() || '0',
                    hp_max: statusBattleAttr.hp_max.toString(),
                    mp_remaining: progress.mp_remaining?.toString() || '0',
                    mp_max: statusBattleAttr.mp_max.toString(),
                    exp_accumulated: progress.exp_accumulated?.toString() || '0',
                    spirit_stones_accumulated: progress.spirit_stones_accumulated?.toString() || '0',
                    items_collected: progress.items_collected || [],
                    start_time: progress.start_time,
                    expires_at: progress.expires_at,
                    remaining_seconds: remainingSec,
                    nodes_completed_count: (progress.nodes_completed || []).length
                };
            }
        }

        // 通关记录（星级展示）
        const records = await DungeonRecord.findAll({
            where: { player_id: player.id },
            order: [['completed_at', 'DESC']]
        });
        const completedChapters = records.map(r => ({
            chapter_id: r.chapter_id,
            chapter_name: r.chapter_name,
            difficulty: r.difficulty,
            stars: r.stars,
            completed_at: r.completed_at
        }));

        return {
            realm_rank: realmRank,
            realm_name: player.realm,
            min_realm_rank: cfg.global.min_realm_rank,
            unlocked: realmRank >= cfg.global.min_realm_rank,
            in_dungeon: !!player.in_dungeon,
            in_progress: inProgress,
            daily_challenge_count: player.daily_dungeon_count,
            daily_challenge_limit: cfg.global.daily_challenge_limit,
            cooldown_ready: cooldown.ready,
            cooldown_remaining_sec: cooldown.remainingSec,
            completed_chapters: completedChapters,
            sweep_min_stars: cfg.global.sweep_min_stars,
            sweep_reward_ratio: cfg.global.sweep_reward_ratio
        };
    }

    /**
     * 开始副本挑战
     * @param {Object} player - 玩家对象
     * @param {string} chapterId - 章节ID
     * @param {string} difficulty - 难度
     * @returns {Object} Service 结果
     */
    async startDungeon(player, chapterId, difficulty) {
        const cfg = getDungeonConfig();
        const chapter = getChapterById(chapterId);
        if (!chapter) {
            return { success: false, message: '副本章节不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        // 难度校验
        if (!['normal', 'hard', 'nightmare'].includes(difficulty)) {
            return { success: false, message: '无效的难度', error_code: 'VALIDATION_ERROR' };
        }

        // 境界校验
        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 0;
        if (realmRank < chapter.min_realm_rank) {
            return {
                success: false,
                message: `境界不足，需达到 ${chapter.recommended_realm} 或以上`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 跨日重置 + 次数校验
        resetDailyCountIfCrossDay(player, 'last_dungeon_date', 'daily_dungeon_count');
        if (player.daily_dungeon_count >= cfg.global.daily_challenge_limit) {
            return {
                success: false,
                message: `今日挑战次数已用完（${cfg.global.daily_challenge_limit}次/天）`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 冷却校验
        const cooldown = checkCooldown(player, 'last_dungeon_time', cfg.global.cooldown_seconds);
        if (!cooldown.ready) {
            return {
                success: false,
                message: `副本冷却中，剩余 ${cooldown.remainingSec} 秒`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 状态机互斥校验
        const PlayerStateMachine = require('../state/PlayerStateMachine');
        const stateCheck = await PlayerStateMachine.canStart(player.id, PlayerStateMachine.PlayerState.IN_DUNGEON);
        if (!stateCheck.allowed) {
            return { success: false, message: stateCheck.reason, error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        // 事务：创建进度记录 + 更新玩家状态
        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });

            // 双重检查：是否已在副本中
            const existingProgress = await DungeonProgress.findOne({
                where: { player_id: player.id },
                transaction: t
            });
            if (existingProgress || lockedPlayer.in_dungeon) {
                await t.commit();
                return { success: false, message: '已有进行中的副本，请先完成或中断', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            // 第一节点
            const firstNode = chapter.nodes[0];
            const now = new Date();
            const expiresAt = new Date(now.getTime() + chapter.duration_sec * 1000);

            // 玩家原始HP/MP（副本内独立计算）
            // 修复 B14：lockedPlayer.hp_max 等字段不存在于 Player 模型，
            // 必须通过 AttributeService 计算派生属性，否则 safeBigInt(undefined)=0n
            const battleAttr = computePlayerBattleAttributes(lockedPlayer);
            const playerHpMax = battleAttr.hp_max;
            const playerMpMax = battleAttr.mp_max;

            // 创建进度
            const progress = await DungeonProgress.create({
                player_id: player.id,
                chapter_id: chapterId,
                difficulty,
                current_node_id: firstNode.id,
                current_node_type: firstNode.type,
                nodes_completed: [],
                hp_remaining: playerHpMax.toString(),
                mp_remaining: playerMpMax.toString(),
                items_collected: [],
                exp_accumulated: 0,
                spirit_stones_accumulated: 0,
                ai_context: null,
                start_time: now,
                last_active_time: now,
                expires_at: expiresAt
            }, { transaction: t });

            // 更新玩家状态
            lockedPlayer.in_dungeon = true;
            lockedPlayer.dungeon_chapter_id = chapterId;
            lockedPlayer.dungeon_node_id = firstNode.id;
            lockedPlayer.dungeon_difficulty = difficulty;
            lockedPlayer.dungeon_start_time = now;
            lockedPlayer.daily_dungeon_count = (lockedPlayer.daily_dungeon_count || 0) + 1;
            if (!lockedPlayer.last_dungeon_date) {
                lockedPlayer.last_dungeon_date = now.toISOString().slice(0, 10);
            }
            await lockedPlayer.save({ transaction: t });

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: 'dungeon_start',
                chapter_id: chapterId,
                chapter_name: chapter.name,
                difficulty
            });

            // 返回首关内容
            const nodeContent = await this._renderNodeContent(progress, chapter, firstNode, lockedPlayer);

            return {
                success: true,
                message: `进入副本：${chapter.name}（${this._difficultyDisplayName(difficulty)}）`,
                data: {
                    progress_id: progress.id,
                    chapter_id: chapterId,
                    chapter_name: chapter.name,
                    difficulty,
                    current_node: nodeContent,
                    hp_remaining: progress.hp_remaining?.toString(),
                    mp_remaining: progress.mp_remaining?.toString(),
                    expires_at: progress.expires_at,
                    nodes_total: chapter.nodes.length
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService.startDungeon] 错误:', err);
            return { success: false, message: '服务器错误，无法进入副本', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 获取当前关卡节点内容
     * @param {Object} player - 玩家对象
     * @returns {Object}
     */
    async getCurrentNode(player) {
        if (!player.in_dungeon) {
            return { success: false, message: '当前未在副本中', error_code: 'BUSINESS_LOGIC_ERROR' };
        }
        const progress = await DungeonProgress.findOne({ where: { player_id: player.id } });
        if (!progress) {
            return { success: false, message: '副本进度不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        // 检查是否过期
        if (new Date(progress.expires_at) <= new Date()) {
            return { success: false, message: '副本已超时，正在结算...', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const chapter = getChapterById(progress.chapter_id);
        if (!chapter) {
            return { success: false, message: '章节配置不存在', error_code: 'INTERNAL_ERROR' };
        }
        const node = getNodeById(chapter, progress.current_node_id);
        if (!node) {
            return { success: false, message: '节点配置不存在', error_code: 'INTERNAL_ERROR' };
        }

        const nodeContent = await this._renderNodeContent(progress, chapter, node, player);

        return {
            success: true,
            data: {
                chapter_id: progress.chapter_id,
                chapter_name: chapter.name,
                difficulty: progress.difficulty,
                current_node: nodeContent,
                hp_remaining: progress.hp_remaining?.toString(),
                mp_remaining: progress.mp_remaining?.toString(),
                exp_accumulated: progress.exp_accumulated?.toString(),
                spirit_stones_accumulated: progress.spirit_stones_accumulated?.toString(),
                items_collected: progress.items_collected || [],
                nodes_completed_count: (progress.nodes_completed || []).length,
                nodes_total: chapter.nodes.length,
                expires_at: progress.expires_at,
                remaining_seconds: Math.max(0, Math.floor((new Date(progress.expires_at) - Date.now()) / 1000))
            }
        };
    }

    /**
     * 选择解谜节点选项
     * @param {Object} player - 玩家对象
     * @param {string} optionId - 选项ID
     * @returns {Object}
     */
    async chooseOption(player, optionId) {
        if (!player.in_dungeon) {
            return { success: false, message: '当前未在副本中', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });
            const progress = await DungeonProgress.findOne({
                where: { player_id: player.id },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!progress) {
                await t.commit();
                return { success: false, message: '副本进度不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const chapter = getChapterById(progress.chapter_id);
            const node = getNodeById(chapter, progress.current_node_id);
            if (node.type !== 'puzzle') {
                await t.commit();
                return { success: false, message: '当前节点不是解谜关', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const option = node.options?.find(o => o.id === optionId);
            if (!option) {
                await t.commit();
                return { success: false, message: '无效的选项', error_code: 'VALIDATION_ERROR' };
            }

            // 应用 HP/MP 变化
            // 修复 B14：通过 AttributeService 计算 max HP/MP
            const currentHp = safeBigInt(progress.hp_remaining);
            const puzzleBattleAttr = computePlayerBattleAttributes(lockedPlayer);
            const playerHpMax = puzzleBattleAttr.hp_max;
            let newHp = currentHp;
            if (option.hp_cost_ratio) {
                const cost = BigInt(Math.floor(Number(playerHpMax) * option.hp_cost_ratio));
                newHp = newHp - cost;
            }
            if (option.hp_recover_ratio) {
                const recover = BigInt(Math.floor(Number(playerHpMax) * option.hp_recover_ratio));
                newHp = newHp + recover;
                if (newHp > playerHpMax) newHp = playerHpMax;
            }
            if (newHp < 0n) newHp = 0n;

            const currentMp = safeBigInt(progress.mp_remaining);
            const playerMpMax = puzzleBattleAttr.mp_max;
            let newMp = currentMp;
            if (option.mp_cost_ratio) {
                const cost = BigInt(Math.floor(Number(playerMpMax) * option.mp_cost_ratio));
                newMp = newMp - cost;
                if (newMp < 0n) newMp = 0n;
            }

            // 应用奖励
            const rewards = option.rewards || {};
            const expGained = BigInt(Math.floor((rewards.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')));
            const stonesGained = BigInt(Math.floor((rewards.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones')));
            const itemsGained = rewards.items || [];

            progress.hp_remaining = newHp.toString();
            progress.mp_remaining = newMp.toString();
            progress.exp_accumulated = (safeBigInt(progress.exp_accumulated) + expGained).toString();
            progress.spirit_stones_accumulated = (safeBigInt(progress.spirit_stones_accumulated) + stonesGained).toString();
            const collected = progress.items_collected || [];
            for (const item of itemsGained) {
                collected.push({ ...item, source: 'puzzle_option' });
            }
            progress.items_collected = collected;

            // HP 归零 → 失败结算
            if (newHp <= 0n) {
                progress.nodes_completed = [...(progress.nodes_completed || []), node.id];
                progress.last_active_time = new Date();
                await progress.save({ transaction: t });
                await t.commit();
                return await this._settleDungeon(player, false, '解谜选择导致HP耗尽');
            }

            // 推进到下一节点
            const nextNodeId = option.next_node;
            const nextNode = nextNodeId ? getNodeById(chapter, nextNodeId) : null;
            const nodesCompleted = [...(progress.nodes_completed || []), node.id];
            progress.nodes_completed = nodesCompleted;
            progress.last_active_time = new Date();

            if (!nextNode) {
                // 无下一节点，结算成功
                await progress.save({ transaction: t });
                await t.commit();
                return await this._settleDungeon(player, true, '章节通关');
            }

            progress.current_node_id = nextNode.id;
            progress.current_node_type = nextNode.type;
            await progress.save({ transaction: t });

            // 同步玩家身上的 dungeon_node_id
            lockedPlayer.dungeon_node_id = nextNode.id;
            await lockedPlayer.save({ transaction: t });

            await t.commit();

            const nodeContent = await this._renderNodeContent(progress, chapter, nextNode, lockedPlayer);
            return {
                success: true,
                message: option.result_text || '已选择',
                data: {
                    choice_result: option.result_text,
                    hp_change: option.hp_cost_ratio ? `-${Math.floor(Number(playerHpMax) * option.hp_cost_ratio)}` :
                              option.hp_recover_ratio ? `+${Math.floor(Number(playerHpMax) * option.hp_recover_ratio)}` : '0',
                    rewards: { exp: expGained.toString(), spirit_stones: stonesGained.toString(), items: itemsGained },
                    current_node: nodeContent,
                    hp_remaining: progress.hp_remaining?.toString(),
                    mp_remaining: progress.mp_remaining?.toString()
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService.chooseOption] 错误:', err);
            return { success: false, message: '服务器错误', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 推进节点（用于 story/battle/boss/reward 节点）
     * - story 节点：直接推进到 next_node
     * - battle 节点：必须先调用 battleNode 完成战斗
     * - reward 节点：领取奖励后推进到 next_node
     * - boss 节点：必须先调用 battleNode 完成 BOSS 战
     * @param {Object} player - 玩家对象
     * @returns {Object}
     */
    async advanceNode(player) {
        if (!player.in_dungeon) {
            return { success: false, message: '当前未在副本中', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });
            const progress = await DungeonProgress.findOne({
                where: { player_id: player.id },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!progress) {
                await t.commit();
                return { success: false, message: '副本进度不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const chapter = getChapterById(progress.chapter_id);
            const node = getNodeById(chapter, progress.current_node_id);

            // 仅 story / reward 节点可直接推进
            if (!['story', 'reward'].includes(node.type)) {
                await t.commit();
                return {
                    success: false,
                    message: `当前为${this._nodeTypeDisplayName(node.type)}节点，需先完成对应操作`,
                    error_code: 'BUSINESS_LOGIC_ERROR'
                };
            }

            // 应用 reward 节点奖励
            if (node.type === 'reward' && node.rewards) {
                const rewards = node.rewards;
                const expGained = BigInt(Math.floor((rewards.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')));
                const stonesGained = BigInt(Math.floor((rewards.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones')));
                const itemsGained = rewards.items || [];
                progress.exp_accumulated = (safeBigInt(progress.exp_accumulated) + expGained).toString();
                progress.spirit_stones_accumulated = (safeBigInt(progress.spirit_stones_accumulated) + stonesGained).toString();
                const collected = progress.items_collected || [];
                for (const item of itemsGained) collected.push({ ...item, source: 'reward_node' });
                progress.items_collected = collected;
            }

            // 推进
            const nextNode = node.next_node ? getNodeById(chapter, node.next_node) : null;
            const nodesCompleted = [...(progress.nodes_completed || []), node.id];
            progress.nodes_completed = nodesCompleted;
            progress.last_active_time = new Date();

            if (!nextNode) {
                await progress.save({ transaction: t });
                await t.commit();
                return await this._settleDungeon(player, true, '章节通关');
            }

            progress.current_node_id = nextNode.id;
            progress.current_node_type = nextNode.type;
            await progress.save({ transaction: t });

            lockedPlayer.dungeon_node_id = nextNode.id;
            await lockedPlayer.save({ transaction: t });

            await t.commit();

            const nodeContent = await this._renderNodeContent(progress, chapter, nextNode, lockedPlayer);
            return {
                success: true,
                message: `进入下一关：${nextNode.title || ''}`,
                data: {
                    current_node: nodeContent,
                    hp_remaining: progress.hp_remaining?.toString(),
                    mp_remaining: progress.mp_remaining?.toString(),
                    exp_accumulated: progress.exp_accumulated?.toString(),
                    spirit_stones_accumulated: progress.spirit_stones_accumulated?.toString()
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService.advanceNode] 错误:', err);
            return { success: false, message: '服务器错误', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 战斗节点：执行战斗
     * 简化战斗逻辑：玩家属性 vs 怪物属性，按回合制计算
     * 战斗结果直接更新 progress.hp_remaining
     * @param {Object} player - 玩家对象
     * @returns {Object}
     */
    async battleNode(player) {
        if (!player.in_dungeon) {
            return { success: false, message: '当前未在副本中', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });
            const progress = await DungeonProgress.findOne({
                where: { player_id: player.id },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!progress) {
                await t.commit();
                return { success: false, message: '副本进度不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const chapter = getChapterById(progress.chapter_id);
            const node = getNodeById(chapter, progress.current_node_id);
            if (!['battle', 'boss'].includes(node.type)) {
                await t.commit();
                return { success: false, message: '当前节点不是战斗关', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            // 获取怪物配置（boss 节点用 chapter.boss，battle 节点用 node.monster）
            let monster;
            if (node.type === 'boss' && node.monster_ref === 'boss') {
                monster = { ...chapter.boss };
            } else {
                monster = { ...node.monster };
            }

            // 应用难度倍率
            const hpMult = getDifficultyMultiplier(progress.difficulty, 'hp');
            const atkMult = getDifficultyMultiplier(progress.difficulty, 'atk');
            monster.hp = Math.floor(monster.hp * hpMult);
            monster.attack = Math.floor(monster.attack * atkMult);

            // 玩家属性
            // 修复 B14：lockedPlayer.attack/defense/hp_max 都不是 Player 模型字段，
            // 必须通过 AttributeService 计算派生属性
            const battleAttr = computePlayerBattleAttributes(lockedPlayer);
            const playerHp = safeBigInt(progress.hp_remaining);
            const playerMp = safeBigInt(progress.mp_remaining);
            const playerAtk = battleAttr.atk;
            const playerDef = battleAttr.def;
            const playerHpMax = battleAttr.hp_max;

            // 简化回合制战斗
            let currentHp = playerHp;
            let monsterHp = BigInt(monster.hp);
            const monsterAtk = BigInt(monster.attack);
            const monsterDef = BigInt(monster.defense || 0);
            const battleLog = [];
            const maxRounds = 50;

            for (let round = 1; round <= maxRounds; round++) {
                // 玩家攻击怪物
                const playerDmg = this._calculateDamage(playerAtk, monsterDef);
                monsterHp -= playerDmg;
                battleLog.push({ round, side: 'player', damage: playerDmg.toString(), monster_hp: monsterHp < 0n ? '0' : monsterHp.toString() });
                if (monsterHp <= 0n) {
                    // 玩家胜利
                    const rewards = node.rewards || {};
                    const expGained = BigInt(Math.floor((rewards.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')));
                    const stonesGained = BigInt(Math.floor((rewards.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones')));
                    const itemsGained = rewards.items || [];

                    progress.hp_remaining = currentHp.toString();
                    progress.exp_accumulated = (safeBigInt(progress.exp_accumulated) + expGained).toString();
                    progress.spirit_stones_accumulated = (safeBigInt(progress.spirit_stones_accumulated) + stonesGained).toString();
                    const collected = progress.items_collected || [];
                    for (const item of itemsGained) collected.push({ ...item, source: node.type === 'boss' ? 'boss_drop' : 'battle_drop' });
                    progress.items_collected = collected;
                    progress.last_active_time = new Date();

                    // 推进到下一节点
                    const nextNode = node.next_node ? getNodeById(chapter, node.next_node) : null;
                    const nodesCompleted = [...(progress.nodes_completed || []), node.id];
                    progress.nodes_completed = nodesCompleted;

                    // boss 节点若无下一节点，则结算成功
                    if (!nextNode || node.is_final_node) {
                        await progress.save({ transaction: t });
                        await t.commit();
                        const settleResult = await this._settleDungeon(player, true, node.victory_text || 'BOSS战胜利，章节通关');
                        return {
                            success: true,
                            message: node.victory_text || '战斗胜利',
                            data: {
                                battle_result: 'victory',
                                battle_log: battleLog,
                                final_player_hp: currentHp.toString(),
                                final_monster_hp: '0',
                                rewards: {
                                    exp: expGained.toString(),
                                    spirit_stones: stonesGained.toString(),
                                    items: itemsGained
                                },
                                victory_text: node.victory_text,
                                settlement: settleResult.data
                            }
                        };
                    }

                    progress.current_node_id = nextNode.id;
                    progress.current_node_type = nextNode.type;
                    await progress.save({ transaction: t });
                    lockedPlayer.dungeon_node_id = nextNode.id;
                    await lockedPlayer.save({ transaction: t });
                    await t.commit();

                    const nodeContent = await this._renderNodeContent(progress, chapter, nextNode, lockedPlayer);
                    return {
                        success: true,
                        message: '战斗胜利',
                        data: {
                            battle_result: 'victory',
                            battle_log: battleLog,
                            final_player_hp: currentHp.toString(),
                            final_monster_hp: '0',
                            rewards: {
                                exp: expGained.toString(),
                                spirit_stones: stonesGained.toString(),
                                items: itemsGained
                            },
                            current_node: nodeContent
                        }
                    };
                }

                // 怪物攻击玩家
                const monsterDmg = this._calculateDamage(monsterAtk, playerDef);
                currentHp -= monsterDmg;
                battleLog.push({ round, side: 'monster', damage: monsterDmg.toString(), player_hp: currentHp < 0n ? '0' : currentHp.toString() });
                if (currentHp <= 0n) {
                    // 玩家失败
                    progress.hp_remaining = '0';
                    progress.last_active_time = new Date();
                    await progress.save({ transaction: t });
                    await t.commit();
                    const settleResult = await this._settleDungeon(player, false, `被${monster.name}击败`);
                    return {
                        success: true,
                        message: '战斗失败',
                        data: {
                            battle_result: 'defeat',
                            battle_log: battleLog,
                            final_player_hp: '0',
                            final_monster_hp: monsterHp.toString(),
                            defeat_text: `你被${monster.name}击败，副本挑战失败`,
                            settlement: settleResult.data
                        }
                    };
                }
            }

            // 超过最大回合数，按平局处理（玩家失败）
            await t.commit();
            return {
                success: false,
                message: '战斗超过最大回合数，判定为失败',
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService.battleNode] 错误:', err);
            return { success: false, message: '服务器错误', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 中断副本（玩家主动放弃，按失败结算，但不扣修为）
     * @param {Object} player - 玩家对象
     * @returns {Object}
     */
    async interruptDungeon(player) {
        if (!player.in_dungeon) {
            return { success: false, message: '当前未在副本中', error_code: 'BUSINESS_LOGIC_ERROR' };
        }
        return await this._settleDungeon(player, false, '玩家主动中断', true);
    }

    /**
     * 扫荡已三星通关的副本
     * @param {Object} player - 玩家对象
     * @param {string} chapterId - 章节ID
     * @param {string} difficulty - 难度
     * @returns {Object}
     */
    async sweepDungeon(player, chapterId, difficulty) {
        const cfg = getDungeonConfig();
        const chapter = getChapterById(chapterId);
        if (!chapter) {
            return { success: false, message: '副本章节不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        // 检查是否已三星通关
        const record = await DungeonRecord.findOne({
            where: { player_id: player.id, chapter_id: chapterId, difficulty }
        });
        if (!record || record.stars < cfg.global.sweep_min_stars) {
            return {
                success: false,
                message: `需${cfg.global.sweep_min_stars}星通关后才能扫荡`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 跨日重置 + 次数校验
        resetDailyCountIfCrossDay(player, 'last_dungeon_date', 'daily_dungeon_count');
        if (player.daily_dungeon_count >= cfg.global.daily_challenge_limit) {
            return {
                success: false,
                message: `今日挑战次数已用完（${cfg.global.daily_challenge_limit}次/天）`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 冷却校验
        const cooldown = checkCooldown(player, 'last_dungeon_time', cfg.global.cooldown_seconds);
        if (!cooldown.ready) {
            return {
                success: false,
                message: `副本冷却中，剩余 ${cooldown.remainingSec} 秒`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });

            // 计算扫荡奖励（按比例发放）
            const ratio = cfg.global.sweep_reward_ratio;
            const expReward = BigInt(Math.floor(Number(record.exp_gained) * ratio));
            const stonesReward = BigInt(Math.floor(Number(record.spirit_stones_gained) * ratio));

            // 发放修为与灵石
            lockedPlayer.exp = (safeBigInt(lockedPlayer.exp) + expReward).toString();
            lockedPlayer.spirit_stones = (safeBigInt(lockedPlayer.spirit_stones) + stonesReward).toString();
            lockedPlayer.daily_dungeon_count = (lockedPlayer.daily_dungeon_count || 0) + 1;
            lockedPlayer.last_dungeon_time = new Date();
            if (!lockedPlayer.last_dungeon_date) {
                lockedPlayer.last_dungeon_date = new Date().toISOString().slice(0, 10);
            }
            await lockedPlayer.save({ transaction: t });

            // 发放物品（按比例）
            const originalItems = record.items_gained || [];
            const itemsToGive = [];
            for (const item of originalItems) {
                const qty = Math.max(1, Math.floor((item.quantity || 1) * ratio));
                itemsToGive.push({ item_key: item.item_key, quantity: qty });
            }

            // 通过 InventoryService 发放物品
            const InventoryService = require('./InventoryService');
            for (const item of itemsToGive) {
                try {
                    await InventoryService.addItem(lockedPlayer.id, item.item_key, item.quantity, t);
                } catch (e) {
                    console.warn(`[DungeonService.sweepDungeon] 发放物品 ${item.item_key} 失败:`, e.message);
                }
            }

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: 'dungeon_sweep',
                chapter_id: chapterId,
                chapter_name: chapter.name,
                rewards: { exp: expReward.toString(), spirit_stones: stonesReward.toString(), items: itemsToGive }
            });

            return {
                success: true,
                message: `扫荡成功：${chapter.name}（${this._difficultyDisplayName(difficulty)}）`,
                data: {
                    chapter_id: chapterId,
                    chapter_name: chapter.name,
                    difficulty,
                    rewards: {
                        exp: expReward.toString(),
                        spirit_stones: stonesReward.toString(),
                        items: itemsToGive
                    },
                    daily_challenge_count: lockedPlayer.daily_dungeon_count,
                    daily_challenge_limit: cfg.global.daily_challenge_limit
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService.sweepDungeon] 错误:', err);
            return { success: false, message: '服务器错误', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 获取通关历史记录
     * @param {Object} player - 玩家对象
     * @param {number} limit - 返回条数
     * @returns {Object}
     */
    async getHistory(player, limit = 20) {
        const records = await DungeonRecord.findAll({
            where: { player_id: player.id },
            order: [['completed_at', 'DESC']],
            limit: Math.min(50, Math.max(1, limit))
        });
        return {
            success: true,
            data: records.map(r => ({
                id: r.id,
                chapter_id: r.chapter_id,
                chapter_name: r.chapter_name,
                difficulty: r.difficulty,
                stars: r.stars,
                completion_time_sec: r.completion_time_sec,
                exp_gained: r.exp_gained?.toString(),
                spirit_stones_gained: r.spirit_stones_gained?.toString(),
                items_gained: r.items_gained || [],
                completed_at: r.completed_at
            }))
        };
    }

    /**
     * 清理过期副本（StateCleanerService 调用）
     * @param {Object} ctx - 上下文
     * @returns {Object} { scanned, settled, failed }
     */
    async cleanExpiredDungeon(ctx = {}) {
        const stats = { scanned: 0, settled: 0, failed: 0 };
        const now = new Date();
        const expiredList = await DungeonProgress.findAll({
            where: { expires_at: { [Op.lte]: now } }
        });
        stats.scanned = expiredList.length;

        for (const progress of expiredList) {
            try {
                const player = await Player.findByPk(progress.player_id);
                if (player) {
                    await this._settleDungeon(player, false, '副本超时自动结算', false, true);
                } else {
                    // 玩家不存在，直接删除进度
                    await progress.destroy();
                }
                stats.settled++;
            } catch (err) {
                console.error('[DungeonService.cleanExpiredDungeon] 结算失败:', err.message);
                stats.failed++;
            }
        }
        return stats;
    }

    // ============================================================
    // 内部方法
    // ============================================================

    /**
     * 计算伤害（简化版，含随机浮动）
     * @param {bigint} atk
     * @param {bigint} def
     * @returns {bigint}
     */
    _calculateDamage(atk, def) {
        if (atk <= def) {
            // 攻击力不大于防御，造成最小伤害（1-5）
            return BigInt(1 + Math.floor(Math.random() * 5));
        }
        const baseDmg = atk - def;
        // 随机浮动 80%-120%
        const float = 0.8 + Math.random() * 0.4;
        const dmg = BigInt(Math.floor(Number(baseDmg) * float));
        return dmg < 1n ? 1n : dmg;
    }

    /**
     * 渲染节点内容（含 AI 剧情增强）
     * @param {Object} progress - 进度
     * @param {Object} chapter - 章节
     * @param {Object} node - 节点
     * @param {Object} player - 玩家
     * @returns {Object}
     */
    async _renderNodeContent(progress, chapter, node, player) {
        const result = {
            id: node.id,
            type: node.type,
            title: node.title,
            chapter_name: chapter.name,
            difficulty: progress.difficulty,
            is_final_node: !!node.is_final_node
        };

        if (node.type === 'story') {
            // 尝试 AI 生成剧情，失败则使用静态 narrative
            let narrative = node.narrative || '';
            let aiGenerated = false;
            if (node.ai_prompt) {
                try {
                    const aiService = await AIService.reloadFromDatabase();
                    if (aiService) {
                        const aiResult = await aiService.callAPI(node.ai_prompt, {
                            context: {
                                chapter_name: chapter.name,
                                node_title: node.title,
                                player_realm: player.realm,
                                difficulty: progress.difficulty
                            }
                        });
                        if (aiResult.content) {
                            narrative = aiResult.content;
                            aiGenerated = true;
                        }
                    }
                } catch (e) {
                    console.warn('[DungeonService._renderNodeContent] AI 剧情生成失败，使用静态文本:', e.message);
                }
            }
            result.narrative = narrative;
            result.ai_generated = aiGenerated;
            result.next_node_id = node.next_node || null;
        } else if (node.type === 'battle') {
            result.description = node.description || '';
            result.monster = {
                name: node.monster?.name,
                hp: Math.floor(node.monster?.hp * getDifficultyMultiplier(progress.difficulty, 'hp')),
                attack: Math.floor(node.monster?.attack * getDifficultyMultiplier(progress.difficulty, 'atk')),
                defense: node.monster?.defense || 0
            };
            result.rewards = {
                exp: Math.floor((node.rewards?.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')),
                spirit_stones: Math.floor((node.rewards?.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones'))
            };
        } else if (node.type === 'puzzle') {
            result.narrative = node.narrative || '';
            result.options = (node.options || []).map(o => ({
                id: o.id,
                text: o.text,
                hint: o.hp_cost_ratio ? `损失 ${Math.floor(o.hp_cost_ratio * 100)}% HP` :
                      o.hp_recover_ratio ? `恢复 ${Math.floor(o.hp_recover_ratio * 100)}% HP` :
                      o.mp_cost_ratio ? `损耗 ${Math.floor(o.mp_cost_ratio * 100)}% MP` : '影响未知'
            }));
        } else if (node.type === 'reward') {
            result.narrative = node.narrative || '';
            result.rewards = {
                exp: Math.floor((node.rewards?.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')),
                spirit_stones: Math.floor((node.rewards?.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones')),
                items: node.rewards?.items || []
            };
            result.next_node_id = node.next_node || null;
        } else if (node.type === 'boss') {
            const monster = node.monster_ref === 'boss' ? chapter.boss : node.monster;
            result.description = node.description || '';
            result.monster = {
                name: monster?.name,
                description: monster?.description,
                hp: Math.floor(monster?.hp * getDifficultyMultiplier(progress.difficulty, 'hp')),
                attack: Math.floor(monster?.attack * getDifficultyMultiplier(progress.difficulty, 'atk')),
                defense: monster?.defense || 0,
                skills: monster?.skills || []
            };
            result.rewards = {
                exp: Math.floor((node.rewards?.exp || 0) * getDifficultyMultiplier(progress.difficulty, 'exp')),
                spirit_stones: Math.floor((node.rewards?.spirit_stones || 0) * getDifficultyMultiplier(progress.difficulty, 'spirit_stones')),
                items: node.rewards?.items || []
            };
            result.victory_text = node.victory_text || '';
            result.is_final_node = !!node.is_final_node;
        }

        return result;
    }

    /**
     * 结算副本（成功/失败/超时/中断）
     * @param {Object} player - 玩家对象
     * @param {boolean} success - 是否通关
     * @param {string} reason - 结算原因
     * @param {boolean} isInterrupt - 是否主动中断
     * @param {boolean} isExpired - 是否超时
     * @returns {Object}
     */
    async _settleDungeon(player, success, reason, isInterrupt = false, isExpired = false) {
        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });
            const progress = await DungeonProgress.findOne({
                where: { player_id: player.id },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!progress) {
                await t.commit();
                return { success: false, message: '副本进度不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const chapter = getChapterById(progress.chapter_id);
            const cfg = getDungeonConfig();
            const now = new Date();
            const completionSec = Math.floor((now - new Date(progress.start_time)) / 1000);

            // 计算星级（仅成功时）
            let stars = 0;
            if (success) {
                // 修复 B14：通过 AttributeService 计算 max HP，避免 safeBigInt(undefined)=0n
                const settleBattleAttr = computePlayerBattleAttributes(lockedPlayer);
                const playerHpMax = settleBattleAttr.hp_max;
                const hpRemaining = safeBigInt(progress.hp_remaining);
                const hpRatio = playerHpMax > 0n ? Number(hpRemaining) / Number(playerHpMax) : 0;
                if (hpRatio >= cfg.global.star_thresholds.three_star_hp_ratio) stars = 3;
                else if (hpRatio >= cfg.global.star_thresholds.two_star_hp_ratio) stars = 2;
                else if (hpRatio >= cfg.global.star_thresholds.one_star_hp_ratio) stars = 1;
                else stars = 1; // 至少1星
            }

            // 发放奖励（成功：全额；中断/失败/超时：仅发放已积累的部分修为，不发放物品）
            let expGained = 0n;
            let stonesGained = 0n;
            let itemsGained = [];

            if (success) {
                expGained = safeBigInt(progress.exp_accumulated);
                stonesGained = safeBigInt(progress.spirit_stones_accumulated);
                itemsGained = progress.items_collected || [];

                lockedPlayer.exp = (safeBigInt(lockedPlayer.exp) + expGained).toString();
                lockedPlayer.spirit_stones = (safeBigInt(lockedPlayer.spirit_stones) + stonesGained).toString();

                // 通过 InventoryService 发放物品
                const InventoryService = require('./InventoryService');
                for (const item of itemsGained) {
                    if (item.item_key) {
                        try {
                            await InventoryService.addItem(lockedPlayer.id, item.item_key, item.quantity || 1, t);
                        } catch (e) {
                            console.warn(`[DungeonService._settleDungeon] 发放物品 ${item.item_key} 失败:`, e.message);
                        }
                    }
                }
            } else if (isInterrupt) {
                // 主动中断：发放50%积累修为，不发放物品和灵石
                expGained = safeBigInt(progress.exp_accumulated) / 2n;
                lockedPlayer.exp = (safeBigInt(lockedPlayer.exp) + expGained).toString();
            }
            // 失败/超时：无奖励

            // 更新玩家副本状态
            lockedPlayer.in_dungeon = false;
            lockedPlayer.dungeon_chapter_id = null;
            lockedPlayer.dungeon_node_id = null;
            lockedPlayer.dungeon_difficulty = null;
            lockedPlayer.dungeon_start_time = null;
            lockedPlayer.last_dungeon_time = now;
            if (!lockedPlayer.last_dungeon_date) {
                lockedPlayer.last_dungeon_date = now.toISOString().slice(0, 10);
            }
            await lockedPlayer.save({ transaction: t });

            // 成功通关：写入/更新通关记录
            let recordUpdated = false;
            if (success) {
                const existing = await DungeonRecord.findOne({
                    where: { player_id: player.id, chapter_id: progress.chapter_id, difficulty: progress.difficulty },
                    transaction: t
                });
                if (existing) {
                    // 取最高星级
                    if (stars > existing.stars) {
                        existing.stars = stars;
                        existing.completion_time_sec = completionSec;
                        existing.exp_gained = expGained.toString();
                        existing.spirit_stones_gained = stonesGained.toString();
                        existing.items_gained = itemsGained;
                        existing.completed_at = now;
                        await existing.save({ transaction: t });
                    }
                    recordUpdated = true;
                } else {
                    await DungeonRecord.create({
                        player_id: player.id,
                        chapter_id: progress.chapter_id,
                        chapter_name: chapter?.name || progress.chapter_id,
                        difficulty: progress.difficulty,
                        stars,
                        completion_time_sec: completionSec,
                        exp_gained: expGained.toString(),
                        spirit_stones_gained: stonesGained.toString(),
                        items_gained: itemsGained,
                        ai_narrative: progress.ai_context,
                        completed_at: now
                    }, { transaction: t });
                    recordUpdated = true;
                }
            }

            // 删除进度记录
            await progress.destroy({ transaction: t });

            await t.commit();

            // 大五行幻世轮：副本结算后自动积累悟印（未装备时静默返回）
            // 中断/超时按失败处理，通关按成功处理
            await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                battle_type: 'dungeon',
                is_win: success
            });

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: success ? 'dungeon_complete' : (isInterrupt ? 'dungeon_interrupt' : 'dungeon_failed'),
                chapter_id: progress.chapter_id,
                chapter_name: chapter?.name,
                difficulty: progress.difficulty,
                success,
                stars,
                rewards: {
                    exp: expGained.toString(),
                    spirit_stones: stonesGained.toString(),
                    items: itemsGained
                }
            });

            return {
                success: true,
                message: success ? `副本通关！获得 ${stars} 星` : (isInterrupt ? '副本已中断' : '副本挑战失败'),
                data: {
                    settle_reason: reason,
                    chapter_id: progress.chapter_id,
                    chapter_name: chapter?.name,
                    difficulty: progress.difficulty,
                    is_success: success,
                    is_interrupt: isInterrupt,
                    is_expired: isExpired,
                    stars,
                    completion_time_sec: completionSec,
                    rewards: {
                        exp: expGained.toString(),
                        spirit_stones: stonesGained.toString(),
                        items: itemsGained
                    },
                    record_updated: recordUpdated,
                    player_exp: lockedPlayer.exp?.toString(),
                    player_spirit_stones: lockedPlayer.spirit_stones?.toString()
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[DungeonService._settleDungeon] 错误:', err);
            return { success: false, message: '结算失败：服务器错误', error_code: 'INTERNAL_ERROR' };
        }
    }

    /**
     * 难度显示名
     * @param {string} difficulty
     * @returns {string}
     */
    _difficultyDisplayName(difficulty) {
        return { normal: '普通', hard: '困难', nightmare: '噩梦' }[difficulty] || difficulty;
    }

    /**
     * 节点类型显示名
     * @param {string} type
     * @returns {string}
     */
    _nodeTypeDisplayName(type) {
        return { story: '剧情', battle: '战斗', puzzle: '解谜', boss: 'BOSS', reward: '奖励' }[type] || type;
    }
}

module.exports = new DungeonService();
