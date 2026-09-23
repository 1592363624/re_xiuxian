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

    /**
     * 道途清单（内容 `taoism_gate_data.dao_paths` 原样导出，含资料片补的档）。
     *
     * 为什么由服务端给：面板以前自己抄了「五行道途全集」+ 一份中文名表 + 一份五段描述文案，
     * 内容加一档道途时界面上永远少一张卡，改文案也不会跟着变（抄的那份描述还漏过技能名）。
     * 配色留在客户端（是 tailwind 类名组合，不是内容），内容里那个 `color` 仍随载荷带着备用。
     */
    _daoPathOptions() {
        return Object.entries(this.config?.dao_paths || {}).map(([key, path]) => ({
            key,
            name: path.name || key,
            description: path.description || '',
            color: path.color || null,
            passive_bonus_desc: path.passive_bonus_desc || '',
            skill_name: path.skill_name || '',
            skill_min_level: path.skill_min_level ?? null,
            restraint_targets: path.restraint_targets || []
        }));
    }

    // ==================== 玩家接口 ====================

    /**
     * 获取道途面板（含道途/等级/经验/技能/任务/共鸣信息）
     * @param {object} player - 玩家对象（来自 auth 中间件）
     * @returns {object} 道途面板数据
     */
    async getProfile(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const gate = await this._resetDailyTasksForRead(player.id);

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
                dao_path_options: this._daoPathOptions(),
                daily_tasks: gate.daily_tasks || [],
                resonance: {
                    same_path_player_count: samePathCount,
                    resonance_bonus: this._calculateResonanceBonus(samePathCount),
                    restraint_targets: pathConfig?.restraint_targets || []
                },
                stats: {
                    total_cultivate_count: gate.total_cultivate_count,
                    total_skill_use_count: gate.total_skill_use_count,
                    total_resonance_count: gate.total_resonance_count,
                    // 当日次数：跨日归零后的有效值（前端「今日已修」必须读这份，
                    // 不能用浏览器会话本地计数 —— 刷新就归零，和数据库对不上）
                    daily_cultivate_count: this._effectiveDailyCultivateCount(gate),
                    daily_cultivate_limit: Number(this.config.taoism_gate.daily_cultivate_limit) || 5
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
            // 清单取自内容：以前这里抄了一份"metal（金）/wood（木）/…"，资料片加一档就会说错话
            const options = this._daoPathOptions().map(o => `${o.key}（${o.name}）`).join('/');
            throw new AppError(`无效的道途，可选：${options}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验境界
        if (player.realm_rank < this.config.taoism_gate.min_realm_rank) {
            throw new AppError(`需达到境界rank ${this.config.taoism_gate.min_realm_rank}（元婴期）才能选择道途`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        let gate = await this._getOrCreateGate(player.id);

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
            // 锁内重判"是否已选过道途"：并发双开 choose 时两边都会从各自快照看到空值，
            // 后提交的会把先提交的那一份（含 dao_level/dao_exp/冷却）整体盖掉
            gate = await this._lockGate(player.id, t);
            if (gate.dao_path) {
                throw new AppError(`已选择道途 ${this.config.dao_paths[gate.dao_path].name}，请使用切换接口`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
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

        let gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，请使用 choose 接口首次选择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (gate.dao_path === newPathKey) {
            throw new AppError('当前已是该道途，无需切换', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验切换冷却（7天）
        const cooldownLeft = this._switchCooldownHoursLeft(gate);
        if (cooldownLeft > 0) {
            throw new AppError(`道途切换冷却中，还需 ${cooldownLeft} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 计算切换费用：每月1次免费，之后消耗法则碎片
        let needFragment = !this._isFreeSwitchThisMonth(gate);

        const t = await sequelize.transaction();
        try {
            // 锁次序与本服务其它写路径一致：taoism_gate → （divine_sense）→ law。
            // 切换冷却/是否免费/当前道途都要照锁住的那一份重判：last_switch_time 与切换次数都在整块列里，
            // 两个并发切换会双双通过外面的检查，然后后提交的把前一次的切换记录盖掉。
            gate = await this._lockGate(player.id, t);
            if (!gate.dao_path) {
                throw new AppError('尚未选择道途，请使用 choose 接口首次选择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (gate.dao_path === newPathKey) {
                throw new AppError('当前已是该道途，无需切换', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const freshCooldown = this._switchCooldownHoursLeft(gate);
            if (freshCooldown > 0) {
                throw new AppError(`道途切换冷却中，还需 ${freshCooldown} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            needFragment = !this._isFreeSwitchThisMonth(gate);

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

        let gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无法修炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (gate.dao_level >= this.config.taoism_gate.max_dao_level) {
            throw new AppError('道途已满级，无需继续修炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        await this._resetDailyTasksForRead(player.id);

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
            // 先锁道途行再锁神识（本服务统一次序），并把"今日次数上限"照锁住的那一份重判一遍：
            // daily_cultivate_count 在整块列上，两个并发修炼会各自从旧快照 +1，后提交的抹掉前一个 → 上限形同虚设
            gate = await this._lockGate(player.id, t);
            if (!gate.dao_path) {
                throw new AppError('尚未选择道途，无法修炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (gate.last_cultivate_date !== todayDateStr) {
                gate.daily_cultivate_count = 0;
                gate.last_cultivate_date = todayDateStr;
            }
            if (gate.daily_cultivate_count >= this.config.taoism_gate.daily_cultivate_limit) {
                throw new AppError(`今日修炼次数已达上限（${this.config.taoism_gate.daily_cultivate_limit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

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
                    divine_sense_left: divineSense.divine_sense_current,
                    // 当日次数一并回传，前端不必再自己 +1 猜
                    daily_cultivate_count: gate.daily_cultivate_count,
                    daily_cultivate_limit: Number(this.config.taoism_gate.daily_cultivate_limit) || 5
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

        // 快速失败用的预读；真正的判定在锁内重做一遍（见 _lockGate）
        let gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无法使用技能', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        let pathConfig = this.config.dao_paths[gate.dao_path];
        let skillId = pathConfig.skill_id;

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

        let divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id } });
        if (!divineSense || divineSense.divine_sense_current < pathConfig.skill_divine_sense_cost) {
            throw new AppError(`神识不足，使用 ${pathConfig.skill_name} 需 ${pathConfig.skill_divine_sense_cost} 神识`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 执行技能效果
        const t = await sequelize.transaction();
        try {
            // 涉及的玩家行一次按 player_id 升序取齐再判定：火眼会消耗目标的水镜盾（写对方那一行），
            // 双方互放时"先锁自己再锁对方"就是 ABBA 死锁
            const lockedGates = await this._lockGatesByPlayerIdAsc([player.id, targetPlayerId], t);
            gate = lockedGates.get(Number(player.id)) || await this._lockGate(player.id, t);
            const targetGate = targetPlayerId ? (lockedGates.get(Number(targetPlayerId)) || null) : null;
            // 锁内重取道途与技能：外面那份 pathConfig 可能已经过期（并发里刚切过道途，冷却会记到别的技能上）
            pathConfig = this.config.dao_paths[gate.dao_path];
            if (!pathConfig) {
                throw new AppError('尚未选择道途，无法使用技能', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            skillId = pathConfig.skill_id;
            if (gate.dao_level < pathConfig.skill_min_level) {
                throw new AppError(`道途等级不足，需 ${pathConfig.skill_min_level} 级才能使用技能 ${pathConfig.skill_name}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const freshCooldown = gate.skill_cooldowns?.[skillId];
            if (freshCooldown && new Date(freshCooldown) > new Date()) {
                throw new AppError(`技能冷却中，还需 ${Math.ceil((new Date(freshCooldown) - new Date()) / (1000 * 60 * 60))} 小时`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            divineSense = await PlayerDivineSense.findOne({
                where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE
            });
            if (!divineSense || divineSense.divine_sense_current < pathConfig.skill_divine_sense_cost) {
                throw new AppError(`神识不足，使用 ${pathConfig.skill_name} 需 ${pathConfig.skill_divine_sense_cost} 神识`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            let skillResult;
            switch (skillId) {
                case 'metal_blade':
                    skillResult = await this._executeMetalBlade(player, gate, targetPlayerId, targetBeastId, t, targetGate);
                    break;
                case 'wood_heal':
                    skillResult = await this._executeWoodHeal(player, gate, targetBeastId, t);
                    break;
                case 'water_mirror':
                    skillResult = await this._executeWaterMirror(player, gate, t);
                    break;
                case 'fire_eye':
                    skillResult = await this._executeFireEye(player, gate, targetPlayerId, t, targetGate);
                    break;
                case 'earth_prison':
                    skillResult = await this._executeEarthPrison(player, gate, targetPlayerId, targetBeastId, t, targetGate);
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

        const gate = await this._resetDailyTasksForRead(player.id);

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

        let gate = await this._getOrCreateGate(player.id);
        if (!gate.dao_path) {
            throw new AppError('尚未选择道途，无任务奖励', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        gate = await this._resetDailyTasksForRead(player.id);

        let tasks = gate.daily_tasks || [];
        if (taskIndex < 0 || taskIndex >= tasks.length) {
            throw new AppError('任务索引无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        let task = tasks[taskIndex];
        if (!task.completed) {
            throw new AppError('任务尚未完成', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (task.rewards_claimed) {
            throw new AppError('任务奖励已领取', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 锁住之后重判一遍：rewards_claimed 只是整块 daily_tasks 里的一个标记，两个并发"领取"
            // 都从外面那份快照通过检查，就会把同一条任务的奖励发两次（神识/法则碎片/经验都重复给）。
            gate = await this._lockGate(player.id, t);
            await this._checkDailyReset(gate, t);
            tasks = gate.daily_tasks || [];
            if (taskIndex < 0 || taskIndex >= tasks.length) {
                throw new AppError('任务索引无效', 400, ErrorCodes.VALIDATION_ERROR);
            }
            task = tasks[taskIndex];
            if (!task.completed) {
                throw new AppError('任务尚未完成', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (task.rewards_claimed) {
                throw new AppError('任务奖励已领取', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

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
     * 当日已修炼次数的有效值（跨日归零）。
     * last_cultivate_date 不是今天时 daily_cultivate_count 在库里还是昨天的残留，
     * 直接透出会让「今日已修」显示昨天的次数。只读场景用这个，不写库。
     */
    _effectiveDailyCultivateCount(gate) {
        const todayDateStr = new Date().toISOString().slice(0, 10);
        return gate.last_cultivate_date === todayDateStr ? Number(gate.daily_cultivate_count || 0) : 0;
    }

    /**
     * 事务内取自己的道途行并锁住 —— 所有"改 skill_cooldowns / daily_tasks / dao_exp"的写路径都要先过这里。
     *
     * 为什么必须锁：`_getOrCreateGate` 是事务外的快照，而这一行的技能冷却、日常任务、经验都是
     * **整块 JSON 列**（读出来改一改再整体写回）。两个并发请求会各自拿一份快照，后提交的把先提交的
     * 那一块原样盖掉，表现不是"少一条日志"而是可以复现的外挂：
     *   - 冷却被抹掉 → 同一个道途技能当场可以再放一次；
     *   - `rewards_claimed` 被抹掉 → 同一条日常任务奖励领两次（神识/法则碎片/经验都重复发）；
     *   - `daily_cultivate_count` 被抹掉 → 突破每日修炼上限。
     * 因此判定也要重做一遍：外面那次检查只能算快速失败，锁住之后读到的那份才算数。
     *
     * 取锁次序（本服务统一）：taoism_gate → divine_sense → law。反过来写会和处理神识/法则的流程
     * 在同一玩家身上形成 ABBA。
     * @param {number} playerId - 玩家ID
     * @param {Object} t - 事务
     * @returns {Promise<Object>} 已加锁的道途行
     */
    async _lockGate(playerId, t) {
        const locked = await PlayerTaoismGate.findOne({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (locked) return locked;
        // 行还不存在：先建（唯一约束兜住并发建号），再按同一次序锁回来
        await PlayerTaoismGate.findOrCreate({
            where: { player_id: playerId },
            defaults: { player_id: playerId },
            transaction: t
        });
        return PlayerTaoismGate.findOne({ where: { player_id: playerId }, transaction: t, lock: t.LOCK.UPDATE });
    }

    /**
     * 一批玩家 → 他们的道途行（已加锁），**按 player_id 升序取锁**。
     *
     * 为什么必须排序：技能会写别人的那一行（火眼要消耗目标的水镜盾）。若两条并发请求
     * 各自"先锁自己、再锁对方"，A 持 A 行等 B 行、B 持 B 行等 A 行 —— 就是 ABBA 死锁
     * （和封神台、宗门战那两处同一形状）。所以凡是要同时碰多张玩家行的写路径，
     * 都只能一次按升序把锁取齐，再开始判定与写入。
     * @param {Array<number>} playerIds - 涉及的玩家 id（可含 undefined/自己）
     * @param {Object} t - 事务
     * @returns {Promise<Map<number, Object>>} player_id → 已加锁的道途行（没这一行的玩家不在表里）
     */
    async _lockGatesByPlayerIdAsc(playerIds, t) {
        const ids = [...new Set(playerIds.map(Number).filter(id => Number.isFinite(id) && id > 0))]
            .sort((a, b) => a - b);
        if (!ids.length) return new Map();
        const rows = await PlayerTaoismGate.findAll({
            where: { player_id: { [Op.in]: ids } },
            order: [['player_id', 'ASC']],
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        return new Map(rows.map(row => [Number(row.player_id), row]));
    }

    /**
     * 道途切换还要等多久（小时，0 = 可以切换）。冷却时长取自内容 taoism_gate.switch_cooldown_hours。
     * 检查切换冷却的地方有两处（快速失败 + 锁内重判），所以算法定在这一处。
     * @param {Object} gate - 道途行
     * @returns {number} 剩余小时数
     */
    _switchCooldownHoursLeft(gate) {
        if (!gate?.last_switch_time) return 0;
        const cooldownHours = Number(this.config.taoism_gate.switch_cooldown_hours) || 0;
        const elapsed = (Date.now() - new Date(gate.last_switch_time).getTime()) / (1000 * 60 * 60);
        return elapsed >= cooldownHours ? 0 : Math.ceil(cooldownHours - elapsed);
    }

    /**
     * 今日任务要不要重置：情况1 跨日（含从未设置过 stamp），
     * 情况2 同一天但玩家刚选完道途、任务还没生成。
     * 面板的"无锁预看"与锁内重判共用这一份算法，两边判定必须一致。
     */
    _dailyResetDue(gate) {
        const now = new Date();
        const resetTime = gate.daily_task_reset_time ? new Date(gate.daily_task_reset_time) : null;
        const isSameDay = resetTime
            && now.getDate() === resetTime.getDate()
            && now.getMonth() === resetTime.getMonth()
            && now.getFullYear() === resetTime.getFullYear();
        if (!isSameDay) return true;
        return !!(gate.dao_path && (!gate.daily_tasks || gate.daily_tasks.length === 0));
    }

    /**
     * 检查并执行跨日重置。**必须在调用方的事务里写回。**
     * @param {Object} t 调用方事务。少了它会这样：claimTaskReward 刚在 t 里用 FOR UPDATE 锁住这行，
     *   不带事务的 save() 走的是**另一条连接**去 UPDATE 同一行，正好被自己手上的锁挡住 ——
     *   只能干等 innodb_lock_wait_timeout（默认 50 秒）再抛 ER_LOCK_WAIT_TIMEOUT。
     */
    async _checkDailyReset(gate, t) {
        if (!t) throw new Error('_checkDailyReset 必须带调用方的事务（不带事务会撞自己持有的行锁）');
        if (!this._dailyResetDue(gate)) return;

        const now = new Date();
        const resetTime = gate.daily_task_reset_time ? new Date(gate.daily_task_reset_time) : null;
        const isSameDay = resetTime
            && now.getDate() === resetTime.getDate()
            && now.getMonth() === resetTime.getMonth()
            && now.getFullYear() === resetTime.getFullYear();

        gate.daily_tasks = gate.dao_path ? this._generateDailyTasks() : [];
        if (!isSameDay) gate.daily_task_reset_time = now;
        await gate.save({ transaction: t });
    }

    /**
     * 读面板路径上的跨日重置：先无锁看一眼要不要重置（绝大多数请求进不到事务里），
     * 真要重置就开一个短事务、锁行、锁内重判再写。
     *
     * 以前 getProfile / getDailyTasks 是"无锁读 → _checkDailyReset → gate.save()"，
     * 与 claimTaskReward 的加锁写交错就会互相覆盖：面板把刚领完的整块 daily_tasks
     * （带 rewards_claimed）按自己那份旧快照写回去，标记没了 → 同一条任务今天还能再领一次。
     * @param {number} playerId
     * @returns {Promise<Object>} 该拿去渲染的那一行
     */
    async _resetDailyTasksForRead(playerId) {
        const peek = await this._getOrCreateGate(playerId);
        if (!this._dailyResetDue(peek)) return peek;

        const t = await sequelize.transaction();
        try {
            const gate = await this._lockGate(playerId, t);
            await this._checkDailyReset(gate, t);
            await t.commit();
            return gate;
        } catch (error) {
            await t.rollback().catch(() => {});
            throw error;
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
    async _executeMetalBlade(player, gate, targetPlayerId, targetBeastId, t, targetGate) {
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
        // targetGate 由 useSkill 按 player_id 升序取锁后传进来（这里再自己 findOne 就是无锁读）
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
    async _executeFireEye(player, gate, targetPlayerId, t, targetGate) {
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
        // targetGate 由 useSkill 按 player_id 升序取锁后传进来（这里再自己 findOne 就是无锁读）
        if (targetGate?.skill_cooldowns?.water_mirror_shield) {
            const shieldEnd = new Date(targetGate.skill_cooldowns.water_mirror_shield);
            if (shieldEnd > new Date()) {
                // 反弹50%神识消耗给探查者
                // 变量名必须 ASCII 且 const 后要有空格：这里原本写的是 `const反弹Cost = ...`，
                // 声明没成立，严格模式下当成给未声明变量赋值 → 每次"目标有水镜盾"时火眼都抛
                // ReferenceError，整笔施法回滚（探针 T5 实测）
                const reflectCost = Math.floor(this.config.dao_paths.fire.skill_divine_sense_cost * 0.5);
                const divineSense = await PlayerDivineSense.findOne({ where: { player_id: player.id }, transaction: t, lock: t.LOCK.UPDATE });
                if (divineSense) {
                    divineSense.divine_sense_current = Math.max(0, divineSense.divine_sense_current - reflectCost);
                    divineSense.total_consumed += reflectCost;
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
                    message: `目标有水镜映心护体，探查被反弹，损失 ${reflectCost} 神识`,
                    extra_divine_sense_cost: reflectCost
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
    async _executeEarthPrison(player, gate, targetPlayerId, targetBeastId, t, targetGate) {
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
        // targetGate 由 useSkill 按 player_id 升序取锁后传进来（这里再自己 findOne 就是无锁读）
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
