/**
 * 战斗服务
 * 
 * 处理怪物战斗逻辑
 */
const sequelize = require('../config/database');
const ActiveBattle = require('../models/activeBattle');
const PlayerCombat = require('../models/playerCombat');
const Player = require('../models/player');
const Item = require('../models/item');
const MapConfigLoader = require('./MapConfigLoader');
const DropLoader = require('./DropLoader');
const RealmService = require('../modules/core/RealmService');
const configLoader = require('../modules/infrastructure/ConfigLoader');

class CombatService {
    /**
     * 遭遇怪物
     */
    static async encounter(playerId, monsterId = null) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new Error('玩家不存在');
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
                    hp: activeBattle.monster_hp.toString(),
                    max_hp: activeBattle.monster_max_hp.toString()
                },
                player: {
                    hp: activeBattle.player_hp.toString(),
                    mp: activeBattle.player_mp.toString()
                },
                round: activeBattle.round,
                turn: activeBattle.turn,
                battle_log: activeBattle.battle_log.slice(-5)
            };
        }

        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        if (!mapConfig || !mapConfig.monsters || mapConfig.monsters.length === 0) {
            throw new Error('当前地图没有怪物');
        }

        let selectedMonster;
        if (monsterId) {
            selectedMonster = mapConfig.monsters.find(m => m.id === monsterId);
            if (!selectedMonster) {
                throw new Error('该怪物在当前地图中不存在');
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
            player_hp: player.hp_current,
            player_mp: player.mp_current,
            monster_hp: monsterData.max_hp,
            monster_max_hp: monsterData.max_hp,
            is_player_turn: true,
            expires_at: new Date(Date.now() + 30 * 60 * 1000)
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
                hp: player.hp_current.toString(),
                mp: player.mp_current.toString()
            },
            round: 1,
            turn: 'player',
            message: `遭遇 ${selectedMonster.name}！`
        };
    }

    /**
     * 生成怪物数据（根据玩家等级调整）
     */
    static generateMonsterData(monsterConfig, player) {
        const systemConfig = configLoader.getConfig('system');
        const combatCfg = systemConfig?.combat || { monster_stat_multiplier_base: 0.8, monster_stat_multiplier_per_level: 0.1 };
        
        const playerLevel = this.getPlayerLevel(player);
        const levelMultiplier = combatCfg.monster_stat_multiplier_base + (playerLevel * combatCfg.monster_stat_multiplier_per_level);

        return {
            id: monsterConfig.id,
            name: monsterConfig.name,
            realm: monsterConfig.realm,
            max_hp: Math.floor(100 * levelMultiplier),
            hp: Math.floor(100 * levelMultiplier),
            atk: Math.floor(15 * levelMultiplier),
            def: Math.floor(5 * levelMultiplier),
            speed: Math.floor(10 * levelMultiplier),
            exp_reward: monsterConfig.exp || 10
        };
    }

    /**
     * 获取玩家等级（基于境界）
     */
    static getPlayerLevel(player) {
        const realm = RealmService.getRealmByName(player.realm);
        return realm ? realm.rank : 1;
    }

    /**
     * 玩家攻击
     */
    static async attack(playerId, action = 'attack') {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

        if (!battle) {
            throw new Error('没有正在进行的战斗');
        }

        if (!battle.is_player_turn) {
            throw new Error('还未轮到你的回合');
        }

        const player = await Player.findByPk(playerId);
        const systemConfig = configLoader.getConfig('system');
        const combatCfg = systemConfig?.combat || { 
            player_damage_variance: { min: -5, max: 4 }, 
            skill_mp_cost: 20, 
            skill_damage_multiplier: 1.5 
        };

        const playerStats = player.attributes || {};
        const playerAtk = playerStats.atk || 10;
        const playerDef = playerStats.def || 5;
        const playerSpd = playerStats.speed || 10;
        const monsterDef = battle.monster_data?.def || 5;

        const variance = combatCfg.player_damage_variance;
        const varianceValue = Math.floor(Math.random() * (variance.max - variance.min + 1)) + variance.min;
        let damage = Math.max(1, playerAtk - monsterDef + varianceValue);
        
        if (action === 'skill' && player.mp_current >= combatCfg.skill_mp_cost) {
            damage = Math.floor(damage * combatCfg.skill_damage_multiplier);
            battle.player_mp = BigInt(battle.player_mp) - BigInt(combatCfg.skill_mp_cost);
        }

        battle.monster_hp = BigInt(battle.monster_hp) - BigInt(damage);
        battle.damage_dealt = BigInt(battle.damage_dealt) + BigInt(damage);

        const logEntry = {
            round: battle.round,
            attacker: 'player',
            action: action,
            damage: damage,
            target_hp: battle.monster_hp.toString(),
            timestamp: new Date().toISOString()
        };
        battle.battle_log.push(logEntry);

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
            monster_hp: battle.monster_hp.toString(),
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
        const systemConfig = configLoader.getConfig('system');
        const combatCfg = systemConfig?.combat || { monster_damage_variance: { min: -3, max: 2 } };

        const playerStats = player.attributes || {};
        const playerDef = playerStats.def || 5;

        const monsterData = battle.monster_data;
        const variance = combatCfg.monster_damage_variance;
        const varianceValue = Math.floor(Math.random() * (variance.max - variance.min + 1)) + variance.min;
        let damage = Math.max(1, monsterData.atk - playerDef + varianceValue);

        battle.player_hp = BigInt(battle.player_hp) - BigInt(damage);
        battle.damage_received = BigInt(battle.damage_received) + BigInt(damage);

        const logEntry = {
            round: battle.round,
            attacker: 'monster',
            action: 'attack',
            damage: damage,
            target_hp: battle.player_hp.toString(),
            timestamp: new Date().toISOString()
        };
        battle.battle_log.push(logEntry);

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
            player_hp: battle.player_hp.toString(),
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
            throw new Error('没有正在进行的战斗');
        }

        const systemConfig = configLoader.getConfig('system');
        const escapeChance = systemConfig?.combat?.escape_chance || 0.5;
        const success = Math.random() < escapeChance;

        if (success) {
            const player = await Player.findByPk(playerId);
            const logEntry = {
                round: battle.round,
                attacker: 'player',
                action: 'flee',
                success: true,
                timestamp: new Date().toISOString()
            };
            battle.battle_log.push(logEntry);

            await this.saveBattleRecord(battle, player, 'flee', null);
            await battle.destroy();

            return {
                success: true,
                message: '成功逃跑！'
            };
        } else {
            const logEntry = {
                round: battle.round,
                attacker: 'player',
                action: 'flee',
                success: false,
                timestamp: new Date().toISOString()
            };
            battle.battle_log.push(logEntry);
            battle.is_player_turn = false;
            battle.turn = 'monster';
            battle.last_action_time = new Date();
            await battle.save();

            return {
                success: false,
                message: '逃跑失败！'
            };
        }
    }

    /**
     * 检查战斗是否结束
     */
    static async checkBattleEnd(battle, player) {
        if (battle.monster_hp <= 0n) {
            const dropResult = DropLoader.rollDrop(battle.monster_id);
            
            const gainedExp = dropResult.exp;
            player.exp = BigInt(player.exp) + BigInt(gainedExp);

            const gainedItems = [];
            for (const item of dropResult.items) {
                const [itemRecord] = await Item.upsert({
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

            const logEntry = {
                round: battle.round,
                attacker: 'player',
                action: 'victory',
                exp: gainedExp,
                items: gainedItems,
                timestamp: new Date().toISOString()
            };
            battle.battle_log.push(logEntry);

            await this.saveBattleRecord(battle, player, 'win', { exp: gainedExp, items: gainedItems });
            await battle.destroy();

            return {
                in_battle: false,
                result: 'win',
                message: `击败 ${battle.monster_name}！获得 ${gainedExp} 修为`,
                rewards: {
                    exp: gainedExp,
                    items: gainedItems
                }
            };
        }

        if (battle.player_hp <= 0n) {
            const systemConfig = configLoader.getConfig('system');
            const combatCfg = systemConfig?.combat || { death_exp_penalty_percent: 5, revive_hp_percent: 30 };
            
            const currentExp = BigInt(player.exp);
            const penaltyExp = currentExp * BigInt(combatCfg.death_exp_penalty_percent) / 100n;
            player.exp = currentExp - penaltyExp;
            player.hp_current = Math.max(100, Math.floor(Number(player.hp_max) * (combatCfg.revive_hp_percent / 100)));
            await player.save();

            const logEntry = {
                round: battle.round,
                attacker: 'monster',
                action: 'defeat',
                penalty_exp: penaltyExp.toString(),
                timestamp: new Date().toISOString()
            };
            battle.battle_log.push(logEntry);

            await this.saveBattleRecord(battle, player, 'lose', { penalty_exp: penaltyExp.toString() });
            await battle.destroy();

            return {
                in_battle: false,
                result: 'lose',
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
            damage_dealt: battle.damage_dealt,
            damage_received: battle.damage_received,
            hp_remaining: battle.player_hp,
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
        const playerStats = player.attributes || {};
        const playerMaxHp = playerStats.hp_max || 100;
        const playerMaxMp = playerStats.mp_max || 0;

        return {
            in_battle: true,
            battle_id: battle.battle_uuid,
            monster: {
                id: battle.monster_id,
                name: battle.monster_name,
                realm: battle.monster_data?.realm || '炼气期',
                hp: battle.monster_hp.toString(),
                max_hp: battle.monster_max_hp.toString(),
                atk: battle.monster_data?.atk?.toString() || '10',
                def: battle.monster_data?.def?.toString() || '5',
                exp_reward: battle.monster_data?.exp_reward || 10
            },
            player: {
                hp: battle.player_hp.toString(),
                max_hp: playerMaxHp.toString(),
                mp: battle.player_mp.toString(),
                max_mp: playerMaxMp.toString()
            },
            round: battle.round,
            turn: battle.turn,
            battle_log: battle.battle_log.slice(-10)
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
            exp: b.rewards_exp.toString(),
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
            throw new Error('没有正在进行的战斗');
        }

        if (!battle.is_player_turn) {
            throw new Error('还未轮到你的回合');
        }

        const systemConfig = configLoader.getConfig('system');
        const combatCfg = systemConfig?.combat || { skill_mp_cost: 20, skill_damage_multiplier: 1.5 };
        
        const player = await Player.findByPk(playerId);
        if (player.mp_current < combatCfg.skill_mp_cost) {
            throw new Error(`灵力不足，需要 ${combatCfg.skill_mp_cost} 点灵力`);
        }

        const playerStats = player.attributes || {};
        const playerAtk = playerStats.atk || 10;
        const playerDef = playerStats.def || 5;
        const monsterDef = battle.monster_data?.def || 5;

        let damage = Math.floor(playerAtk * combatCfg.skill_damage_multiplier - monsterDef + Math.floor(Math.random() * 15) - 7);
        damage = Math.max(1, damage);

        battle.player_mp = BigInt(battle.player_mp) - BigInt(combatCfg.skill_mp_cost);
        battle.monster_hp = BigInt(battle.monster_hp) - BigInt(damage);
        battle.damage_dealt = BigInt(battle.damage_dealt) + BigInt(damage);

        const logEntry = {
            round: battle.round,
            attacker: 'player',
            action: 'skill',
            skill_index: skillIndex,
            damage: damage,
            target_hp: battle.monster_hp.toString(),
            timestamp: new Date().toISOString()
        };
        battle.battle_log.push(logEntry);

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
            mp_used: 20,
            monster_hp: battle.monster_hp.toString(),
            player_mp: battle.player_mp.toString(),
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
        const totalExp = battles.reduce((sum, b) => sum + Number(b.rewards_exp), 0);

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
                exp: b.rewards_exp.toString(),
                time: b.created_at
            }))
        };
    }

    static async useItem(playerId, itemId, quantity = 1) {
        if (!itemId) {
            const err = new Error('物品ID不能为空');
            err.status = 400;
            throw err;
        }

        const qty = Math.max(1, parseInt(quantity, 10) || 1);

        const player = await Player.findByPk(playerId);
        if (!player) {
            const err = new Error('玩家不存在');
            err.status = 404;
            throw err;
        }

        const item = await Item.findOne({
            where: { player_id: playerId, item_key: itemId }
        });

        if (!item || item.quantity < qty) {
            const err = new Error('物品数量不足');
            err.status = 400;
            throw err;
        }

        const itemConfig = configLoader.getConfig('item_data')?.items?.find(i => i.id === itemId);
        if (!itemConfig || itemConfig.type !== 'consumable') {
            const err = new Error('该物品不可使用');
            err.status = 400;
            throw err;
        }

        const effect = itemConfig.effect || {};
        let message = '使用物品成功';

        if (effect.hp_restore) {
            const restoreAmount = Math.min(
                Number(effect.hp_restore) * qty,
                Math.max(0, Number(player.hp_max) - Number(player.hp_current))
            );
            player.hp_current = BigInt(Number(player.hp_current) + restoreAmount);
            message += `，恢复 ${restoreAmount} 气血`;
        }

        if (effect.mp_restore) {
            const mpMax = Number(player.attributes?.mp_max || 0);
            const restoreAmount = Math.min(
                Number(effect.mp_restore) * qty,
                Math.max(0, mpMax - Number(player.mp_current))
            );
            player.mp_current = BigInt(Number(player.mp_current) + restoreAmount);
            message += `，恢复 ${restoreAmount} 灵力`;
        }

        item.quantity -= qty;
        if (item.quantity <= 0) {
            await item.destroy();
        } else {
            await item.save();
        }

        await player.save();

        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });
        if (battle) {
            battle.player_hp = player.hp_current;
            battle.player_mp = player.mp_current;
            await battle.save();
        }

        return {
            message: message,
            player_hp: player.hp_current.toString(),
            player_mp: player.mp_current.toString()
        };
    }

    static async getMonsters(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            const err = new Error('Player not found');
            err.status = 404;
            throw err;
        }

        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        if (!mapConfig || !mapConfig.monsters) {
            return {
                map_id: player.current_map_id,
                monsters: []
            };
        }

        const monsters = mapConfig.monsters.map(m => ({
            id: m.id,
            name: m.name,
            realm: m.realm,
            exp: m.exp
        }));

        return {
            map_id: player.current_map_id,
            monsters: monsters
        };
    }
}

module.exports = CombatService;
