/**
 * 战斗服务
 *
 * 处理怪物战斗逻辑
 *
 * 关键设计说明：
 * 1. battle_log/monster_data 字段在 model 中有 getter/setter（JSON.parse/stringify），
 *    getter 每次返回新数组/对象，直接 .push() 不生效，必须重新 set 整个数组
 * 2. BIGINT 字段（player_hp/mp_current/monster_hp 等）从数据库读出后为字符串，
 *    需要用 safeBigInt() 统一转换，避免 BigInt(null) 抛 TypeError 导致 500
 * 3. attributes 字段同样有 getter，返回对象，访问 .atk 等属性前需判空
 */
const sequelize = require('../../config/database');
const ActiveBattle = require('../../models/activeBattle');
const PlayerCombat = require('../../models/playerCombat');
const Player = require('../../models/player');
const Item = require('../../models/item');
const MapConfigLoader = require('./MapConfigLoader');
const DropLoader = require('./DropLoader');
const { infrastructure } = require('../../modules');
// 引入 AppError 用于抛出带 HTTP 状态码的业务错误（避免 throw Error 被 errorHandler 当成 500）
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 通过 ConfigLoader 获取配置（支持热更新）
const configLoader = infrastructure.ConfigLoader;

// 懒加载配置，避免模块加载时配置未初始化的问题
function getGameBalanceConfig() {
    return configLoader.getConfig('game_balance') || {};
}

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError: Cannot convert null to a BigInt，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

/**
 * 战斗日志安全追加工具
 * 为什么需要：ActiveBattle 模型的 battle_log 字段 getter 返回新数组（JSON.parse 结果），
 * 直接 battle.battle_log.push(entry) 操作的是临时数组，save 时 sequelize 检测不到变化
 * 正确做法：取出数组 → push → 重新 set（触发 setter 标记字段为脏）
 * @param {object} battle - ActiveBattle 实例
 * @param {object} entry - 日志条目
 */
function appendBattleLog(battle, entry) {
    const log = battle.battle_log || [];
    log.push(entry);
    battle.battle_log = log; // 触发 setter，确保 save 时写入数据库
}

class CombatService {
    /**
     * 遭遇怪物
     */
    static async encounter(playerId, monsterId = null) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 兜底：如果玩家 HP <= 0（之前战斗死亡未恢复），先恢复到安全值再开始战斗
        // 避免一进入战斗就立即被判失败
        const currentHp = safeBigInt(player.hp_current);
        if (currentHp <= 0n) {
            const playerHpMax = this.getPlayerStat(player, 'hp_max', 100);
            const deathMinHp = getGameBalanceConfig().combat?.death_min_hp ?? 10;
            const deathRecoveryRate = getGameBalanceConfig().combat?.death_hp_recovery_rate ?? 0.3;
            player.hp_current = BigInt(Math.max(deathMinHp, Math.floor(playerHpMax * deathRecoveryRate)));
            await player.save();
            console.log(`[Combat] 玩家 ${playerId} HP 为 0，遭遇前恢复至 ${player.hp_current}`);
        }

        const activeBattle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (activeBattle) {
            return {
                in_battle: true,
                battle_id: activeBattle.battle_uuid,
                monster: {
                    id: activeBattle.monster_id,
                    name: activeBattle.monster_name,
                    hp: safeBigInt(activeBattle.monster_hp).toString(),
                    max_hp: safeBigInt(activeBattle.monster_max_hp).toString()
                },
                player: {
                    hp: safeBigInt(activeBattle.player_hp).toString(),
                    mp: safeBigInt(activeBattle.player_mp).toString()
                },
                round: activeBattle.round,
                turn: activeBattle.turn,
                battle_log: (activeBattle.battle_log || []).slice(-5)
            };
        }

        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        if (!mapConfig || !mapConfig.monsters || mapConfig.monsters.length === 0) {
            throw new AppError('当前地图没有怪物', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        let selectedMonster;
        if (monsterId) {
            selectedMonster = mapConfig.monsters.find(m => m.id === monsterId);
            if (!selectedMonster) {
                throw new AppError('该怪物在当前地图中不存在', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
        } else {
            const randomIndex = Math.floor(Math.random() * mapConfig.monsters.length);
            selectedMonster = mapConfig.monsters[randomIndex];
        }

        const monsterData = this.generateMonsterData(selectedMonster, player);

        const battle = await ActiveBattle.create({
            player_id: playerId,
            monster_id: selectedMonster.id,
            monster_name: selectedMonster.name,
            monster_data: monsterData,
            map_id: player.current_map_id,
            battle_type: 'normal',
            round: 1,
            turn: 'player',
            player_hp: safeBigInt(player.hp_current),
            player_mp: safeBigInt(player.mp_current),
            monster_hp: monsterData.max_hp,
            monster_max_hp: monsterData.max_hp,
            is_player_turn: true,
            // 战斗过期时间从配置读取，避免硬编码
            expires_at: new Date(Date.now() + (getGameBalanceConfig().combat?.battle_expire_minutes ?? 30) * 60 * 1000)
        });

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            monster: {
                id: selectedMonster.id,
                name: selectedMonster.name,
                realm: selectedMonster.realm,
                hp: monsterData.max_hp.toString(),
                max_hp: monsterData.max_hp.toString(),
                atk: monsterData.atk.toString(),
                def: monsterData.def.toString(),
                speed: monsterData.speed.toString()
            },
            player: {
                hp: safeBigInt(player.hp_current).toString(),
                mp: safeBigInt(player.mp_current).toString()
            },
            round: 1,
            turn: 'player',
            message: `遭遇 ${selectedMonster.name}！`
        };
    }

    /**
     * 生成怪物数据（根据玩家等级调整）
     * 通过懒加载函数读取配置，避免模块加载时配置未初始化的问题
     */
    static generateMonsterData(monsterConfig, player) {
        const playerLevel = this.getPlayerLevel(player);
        // 修复：原代码误用未声明的 gameBalanceConfig，应使用懒加载函数 getGameBalanceConfig
        const { combat } = getGameBalanceConfig();
        const levelMultiplier = combat.level_multiplier_base + (playerLevel * combat.level_multiplier_per_level);

        return {
            id: monsterConfig.id,
            name: monsterConfig.name,
            realm: monsterConfig.realm,
            max_hp: Math.floor(combat.base_monster_hp * levelMultiplier),
            hp: Math.floor(combat.base_monster_hp * levelMultiplier),
            atk: Math.floor(combat.base_monster_atk * levelMultiplier),
            def: Math.floor(combat.base_monster_def * levelMultiplier),
            speed: Math.floor(combat.base_monster_speed * levelMultiplier),
            exp_reward: monsterConfig.exp || 10
        };
    }

    /**
     * 获取玩家等级（基于境界）
     */
    static getPlayerLevel(player) {
        const { REALM_ORDER } = require('../../utils/gameConstants');
        return REALM_ORDER.indexOf(player.realm) + 1;
    }

    /**
     * 安全读取玩家属性值
     * 防御场景：player.attributes 可能因 JSON 解析失败返回 {}，属性可能不存在
     * @param {object} player - 玩家实例
     * @param {string} key - 属性键名（atk/def/speed 等）
     * @param {number} defaultVal - 默认值
     * @returns {number} 属性数值
     */
    static getPlayerStat(player, key, defaultVal) {
        const stats = player.attributes || {};
        const val = stats[key];
        // 字符串数字转 number，避免后续 BigInt 运算类型混乱
        const num = Number(val);
        return Number.isFinite(num) ? num : defaultVal;
    }

    /**
     * 玩家攻击
     */
    static async attack(playerId, action = 'attack') {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle) {
            throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        if (!battle.is_player_turn) {
            throw new AppError('还未轮到你的回合', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const playerAtk = this.getPlayerStat(player, 'atk', 10);
        const monsterDef = battle.monster_data?.def || 5;

        const combatConfig = getGameBalanceConfig().combat || {};
        const dmgRange = combatConfig.damage_random_range ?? 15;
        const dmgOffset = combatConfig.damage_random_offset ?? 7;

        let damage = Math.max(1, playerAtk - monsterDef + Math.floor(Math.random() * dmgRange) - dmgOffset);

        // 技能加成：仅当 action=skill 且灵力足够时生效（attack 路由的 skill 分支）
        if (action === 'skill' && safeBigInt(player.mp_current) >= (combatConfig.skill_mp_cost ?? 20)) {
            damage = Math.floor(damage * (combatConfig.skill_damage_multiplier ?? 1.5));
            battle.player_mp = safeBigInt(battle.player_mp) - BigInt(combatConfig.skill_mp_cost ?? 20);
        }

        // 使用 safeBigInt 防御 null/undefined 导致 500
        battle.monster_hp = safeBigInt(battle.monster_hp) - BigInt(damage);
        battle.damage_dealt = safeBigInt(battle.damage_dealt) + BigInt(damage);

        // 修复：使用 appendBattleLog 替代直接 push，确保 save 时写入数据库
        appendBattleLog(battle, {
            round: battle.round,
            attacker: 'player',
            action: action,
            damage: damage,
            target_hp: safeBigInt(battle.monster_hp).toString(),
            timestamp: new Date().toISOString()
        });

        const battleResult = await this.checkBattleEnd(battle, player);
        if (battleResult) {
            return battleResult;
        }

        battle.is_player_turn = false;
        battle.turn = 'monster';
        battle.last_action_time = new Date();
        await battle.save();

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            action: action,
            damage: damage,
            monster_hp: safeBigInt(battle.monster_hp).toString(),
            turn: 'monster',
            message: `你对 ${battle.monster_name} 造成了 ${damage} 点伤害！`
        };
    }

    /**
     * 怪物行动
     */
    static async monsterTurn(playerId) {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle || battle.is_player_turn) {
            return null;
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const playerDef = this.getPlayerStat(player, 'def', 5);

        const monsterData = battle.monster_data || {};
        // 怪物伤害随机范围从配置读取，与玩家伤害公式保持一致
        const monsterDmgConfig = getGameBalanceConfig().combat || {};
        const monsterDmgRange = monsterDmgConfig.monster_damage_random_range ?? 6;
        const monsterDmgOffset = monsterDmgConfig.monster_damage_random_offset ?? 3;
        let damage = Math.max(1, (monsterData.atk || 8) - playerDef + Math.floor(Math.random() * monsterDmgRange) - monsterDmgOffset);

        battle.player_hp = safeBigInt(battle.player_hp) - BigInt(damage);
        battle.damage_received = safeBigInt(battle.damage_received) + BigInt(damage);

        appendBattleLog(battle, {
            round: battle.round,
            attacker: 'monster',
            action: 'attack',
            damage: damage,
            target_hp: safeBigInt(battle.player_hp).toString(),
            timestamp: new Date().toISOString()
        });

        const battleResult = await this.checkBattleEnd(battle, player);
        if (battleResult) {
            return battleResult;
        }

        battle.round += 1;
        battle.is_player_turn = true;
        battle.turn = 'player';
        battle.last_action_time = new Date();
        await battle.save();

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            action: 'monster_attack',
            damage: damage,
            player_hp: safeBigInt(battle.player_hp).toString(),
            turn: 'player',
            round: battle.round,
            message: `${battle.monster_name} 对你造成了 ${damage} 点伤害！`
        };
    }

    /**
     * 逃跑
     */
    static async flee(playerId) {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle) {
            throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const escapeChance = getGameBalanceConfig().combat?.escape_chance ?? 0.5;
        const success = Math.random() < escapeChance;

        if (success) {
            const player = await Player.findByPk(playerId);
            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: 'flee',
                success: true,
                timestamp: new Date().toISOString()
            });

            await this.saveBattleRecord(battle, player, 'flee', null);
            await battle.destroy();

            return {
                success: true,
                fled: true,
                message: '成功逃跑！'
            };
        } else {
            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: 'flee',
                success: false,
                timestamp: new Date().toISOString()
            });
            battle.is_player_turn = false;
            battle.turn = 'monster';
            battle.last_action_time = new Date();
            await battle.save();

            return {
                success: false,
                fled: false,
                message: '逃跑失败！'
            };
        }
    }

    /**
     * 放弃战斗（玩家主动脱离卡死的战斗，不保存战斗记录）
     * 使用场景：玩家有遗留的过期战斗记录，无法通过正常途径清除
     * 与 flee 的区别：flee 有概率失败且记录到战斗历史，abandon 直接清除不计入历史
     */
    static async abandon(playerId) {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle) {
            throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        await battle.destroy();

        return {
            success: true,
            message: '已放弃战斗'
        };
    }

    /**
     * 检查战斗是否结束
     */
    static async checkBattleEnd(battle, player) {
        if (safeBigInt(battle.monster_hp) <= 0n) {
            const dropResult = DropLoader.rollDrop(battle.monster_id);

            const gainedExp = dropResult.exp;
            player.exp = safeBigInt(player.exp) + BigInt(gainedExp);

            const gainedItems = [];
            for (const item of dropResult.items) {
                await Item.upsert({
                    player_id: player.id,
                    item_key: item.item_id,
                    quantity: item.quantity
                });
                gainedItems.push({
                    item_id: item.item_id,
                    quantity: item.quantity
                });
            }

            await player.save();

            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: 'victory',
                exp: gainedExp,
                items: gainedItems,
                timestamp: new Date().toISOString()
            });

            await this.saveBattleRecord(battle, player, 'win', { exp: gainedExp, items: gainedItems });
            await battle.destroy();

            return {
                in_battle: false,
                victory: true,
                result: 'win',
                battleEnded: true,
                message: `击败 ${battle.monster_name}！获得 ${gainedExp} 修为`,
                rewards: {
                    exp: gainedExp,
                    items: gainedItems
                }
            };
        }

        if (safeBigInt(battle.player_hp) <= 0n) {
            const currentExp = safeBigInt(player.exp);
            const penaltyRate = getGameBalanceConfig().combat?.death_exp_penalty_rate ?? 0.1;
            const penaltyExp = currentExp * BigInt(Math.round(penaltyRate * 100)) / 100n;
            player.exp = currentExp - penaltyExp;
            // hp_max 存储在 attributes JSON 字段中，需要从中读取
            const playerHpMax = this.getPlayerStat(player, 'hp_max', 100);
            const deathMinHp = getGameBalanceConfig().combat?.death_min_hp ?? 10;
            const deathRecoveryRate = getGameBalanceConfig().combat?.death_hp_recovery_rate ?? 0.3;
            player.hp_current = BigInt(Math.max(deathMinHp, Math.floor(playerHpMax * deathRecoveryRate)));
            await player.save();

            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'monster',
                action: 'defeat',
                penalty_exp: penaltyExp.toString(),
                timestamp: new Date().toISOString()
            });

            await this.saveBattleRecord(battle, player, 'lose', { penalty_exp: penaltyExp.toString() });
            await battle.destroy();

            return {
                in_battle: false,
                defeat: true,
                result: 'lose',
                battleEnded: true,
                message: `被 ${battle.monster_name} 击败！扣除 ${penaltyExp} 修为`,
                penalty_exp: penaltyExp.toString()
            };
        }

        return null;
    }

    /**
     * 保存战斗记录
     */
    static async saveBattleRecord(battle, player, result, rewards) {
        await PlayerCombat.create({
            player_id: player.id,
            monster_id: battle.monster_id,
            monster_name: battle.monster_name,
            map_id: battle.map_id,
            battle_type: battle.battle_type,
            battle_result: result,
            rounds: battle.round,
            damage_dealt: safeBigInt(battle.damage_dealt),
            damage_received: safeBigInt(battle.damage_received),
            hp_remaining: safeBigInt(battle.player_hp),
            rewards_exp: rewards?.exp || 0,
            rewards_items: JSON.stringify(rewards?.items || []),
            battle_duration: Math.floor((Date.now() - battle.battle_start_time.getTime()) / 1000)
        });
    }

    /**
     * 获取战斗状态
     */
    static async getBattleStatus(playerId, battleId = null) {
        let battle;
        if (battleId) {
            battle = await ActiveBattle.findOne({
                where: { battle_uuid: battleId, player_id: playerId }
            });
        } else {
            battle = await ActiveBattle.findOne({
                where: { player_id: playerId }
            });
        }

        if (!battle) {
            return { in_battle: false };
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            // 玩家不存在但有遗留战斗，自动清理
            await battle.destroy();
            return { in_battle: false };
        }
        const playerMaxHp = this.getPlayerStat(player, 'hp_max', 100);
        const playerMaxMp = this.getPlayerStat(player, 'mp_max', 0);

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            monster: {
                id: battle.monster_id,
                name: battle.monster_name,
                realm: battle.monster_data?.realm || '炼气期',
                hp: safeBigInt(battle.monster_hp).toString(),
                max_hp: safeBigInt(battle.monster_max_hp).toString(),
                atk: (battle.monster_data?.atk ?? 10).toString(),
                def: (battle.monster_data?.def ?? 5).toString(),
                exp_reward: battle.monster_data?.exp_reward || 10
            },
            player: {
                hp: safeBigInt(battle.player_hp).toString(),
                max_hp: playerMaxHp.toString(),
                mp: safeBigInt(battle.player_mp).toString(),
                max_mp: playerMaxMp.toString()
            },
            round: battle.round,
            turn: battle.turn,
            battle_log: (battle.battle_log || []).slice(-10)
        };
    }

    /**
     * 获取战斗历史
     */
    static async getBattleHistory(playerId, limit = 20) {
        const battles = await PlayerCombat.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: limit
        });

        return battles.map(b => ({
            id: b.id,
            monster_id: b.monster_id,
            monster_name: b.monster_name,
            result: b.battle_result,
            rounds: b.rounds,
            exp: safeBigInt(b.rewards_exp).toString(),
            items: b.rewards_items,
            time: b.created_at
        }));
    }

    /**
     * 使用技能
     */
    static async useSkill(playerId, skillIndex = 0) {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle) {
            throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        if (!battle.is_player_turn) {
            throw new AppError('还未轮到你的回合', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const combatConfig = getGameBalanceConfig().combat || {};
        const skillMpCost = combatConfig.skill_mp_cost ?? 20;

        if (safeBigInt(player.mp_current) < skillMpCost) {
            throw new AppError(`灵力不足，需要 ${skillMpCost} 点灵力`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const playerAtk = this.getPlayerStat(player, 'atk', 10);
        const monsterDef = battle.monster_data?.def || 5;

        // 技能伤害随机范围从配置读取（与 damage_random_range/offset 复用，避免新增配置项）
        const skillDmgRange = combatConfig.damage_random_range ?? 15;
        const skillDmgOffset = combatConfig.damage_random_offset ?? 7;
        let damage = Math.floor(playerAtk * (combatConfig.skill_damage_multiplier ?? 1.5) - monsterDef + Math.floor(Math.random() * skillDmgRange) - skillDmgOffset);
        damage = Math.max(1, damage);

        battle.player_mp = safeBigInt(battle.player_mp) - BigInt(skillMpCost);
        battle.monster_hp = safeBigInt(battle.monster_hp) - BigInt(damage);
        battle.damage_dealt = safeBigInt(battle.damage_dealt) + BigInt(damage);

        appendBattleLog(battle, {
            round: battle.round,
            attacker: 'player',
            action: 'skill',
            skill_index: skillIndex,
            damage: damage,
            target_hp: safeBigInt(battle.monster_hp).toString(),
            timestamp: new Date().toISOString()
        });

        const battleResult = await this.checkBattleEnd(battle, player);
        if (battleResult) {
            return battleResult;
        }

        battle.is_player_turn = false;
        battle.turn = 'monster';
        battle.last_action_time = new Date();
        await battle.save();

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            action: 'skill',
            damage: damage,
            mp_used: skillMpCost,
            monster_hp: safeBigInt(battle.monster_hp).toString(),
            player_mp: safeBigInt(battle.player_mp).toString(),
            turn: 'monster',
            message: `你对 ${battle.monster_name} 使用了技能，造成 ${damage} 点伤害！`
        };
    }

    /**
     * 获取战斗统计
     */
    static async getCombatStats(playerId) {
        const battles = await PlayerCombat.findAll({
            where: { player_id: playerId }
        });

        const victories = battles.filter(b => b.battle_result === 'win').length;
        const defeats = battles.filter(b => b.battle_result === 'lose').length;
        const escapes = battles.filter(b => b.battle_result === 'flee').length;
        const totalExp = battles.reduce((sum, b) => sum + Number(safeBigInt(b.rewards_exp)), 0);

        return {
            victories,
            defeats,
            escapes,
            total_battles: battles.length,
            total_exp: totalExp,
            win_rate: battles.length > 0 ? Math.round((victories / battles.length) * 100) : 0,
            recent_battles: battles.slice(0, 5).map(b => ({
                id: b.id,
                monster_name: b.monster_name,
                result: b.battle_result,
                exp: safeBigInt(b.rewards_exp).toString(),
                time: b.created_at
            }))
        };
    }

    /**
     * 使用物品（战斗中使用）
     * @param {number} playerId - 玩家ID
     * @param {string} itemId - 物品ID
     * @param {number} quantity - 使用数量，默认为1
     * @returns {object} 使用结果
     */
    static async useItem(playerId, itemId, quantity = 1) {
        if (!itemId) {
            throw new AppError('物品ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询玩家和物品
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const item = await Item.findOne({
            where: { player_id: playerId, item_key: itemId }
        });

        if (!item || item.quantity < quantity) {
            throw new AppError('物品数量不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 获取物品配置
        const ItemConfigLoader = require('../../config/ItemConfigLoader');
        const itemConfig = await ItemConfigLoader.getItem(itemId);
        if (!itemConfig || itemConfig.type !== 'consumable') {
            throw new AppError('该物品不可使用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 应用物品效果
        const effect = itemConfig.effect || {};
        let message = '使用物品成功';

        if (effect.hp_restore) {
            const hpMax = this.getPlayerStat(player, 'hp_max', 100);
            const restoreAmount = Math.min(
                effect.hp_restore * quantity,
                hpMax - Number(safeBigInt(player.hp_current))
            );
            player.hp_current = safeBigInt(player.hp_current) + BigInt(restoreAmount);
            message += `，恢复 ${restoreAmount} 气血`;
        }

        if (effect.mp_restore) {
            const mpMax = this.getPlayerStat(player, 'mp_max', 0);
            const restoreAmount = Math.min(
                effect.mp_restore * quantity,
                mpMax - Number(safeBigInt(player.mp_current))
            );
            player.mp_current = safeBigInt(player.mp_current) + BigInt(restoreAmount);
            message += `，恢复 ${restoreAmount} 灵力`;
        }

        // 更新物品数量
        item.quantity -= quantity;
        if (item.quantity <= 0) {
            await item.destroy();
        } else {
            await item.save();
        }

        // 保存玩家属性
        await player.save();

        return {
            message: message,
            player_hp: safeBigInt(player.hp_current).toString(),
            player_mp: safeBigInt(player.mp_current).toString()
        };
    }

    /**
     * 清理过期战斗
     * 在玩家登录时调用，删除 expires_at 已过期的战斗记录
     * 解决"一进游戏就显示战斗"的遗留问题
     * @param {number} playerId - 玩家ID
     * @returns {number} 清理的战斗数量
     */
    static async cleanExpiredBattles(playerId) {
        const deletedCount = await ActiveBattle.destroy({
            where: {
                player_id: playerId,
                expires_at: { [require('sequelize').Op.lt]: new Date() }
            }
        });
        return deletedCount;
    }
}

module.exports = CombatService;
