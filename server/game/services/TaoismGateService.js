/**
 * 太一门引道服务
 *
 * 实现玩法文档第25节"太一门引道"——五行道途+神识联动+多人共鸣
 *   - 5 种道途（金/木/水/火/土），每种提供独特被动加成和主动技能
 *   - 通过日常修炼/使用技能/共鸣组队获得道途经验，提升等级（1-10级）
 *   - 等级达到5级后可使用道途专属技能（消耗神识）
 *   - 五行相克：金克木/木克土/土克水/水克火/火克金，相克时技能成功率+20%
 *   - 道途共鸣：同道途玩家2人组队+10%/3人+20%/4人+30%/5人+50%（封顶）
 *   - 道途切换：每月1次免费，之后消耗100五行法则碎片，7天冷却
 *
 * 5种道途技能设计：
 *   1. 金道·金锋裂魂：消耗200神识攻击目标灵兽，造成HP损失
 *   2. 木道·木灵回春：消耗150神识恢复自己灵兽HP
 *   3. 水道·水镜映心：消耗100神识设置反弹盾，反弹下次探查
 *   4. 火道·火眼金睛：消耗180神识探查目标储物袋
 *   5. 土道·土牢定身：消耗250神识定身目标灵兽2小时
 *
 * 单例导出：module.exports = new TaoismGateService()
 */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerTaoismGate = require('../../models/playerTaoismGate');
const PlayerDivineSense = require('../../models/playerDivineSense');
const PlayerLaw = require('../../models/playerLaw');
const SpiritBeast = require('../../models/spiritBeast');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class TaoismGateService {
    constructor() {
        this.config = null;
        this.initialized = false;
    }

    /**
     * 初始化服务
     * @param {object} configLoader - ConfigLoader 实例
     */
    initialize(configLoader) {
        this.config = configLoader.getConfig('taoism_gate_data');
        if (!this.config) {
            throw new Error('太一门引道配置未加载，请检查 taoism_gate_data.json');
        }
        this.initialized = true;
        console.log('[TaoismGateService] 太一门引道服务初始化完成');
    }

    // ==================== 玩家接口 ====================

    /**
     * 获取道途面板（含道途/等级/经验/技能/任务/共鸣信息）
     * @param {object} player - 玩家对象（来自 auth 中间件）
     * @returns {object} 道途面板数据
     */
    async getProfile(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        await this._checkDailyReset(gate);

        const pathConfig = gate.dao_path ? this.config.dao_paths[gate.dao_path] : null;
        const levelConfig = this.config.level_table[String(gate.dao_level)] || this.config.level_table['1'];

        // 计算下一级所需经验
        const nextLevel = gate.dao_level < this.config.taoism_gate.max_dao_level
            ? (this.config.level_table[String(gate.dao_level + 1)]?.exp_required || null)
            : null;

        // 获取神识信息
        const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id } });
        const divineSenseCurrent = divineSense?.divine_sense_current || 0;
        const divineSenseMax = divineSense?.divine_sense_max || 100;

        // 查询同道途在线玩家数（用于共鸣展示）
        const samePathCount = await PlayerTaoismGate.count({
            where: { dao_path: gate.dao_path, dao_level: { [Op.gte]: 1 } }
        });

        // 计算技能冷却状态
        const skills = pathConfig ? [{
            skill_id: pathConfig.skill_id,
            skill_name: pathConfig.skill_name,
            skill_description: pathConfig.skill_description,
            skill_divine_sense_cost: pathConfig.skill_divine_sense_cost,
            skill_cooldown_hours: pathConfig.skill_cooldown_hours,
            skill_min_level: pathConfig.skill_min_level,
            can_use: gate.dao_level >= pathConfig.skill_min_level && divineSenseCurrent >= pathConfig.skill_divine_sense_cost,
            cooldown_end: gate.skill_cooldowns?.[pathConfig.skill_id] || null,
            is_locked: gate.dao_level < pathConfig.skill_min_level
        }] : [];

        return {
            data: {
                gate: {
                    dao_path: gate.dao_path,
                    dao_path_name: pathConfig?.name || '未选择道途',
                    dao_path_description: pathConfig?.description || '请选择五行道途之一',
                    dao_path_color: pathConfig?.color || '#999999',
                    dao_level: gate.dao_level,
                    dao_level_title: levelConfig.title,
                    dao_exp: gate.dao_exp,
                    next_level_exp: nextLevel,
                    passive_bonus: pathConfig ? {
                        type: pathConfig.passive_bonus_type,
                        value: levelConfig.bonus_value,
                        description: pathConfig.passive_bonus_desc
                    } : null
                },
                divine_sense: {
                    current: divineSenseCurrent,
                    max: divineSenseMax
                },
                skills: skills,
                daily_tasks: gate.daily_tasks || [],
                resonance: {
                    same_path_player_count: samePathCount,
                    resonance_bonus: this._calculateResonanceBonus(samePathCount),
                    restraint_targets: pathConfig?.restraint_targets || []
                },
                stats: {
                    total_cultivate_count: gate.total_cultivate_count,
                    total_skill_use_count: gate.total_skill_use_count,
                    total_resonance_count: gate.total_resonance_count
                }
            }
        };
    }

    /**
     * 选择道途（首次选择，免费）
     * @param {object} player - 玩家对象
     * @param {string} pathKey - 道途key（metal/wood/water/fire/earth）
     * @returns {object} 选择结果
     */
    async choosePath(player, pathKey) {
        if (!this.initialized) throw new Error('服务未初始化');

        // 校验道途key
        if (!this.config.dao_paths[pathKey]) {
            throw new AppError('无效的道途，可选：metal（金）/wood（木）/water（水）/fire（火）/earth（土）', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验境界
        if (player.realm_rank < this.config.taoism_gate.min_realm_rank) {
            throw new AppError(`需达到境界rank ${this.config.taoism_gate.min_realm_rank}（元婴期）才能选择道途`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const gate = await this._getOrCreateGate(player.id);

        // 校验是否已选择道途
        if (gate.dao_path) {
            throw new AppError(`已选择道途 ${this.config.dao_paths[gate.dao_path].name}，请使用切换接口`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验神识
        const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id } });
        const currentDivineSense = divineSense?.divine_sense_current || 0;
        if (currentDivineSense < this.config.taoism_gate.min_divine_sense_to_choose) {
            throw new AppError(`神识不足，需 ${this.config.taoism_gate.min_divine_sense_to_choose} 神识才能引道，当前 ${currentDivineSense}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 事务更新
        const t = await sequelize.transaction();
        try {
            gate.dao_path = pathKey;
            gate.dao_level = 1;
            gate.dao_exp = 0;
            gate.last_switch_time = new Date();
            // 首次选择道途时立即生成今日任务（避免 _checkDailyReset 已设置 resetTime 导致任务为空）
            gate.daily_tasks = this._generateDailyTasks();
            gate.daily_task_reset_time = new Date();
            await gate.save({ transaction: t });

            await t.commit();
            const pathConfig = this.config.dao_paths[pathKey];
            return {
                message: `引道成功！已选择 ${pathConfig.name}`,
                data: {
                    dao_path: pathKey,
                    dao_path_name: pathConfig.name,
                    dao_level: 1,
                    passive_bonus: pathConfig.passive_bonus_desc
                }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 切换道途（每月1次免费，之后消耗法则碎片，7天冷却）
     * @param {object} player - 玩家对象
     * @param {string} newPathKey - 新道途key
     * @returns {object} 切换结果
     */
    async switchPath(player, newPathKey) {
        if (!this.initialized) throw new Error('服务未初始化');

        if (!this.config.dao_paths[newPathKey]) {
            throw new AppError('无效的道途，可选：metal/wood/water/fire/earth', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，请使用 choose 接口首次选择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (gate.dao_path === newPathKey) {
            throw new AppError('当前已是该道途，无需切换', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验切换冷却（7天）
        if (gate.last_switch_time) {
            const cooldownHours = this.config.taoism_gate.switch_cooldown_hours;
            const elapsed = (Date.now() - new Date(gate.last_switch_time).getTime()) / (1000 * 60 * 60);
            if (elapsed < cooldownHours) {
                const remaining = Math.ceil(cooldownHours - elapsed);
                throw new AppError(`道途切换冷却中，还需 ${remaining} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
        }

        // 计算切换费用：每月1次免费，之后消耗法则碎片
        const needFragment = !this._isFreeSwitchThisMonth(gate);

        const t = await sequelize.transaction();
        try {
            // 扣除法则碎片（如需）
            if (needFragment) {
                const law = await PlayerLaw.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
                if (!law) {
                    throw new AppError('法则数据未初始化', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                const fragmentField = `law_fragments_${this.config.taoism_gate.switch_fragment_type}`;
                const currentFragment = law[fragmentField] || 0;
                const cost = this.config.taoism_gate.switch_fragment_cost;
                if (currentFragment < cost) {
                    throw new AppError(`法则碎片不足，需 ${cost} 五行法则碎片，当前 ${currentFragment}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                law[fragmentField] = currentFragment - cost;
                await law.save({ transaction: t });
            }

            // 切换道途（保留等级和经验的50%，按文档"切换后保留已有道途经验但重置当前道途等级"）
            const oldLevel = gate.dao_level;
            const oldExp = gate.dao_exp;
            gate.dao_path = newPathKey;
            gate.dao_level = 1; // 重置等级
            gate.dao_exp = Math.floor(oldExp * 0.5); // 保留50%经验
            gate.last_switch_time = new Date();
            // 切换道途后重新生成今日任务（新道途新任务）
            gate.daily_tasks = this._generateDailyTasks();
            gate.daily_task_reset_time = new Date();
            await gate.save({ transaction: t });

            await t.commit();
            const pathConfig = this.config.dao_paths[newPathKey];
            return {
                message: `道途切换成功！已切换至 ${pathConfig.name}（等级重置为1，保留50%经验）`,
                data: {
                    dao_path: newPathKey,
                    dao_path_name: pathConfig.name,
                    dao_level: 1,
                    dao_exp: gate.dao_exp,
                    fragment_consumed: needFragment ? this.config.taoism_gate.switch_fragment_cost : 0
                }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 引道修炼（消耗神识获得道途经验）
     * @param {object} player - 玩家对象
     * @returns {object} 修炼结果
     */
    async cultivate(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无法修炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (gate.dao_level >= this.config.taoism_gate.max_dao_level) {
            throw new AppError('道途已满级，无需继续修炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        await this._checkDailyReset(gate);

        // 校验每日修炼次数（使用专门的 daily_cultivate_count 字段，避免与日常任务进度混淆）
        // 跨日重置：如果 last_cultivate_date 不是今天，重置 daily_cultivate_count
        const today = new Date();
        const todayDateStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
        if (gate.last_cultivate_date !== todayDateStr) {
            gate.daily_cultivate_count = 0;
            gate.last_cultivate_date = todayDateStr;
        }
        if (gate.daily_cultivate_count >= this.config.taoism_gate.daily_cultivate_limit) {
            throw new AppError(`今日修炼次数已达上限（${this.config.taoism_gate.daily_cultivate_limit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const divineSenseCost = this.config.taoism_gate.cultivate_divine_sense_cost;
        const t = await sequelize.transaction();
        try {
            // 扣除神识
            const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
            if (!divineSense || divineSense.divine_sense_current < divineSenseCost) {
                throw new AppError(`神识不足，修炼需 ${divineSenseCost} 神识，当前 ${divineSense?.divine_sense_current || 0}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            divineSense.divine_sense_current -= divineSenseCost;
            divineSense.total_consumed += divineSenseCost;
            await divineSense.save({ transaction: t });

            // 计算获得经验（基础 + 神识加成）
            const baseExp = this.config.taoism_gate.cultivate_exp_base;
            const divineBonus = Math.floor(divineSense.divine_sense_max * this.config.taoism_gate.cultivate_exp_divine_sense_bonus_ratio);
            const expGained = baseExp + divineBonus;

            // 更新道途经验
            gate.dao_exp += expGained;
            gate.total_cultivate_count += 1;
            gate.daily_cultivate_count += 1; // 累加当日修炼次数（用于每日上限校验）

            // 检查升级
            const levelUpResult = this._checkLevelUp(gate);
            await gate.save({ transaction: t });

            // 更新日常任务进度
            this._updateTaskProgress(gate, 'cultivate', 1);

            await gate.save({ transaction: t });
            await t.commit();

            return {
                message: levelUpResult.leveledUp ? `修炼成功，道途升级至 ${levelUpResult.newLevel} 级！` : '修炼成功，获得道途经验',
                data: {
                    exp_gained: expGained,
                    dao_exp: gate.dao_exp,
                    dao_level: gate.dao_level,
                    leveled_up: levelUpResult.leveledUp,
                    new_level: levelUpResult.newLevel,
                    divine_sense_left: divineSense.divine_sense_current
                }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 使用道途技能
     * @param {object} player - 玩家对象
     * @param {number} targetPlayerId - 目标玩家ID（攻击/探查/定身类技能需要，恢复类技能传null）
     * @param {number} targetBeastId - 目标灵兽ID（攻击/定身类技能需要）
     * @returns {object} 技能使用结果
     */
    async useSkill(player, targetPlayerId = null, targetBeastId = null) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无法使用技能', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const pathConfig = this.config.dao_paths[gate.dao_path];
        const skillId = pathConfig.skill_id;

        // 校验等级
        if (gate.dao_level < pathConfig.skill_min_level) {
            throw new AppError(`道途等级不足，需 ${pathConfig.skill_min_level} 级才能使用技能 ${pathConfig.skill_name}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验冷却
        const cooldownEnd = gate.skill_cooldowns?.[skillId];
        if (cooldownEnd && new Date(cooldownEnd) > new Date()) {
            const remaining = Math.ceil((new Date(cooldownEnd) - new Date()) / (1000 * 60 * 60));
            throw new AppError(`技能冷却中，还需 ${remaining} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验神识
        const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id } });
        if (!divineSense || divineSense.divine_sense_current < pathConfig.skill_divine_sense_cost) {
            throw new AppError(`神识不足，使用 ${pathConfig.skill_name} 需 ${pathConfig.skill_divine_sense_cost} 神识`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 执行技能效果
        const t = await sequelize.transaction();
        try {
            let skillResult;
            switch (skillId) {
                case 'metal_blade':
                    skillResult = await this._executeMetalBlade(player, gate, targetPlayerId, targetBeastId, t);
                    break;
                case 'wood_heal':
                    skillResult = await this._executeWoodHeal(player, gate, targetBeastId, t);
                    break;
                case 'water_mirror':
                    skillResult = await this._executeWaterMirror(player, gate, t);
                    break;
                case 'fire_eye':
                    skillResult = await this._executeFireEye(player, gate, targetPlayerId, t);
                    break;
                case 'earth_prison':
                    skillResult = await this._executeEarthPrison(player, gate, targetPlayerId, targetBeastId, t);
                    break;
                default:
                    throw new AppError('未知技能', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除神识
            divineSense.divine_sense_current -= pathConfig.skill_divine_sense_cost;
            divineSense.total_consumed += pathConfig.skill_divine_sense_cost;
            await divineSense.save({ transaction: t });

            // 设置冷却
            const cooldownHours = pathConfig.skill_cooldown_hours;
            const cooldownEndTime = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
            const newCooldowns = { ...(gate.skill_cooldowns || {}), [skillId]: cooldownEndTime };
            gate.skill_cooldowns = newCooldowns;
            gate.total_skill_use_count += 1;

            // 获得道途经验
            const skillExp = 50;
            gate.dao_exp += skillExp;
            this._checkLevelUp(gate);

            // 更新日常任务进度
            this._updateTaskProgress(gate, 'use_skill', 1);

            await gate.save({ transaction: t });
            await t.commit();

            return {
                message: `技能 ${pathConfig.skill_name} 使用成功`,
                data: {
                    skill_id: skillId,
                    skill_name: pathConfig.skill_name,
                    skill_result: skillResult,
                    exp_gained: skillExp,
                    divine_sense_left: divineSense.divine_sense_current,
                    cooldown_end: cooldownEndTime
                }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 获取今日任务
     * @param {object} player - 玩家对象
     * @returns {object} 今日任务列表
     */
    async getDailyTasks(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        await this._checkDailyReset(gate);

        // 如果未选择道途，返回空列表
        if (!gate.dao_path) {
            return { data: { tasks: [], message: '尚未选择道途，无日常任务' } };
        }

        return {
            data: {
                tasks: gate.daily_tasks || [],
                reset_time: gate.daily_task_reset_time
            }
        };
    }

    /**
     * 领取任务奖励
     * @param {object} player - 玩家对象
     * @param {number} taskIndex - 任务索引（0-based）
     * @returns {object} 领取结果
     */
    async claimTaskReward(player, taskIndex) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无任务奖励', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        await this._checkDailyReset(gate);

        const tasks = gate.daily_tasks || [];
        if (taskIndex < 0 || taskIndex >= tasks.length) {
            throw new AppError('任务索引无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const task = tasks[taskIndex];
        if (!task.completed) {
            throw new AppError('任务尚未完成', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (task.rewards_claimed) {
            throw new AppError('任务奖励已领取', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 发放奖励
            const rewards = task.rewards || {};
            const divineSenseGain = rewards.divine_sense || 0;
            const lawFragmentGain = rewards.law_fragment_five_elements || 0;
            const daoExpGain = rewards.dao_exp || 0;

            // 神识奖励
            if (divineSenseGain > 0) {
                const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
                if (divineSense) {
                    divineSense.divine_sense_current = Math.min(divineSense.divine_sense_max, divineSense.divine_sense_current + divineSenseGain);
                    divineSense.total_quenched += divineSenseGain;
                    await divineSense.save({ transaction: t });
                }
            }

            // 法则碎片奖励
            if (lawFragmentGain > 0) {
                const law = await PlayerLaw.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
                if (law) {
                    law.law_fragments_five_elements = (law.law_fragments_five_elements || 0) + lawFragmentGain;
                    await law.save({ transaction: t });
                }
            }

            // 道途经验奖励
            if (daoExpGain > 0) {
                gate.dao_exp += daoExpGain;
                this._checkLevelUp(gate);
            }

            // 标记已领取（深拷贝避免 Sequelize JSON 字段引用相同导致变更未被检测）
            const newTasks = JSON.parse(JSON.stringify(tasks));
            newTasks[taskIndex].rewards_claimed = true;
            gate.daily_tasks = newTasks;
            gate.changed('daily_tasks', true);
            await gate.save({ transaction: t });

            await t.commit();
            return {
                message: '任务奖励领取成功',
                data: {
                    task_name: task.task_name,
                    rewards: rewards
                }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 获取道途排行榜（按道途等级/技能使用次数/共鸣次数）
     * @param {string} category - 排行类别（dao_level/total_skill_use/total_resonance）
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} 排行榜
     */
    async getRanking(category = 'dao_level', page = 1, pageSize = 20) {
        if (!this.initialized) throw new Error('服务未初始化');

        const validCategories = ['dao_level', 'total_skill_use', 'total_resonance'];
        if (!validCategories.includes(category)) {
            throw new AppError(`无效的排行类别，可选：${validCategories.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const offset = (page - 1) * pageSize;
        const orderField = category === 'dao_level' ? [['dao_level', 'DESC'], ['dao_exp', 'DESC']]
            : category === 'total_skill_use' ? [['total_skill_use_count', 'DESC']]
            : [['total_resonance_count', 'DESC']];

        const { rows, count } = await PlayerTaoismGate.findAndCountAll({
            where: { dao_path: { [Op.ne]: null } },
            order: orderField,
            offset,
            limit: pageSize
        });

        // 批量获取玩家昵称
        const playerIds = rows.map(r => r.player_id);
        const players = await Player.findAll({
            where: { id: { [Op.in]: playerIds } },
            attributes: ['id', 'nickname']
        });
        const playerMap = new Map(players.map(p => [p.id, p.nickname]));

        const rankings = rows.map((r, idx) => ({
            rank: offset + idx + 1,
            player_id: r.player_id,
            player_nickname: playerMap.get(r.player_id) || '未知',
            dao_path: r.dao_path,
            dao_path_name: this.config.dao_paths[r.dao_path]?.name || r.dao_path,
            dao_level: r.dao_level,
            value: category === 'dao_level' ? r.dao_level
                : category === 'total_skill_use' ? r.total_skill_use_count
                : r.total_resonance_count
        }));

        return {
            data: {
                category,
                rankings,
                total: count,
                current_page: page,
                total_pages: Math.ceil(count / pageSize)
            }
        };
    }

    /**
     * 查询道途共鸣状态（同道途在线玩家数+当前共鸣加成）
     * @param {object} player - 玩家对象
     * @returns {object} 共鸣状态
     */
    async getResonance(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            return { data: { message: '尚未选择道途，无共鸣', resonance_bonus: 0 } };
        }

        // 统计同道途玩家总数
        const samePathCount = await PlayerTaoismGate.count({
            where: { dao_path: gate.dao_path }
        });

        // 统计同道途高等级玩家（5级以上）
        const advancedCount = await PlayerTaoismGate.count({
            where: { dao_path: gate.dao_path, dao_level: { [Op.gte]: 5 } }
        });

        const resonanceBonus = this._calculateResonanceBonus(samePathCount);

        return {
            data: {
                dao_path: gate.dao_path,
                dao_path_name: this.config.dao_paths[gate.dao_path]?.name,
                same_path_total: samePathCount,
                same_path_advanced: advancedCount,
                resonance_bonus: resonanceBonus,
                resonance_description: `同道途 ${samePathCount} 人，共鸣加成 ${Math.round(resonanceBonus * 100)}%`,
                restraint_targets: this.config.dao_paths[gate.dao_path]?.restraint_targets || []
            }
        };
    }

    // ==================== 内部方法 ====================

    /**
     * 获取或创建玩家道途记录
     */
    async _getOrCreateGate(playerId) {
        const [gate] = await PlayerTaoismGate.findOrCreate({
            where: { player_id: playerId },
            defaults: { player_id: playerId }
        });
        return gate;
    }

    /**
     * 检查并执行跨日重置
     * 同时处理：玩家首次选择道途后任务列表为空但当日 resetTime 已设置的边界情况
     */
    async _checkDailyReset(gate) {
        const now = new Date();
        const resetTime = gate.daily_task_reset_time ? new Date(gate.daily_task_reset_time) : null;
        const isSameDay = resetTime
            && now.getDate() === resetTime.getDate()
            && now.getMonth() === resetTime.getMonth()
            && now.getFullYear() === resetTime.getFullYear();

        // 情况1：跨日重置（resetTime 未设置 或 不是今天）
        if (!isSameDay) {
            // 生成新任务
            if (gate.dao_path) {
                gate.daily_tasks = this._generateDailyTasks();
            } else {
                gate.daily_tasks = [];
            }
            gate.daily_task_reset_time = now;
            await gate.save();
            return;
        }

        // 情况2：同一天但玩家刚选择道途（daily_tasks 为空但 dao_path 已设置）
        // 此时需要补生成今日任务（避免选择道途前 _checkDailyReset 已设置 resetTime）
        if (gate.dao_path && (!gate.daily_tasks || gate.daily_tasks.length === 0)) {
            gate.daily_tasks = this._generateDailyTasks();
            await gate.save();
        }
    }

    /**
     * 随机生成今日任务（3个，按权重抽取）
     */
    _generateDailyTasks() {
        const taskTypes = this.config.daily_tasks.task_types;
        const weights = this.config.daily_tasks.task_weights;
        const taskCount = this.config.taoism_gate.daily_task_count;

        const tasks = [];
        const typePool = [];

        // 构建权重池
        for (const [typeKey, weight] of Object.entries(weights)) {
            for (let i = 0; i < weight; i++) {
                typePool.push(typeKey);
            }
        }

        // 随机抽取（不重复）
        const selectedTypes = new Set();
        while (selectedTypes.size < Math.min(taskCount, Object.keys(taskTypes).length) && typePool.length > 0) {
            const idx = Math.floor(Math.random() * typePool.length);
            selectedTypes.add(typePool[idx]);
            typePool.splice(idx, 1);
        }

        for (const typeKey of selectedTypes) {
            const taskConfig = taskTypes[typeKey];
            tasks.push({
                task_type: typeKey,
                task_name: taskConfig.name,
                task_description: taskConfig.description,
                target_count: taskConfig.target_count,
                current_count: 0,
                completed: false,
                rewards_claimed: false,
                rewards: taskConfig.rewards
            });
        }

        return tasks;
    }

    /**
     * 检查升级
     */
    _checkLevelUp(gate) {
        let leveledUp = false;
        let newLevel = gate.dao_level;
        const maxLevel = this.config.taoism_gate.max_dao_level;

        while (newLevel < maxLevel) {
            const nextLevelConfig = this.config.level_table[String(newLevel + 1)];
            if (!nextLevelConfig) break;
            if (gate.dao_exp >= nextLevelConfig.exp_required) {
                newLevel += 1;
                leveledUp = true;
            } else {
                break;
            }
        }

        if (leveledUp) {
            gate.dao_level = newLevel;
        }

        return { leveledUp, newLevel };
    }

    /**
     * 更新任务进度
     * 注意：必须使用全新数组赋值并标记 changed，否则 Sequelize 无法检测 JSON 字段内部变更
     */
    _updateTaskProgress(gate, taskType, increment) {
        const tasks = JSON.parse(JSON.stringify(gate.daily_tasks || []));
        for (const task of tasks) {
            if (task.task_type === taskType && !task.completed) {
                task.current_count = Math.min(task.target_count, (task.current_count || 0) + increment);
                if (task.current_count >= task.target_count) {
                    task.completed = true;
                }
            }
        }
        gate.daily_tasks = tasks;
        gate.changed('daily_tasks', true);
    }

    /**
     * 计算共鸣加成
     */
    _calculateResonanceBonus(playerCount) {
        const minPlayers = this.config.resonance_config.min_players;
        if (playerCount < minPlayers) return 0;
        const bonusPerPlayer = this.config.resonance_config.bonus_per_player;
        const maxBonus = this.config.resonance_config.max_bonus;
        return Math.min(maxBonus, (playerCount - minPlayers + 1) * bonusPerPlayer);
    }

    /**
     * 判断本月是否还有免费切换机会
     */
    _isFreeSwitchThisMonth(gate) {
        if (!gate.last_switch_time) return true;
        const lastSwitch = new Date(gate.last_switch_time);
        const now = new Date();
        // 如果上次切换是上个月或更早，本月免费
        if (lastSwitch.getFullYear() < now.getFullYear() || lastSwitch.getMonth() < now.getMonth()) {
            return true;
        }
        return false;
    }

    /**
     * 检查五行相克关系
     */
    _checkRestraint(attackerPath, defenderPath) {
        const pathConfig = this.config.dao_paths[attackerPath];
        if (!pathConfig) return 0;
        return pathConfig.restraint_targets.includes(defenderPath)
            ? this.config.taoism_gate.restraint_bonus
            : 0;
    }

    // ==================== 5种道途技能实现 ====================

    /**
     * 金道·金锋裂魂：攻击目标灵兽，造成HP损失
     * 伤害 = 神识消耗量 × 道途等级 × 0.5
     */
    async _executeMetalBlade(player, gate, targetPlayerId, targetBeastId, t) {
        if (!targetPlayerId || !targetBeastId) {
            throw new AppError('金锋裂魂需指定目标玩家和目标灵兽', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const targetBeast = await SpiritBeast.findOne({
            where: { id: targetBeastId, player_id: targetPlayerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!targetBeast) {
            throw new AppError('目标灵兽不存在或不属于目标玩家', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (targetBeast.is_active) {
            throw new AppError('目标灵兽正在出战中，无法攻击', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询目标玩家道途（用于五行相克）
        const targetGate = await PlayerTaoismGate.findOne({ where: { player_id: targetPlayerId }, transaction: t });
        const restraintBonus = targetGate?.dao_path ? this._checkRestraint(gate.dao_path, targetGate.dao_path) : 0;

        // 计算伤害
        const baseDamage = this.config.dao_paths.metal.skill_divine_sense_cost * gate.dao_level * 0.5;
        const finalDamage = Math.floor(baseDamage * (1 + restraintBonus));

        // 扣除灵兽HP（注意：SpiritBeast 没有 hp_current 字段，使用 hp_max 模拟，实际应扣减忠诚度）
        // 设计选择：扣减忠诚度 + 临时标记受伤
        const loyaltyLoss = Math.min(20, Math.floor(finalDamage / 50));
        targetBeast.loyalty = Math.max(0, targetBeast.loyalty - loyaltyLoss);
        if (loyaltyLoss >= 10) {
            targetBeast.injury_until = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2小时恢复
        }
        await targetBeast.save({ transaction: t });

        return {
            skill_type: 'metal_blade',
            target_player_id: targetPlayerId,
            target_beast_id: targetBeastId,
            target_beast_name: targetBeast.beast_name,
            damage: finalDamage,
            loyalty_loss: loyaltyLoss,
            restraint_bonus: restraintBonus,
            injured: loyaltyLoss >= 10
        };
    }

    /**
     * 木道·木灵回春：恢复自己灵兽HP
     * 恢复量 = 神识消耗量 × 道途等级 × 0.8
     */
    async _executeWoodHeal(player, gate, targetBeastId, t) {
        if (!targetBeastId) {
            throw new AppError('木灵回春需指定目标灵兽', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const beast = await SpiritBeast.findOne({
            where: { id: targetBeastId, player_id: player.id },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!beast) {
            throw new AppError('灵兽不存在或不属于你', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 计算恢复量（恢复忠诚度 + 清除受伤状态）
        const healAmount = Math.floor(this.config.dao_paths.wood.skill_divine_sense_cost * gate.dao_level * 0.8);
        const loyaltyGain = Math.min(30, Math.floor(healAmount / 20));
        beast.loyalty = Math.min(100, beast.loyalty + loyaltyGain);
        if (beast.injury_until && new Date(beast.injury_until) > new Date()) {
            beast.injury_until = null; // 清除受伤状态
        }
        await beast.save({ transaction: t });

        return {
            skill_type: 'wood_heal',
            target_beast_id: targetBeastId,
            target_beast_name: beast.beast_name,
            heal_amount: healAmount,
            loyalty_gain: loyaltyGain,
            injury_cleared: true
        };
    }

    /**
     * 水道·水镜映心：设置反弹盾，下次被探查时反弹50%神识消耗
     */
    async _executeWaterMirror(player, gate, t) {
        // 在 skill_cooldowns 中记录水镜盾到期时间（24小时）
        const shieldEndTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const cooldowns = { ...(gate.skill_cooldowns || {}), water_mirror_shield: shieldEndTime };
        gate.skill_cooldowns = cooldowns;

        return {
            skill_type: 'water_mirror',
            shield_active: true,
            shield_end_time: shieldEndTime,
            shield_description: '下次被探查时反弹50%神识消耗给探查者，持续24小时'
        };
    }

    /**
     * 火道·火眼金睛：探查目标玩家储物袋
     * 成功率 = 基础30% + 道途等级×5% + 神识差×0.1% + 五行相克20%
     */
    async _executeFireEye(player, gate, targetPlayerId, t) {
        if (!targetPlayerId) {
            throw new AppError('火眼金睛需指定目标玩家', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (targetPlayerId === player.id) {
            throw new AppError('不能探查自己', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const targetPlayer = await Player.findByPk(targetPlayerId, { transaction: t });
        if (!targetPlayer) {
            throw new AppError('目标玩家不存在', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 检查目标是否闭关中（闭关状态下无法被探查，与避世不同）
        if (targetPlayer.is_secluded) {
            throw new AppError('目标玩家正在闭关中，无法探查', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 检查目标是否避世中（避世清修状态下免疫神识探查）
        if (targetPlayer.pvp_mode === 'recluse') {
            throw new AppError('目标已避世清修，无法探查', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 检查目标水镜盾
        const targetGate = await PlayerTaoismGate.findOne({ where: { player_id: targetPlayerId }, transaction: t });
        if (targetGate?.skill_cooldowns?.water_mirror_shield) {
            const shieldEnd = new Date(targetGate.skill_cooldowns.water_mirror_shield);
            if (shieldEnd > new Date()) {
                // 反弹50%神识消耗给探查者
                const反弹Cost = Math.floor(this.config.dao_paths.fire.skill_divine_sense_cost * 0.5);
                const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
                if (divineSense) {
                    divineSense.divine_sense_current = Math.max(0, divineSense.divine_sense_current - 反弹Cost);
                    divineSense.total_consumed += 反弹Cost;
                    await divineSense.save({ transaction: t });
                }
                // 清除目标水镜盾（一次性）
                const newCooldowns = { ...targetGate.skill_cooldowns };
                delete newCooldowns.water_mirror_shield;
                targetGate.skill_cooldowns = newCooldowns;
                await targetGate.save({ transaction: t });

                return {
                    skill_type: 'fire_eye',
                    target_player_id: targetPlayerId,
                    success: false,
                    reflected: true,
                    message: `目标有水镜映心护体，探查被反弹，损失 ${反弹Cost} 神识`,
                    extra_divine_sense_cost: 反弹Cost
                };
            }
        }

        // 计算成功率
        const baseRate = 0.30;
        const levelBonus = gate.dao_level * 0.05;
        const attackerDivineSense = (await PlayerDivineSense.findOne({ where: { player_id: player.id }, transaction: t }))?.divine_sense_current || 0;
        const targetDivineSense = (await PlayerDivineSense.findOne({ where: { player_id: targetPlayerId }, transaction: t }))?.divine_sense_current || 0;
        const divineDiffBonus = Math.max(0, (attackerDivineSense - targetDivineSense) * 0.001);
        const restraintBonus = targetGate?.dao_path ? this._checkRestraint(gate.dao_path, targetGate.dao_path) : 0;
        const successRate = Math.min(0.95, baseRate + levelBonus + divineDiffBonus + restraintBonus);

        // 判定成功
        const isSuccess = Math.random() < successRate;

        if (!isSuccess) {
            return {
                skill_type: 'fire_eye',
                target_player_id: targetPlayerId,
                target_player_nickname: targetPlayer.nickname,
                success: false,
                success_rate: successRate,
                message: '探查失败，未能窥探到储物袋'
            };
        }

        // 成功：返回目标玩家部分物品信息
        const Inventory = require('../../models/item');
        const inventoryItems = await Inventory.findAll({
            where: { player_id: targetPlayerId },
            transaction: t,
            limit: 10,
            order: [['created_at', 'DESC']]
        });

        const items = inventoryItems.map(item => ({
            item_id: item.id,
            item_key: item.item_key,
            quantity: item.quantity
        }));

        return {
            skill_type: 'fire_eye',
            target_player_id: targetPlayerId,
            target_player_nickname: targetPlayer.nickname,
            success: true,
            success_rate: successRate,
            restraint_bonus: restraintBonus,
            items_snooped: items,
            message: `成功窥探到 ${targetPlayer.nickname} 的储物袋，发现 ${items.length} 件物品`
        };
    }

    /**
     * 土道·土牢定身：定身目标灵兽2小时
     */
    async _executeEarthPrison(player, gate, targetPlayerId, targetBeastId, t) {
        if (!targetPlayerId || !targetBeastId) {
            throw new AppError('土牢定身需指定目标玩家和目标灵兽', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const targetBeast = await SpiritBeast.findOne({
            where: { id: targetBeastId, player_id: targetPlayerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!targetBeast) {
            throw new AppError('目标灵兽不存在或不属于目标玩家', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (targetBeast.is_active) {
            throw new AppError('目标灵兽正在出战中，无法定身', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询目标玩家道途（五行相克）
        const targetGate = await PlayerTaoismGate.findOne({ where: { player_id: targetPlayerId }, transaction: t });
        const restraintBonus = targetGate?.dao_path ? this._checkRestraint(gate.dao_path, targetGate.dao_path) : 0;

        // 计算成功率（基础80% + 五行相克20%）
        const successRate = Math.min(0.99, 0.80 + restraintBonus);
        const isSuccess = Math.random() < successRate;

        if (!isSuccess) {
            return {
                skill_type: 'earth_prison',
                target_player_id: targetPlayerId,
                target_beast_id: targetBeastId,
                success: false,
                success_rate: successRate,
                message: '土牢定身失败，目标灵兽挣脱了束缚'
            };
        }

        // 设置定身2小时
        targetBeast.injury_until = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await targetBeast.save({ transaction: t });

        return {
            skill_type: 'earth_prison',
            target_player_id: targetPlayerId,
            target_beast_id: targetBeastId,
            target_beast_name: targetBeast.beast_name,
            success: true,
            success_rate: successRate,
            restraint_bonus: restraintBonus,
            immobilized_until: targetBeast.injury_until,
            message: `成功定身 ${targetBeast.beast_name} 2小时，期间无法出战/放养/探渊`
        };
    }
}

module.exports = new TaoismGateService();
