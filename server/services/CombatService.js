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
        const playerLevel = this.getPlayerLevel(player);
        const levelMultiplier = 0.8 + (playerLevel * 0.1);

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
        const realmOrder = [
            '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
            '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
            '炼气11层', '炼气12层', '炼气13层', '炼气圆满',
            '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
            '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
            '元婴期', '元婴初期', '元婴中期', '元婴后期', '元婴圆满',
            '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '真仙'
        ];
        return realmOrder.indexOf(player.realm) + 1;
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
        const playerStats = player.attributes || {};
        const playerAtk = playerStats.atk || 10;
        const playerDef = playerStats.def || 5;
        const playerSpd = playerStats.speed || 10;
        const monsterDef = battle.monster_data?.def || 5;

        let damage = Math.max(1, playerAtk - monsterDef + Math.floor(Math.random() * 10) - 5);
        
        if (action === 'skill' && player.mp_current >= 20) {
            damage = Math.floor(damage * 1.5);
            battle.player_mp = BigInt(battle.player_mp) - BigInt(20);
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
        const playerStats = player.attributes || {};
        const playerDef = playerStats.def || 5;

        const monsterData = battle.monster_data;
        let damage = Math.max(1, monsterData.atk - playerDef + Math.floor(Math.random() * 6) - 3);

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

        const escapeChance = 0.5;
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
            const currentExp = BigInt(player.exp);
            const penaltyExp = currentExp * 5n / 100n;
            player.exp = currentExp - penaltyExp;
            player.hp_current = Math.max(100, Math.floor(Number(player.hp_max) * 0.3));
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
    static async getBattleStatus(playerId) {
        const battle = await ActiveBattle.findOne({
            where: { player_id: playerId }
        });

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

        const player = await Player.findByPk(playerId);
        if (player.mp_current < 20) {
            throw new Error('灵力不足，需要 20 点灵力');
        }

        const playerStats = player.attributes || {};
        const playerAtk = playerStats.atk || 10;
        const playerDef = playerStats.def || 5;
        const monsterDef = battle.monster_data?.def || 5;

        let damage = Math.floor(playerAtk * 1.5 - monsterDef + Math.floor(Math.random() * 15) - 7);
        damage = Math.max(1, damage);

        battle.player_mp = BigInt(battle.player_mp) - BigInt(20);
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
}

module.exports = CombatService;
