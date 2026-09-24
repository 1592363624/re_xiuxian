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
const ArtifactDeepLineService = require('./ArtifactDeepLineService');
const CombatResolver = require('../combat/CombatResolver');
// 怪物属性块：整份递给结算（攻守两侧同构），不再只挑 def/atk 一个字段
const { buildMonsterStats, monsterCombatStats } = require('../combat/MonsterStats');
// 引入 InventoryService：战斗掉落物品通过统一的 addItem 方法入包（正确累加数量）
// 修复关键Bug：此前使用 Item.upsert 会替换已有物品数量而非累加，导致玩家丢失原有物品
const InventoryService = require('./InventoryService');
const { withItemNames } = require('../items/itemNaming');
const { grantItems } = require('../items/itemGrant');
const { infrastructure } = require('../../modules');
const { applyExpPenalty } = require('../core/deathPenalty');
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
 * 吸血回血：把 CombatResolver 结算出的 lifesteal 记到战斗内的玩家 HP 上，封顶到气血上限。
 * 返回实际回复量（0 表示本回合没有吸血），调用方据此写战斗日志。
 */
function applyLifesteal(battle, strike, maxHp) {
    const heal = Number(strike?.lifesteal) || 0;
    if (heal <= 0) return 0;
    const before = safeBigInt(battle.player_hp);
    const cap = safeBigInt(Math.floor(Number(maxHp) || 0));
    const next = cap > 0n ? (before + BigInt(heal) > cap ? cap : before + BigInt(heal)) : before + BigInt(heal);
    battle.player_hp = next;
    return Number(next - before);
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

/**
 * 布尔归一：MySQL BOOLEAN / SQLite 0|1 / 旧残留字符串都可能进到这里。
 * 攻击入口只认严格 true 才放行，否则会把 1 当 false、把 'true' 当 true，回合锁形同虚设。
 */
function isPlayersTurn(battle) {
    const v = battle?.is_player_turn;
    return v === true || v === 1 || v === '1' || v === 'true';
}

class CombatService {
    /**
     * 遭遇怪物
     * 事务包裹：创建 ActiveBattle + 恢复 HP 必须原子性
     * 行级锁：防止并发 encounter 创建多条 ActiveBattle（player_id 唯一约束会冲突）
     */
    static async encounter(playerId, monsterId = null) {
        // 状态机互斥校验：战斗与其他 exclusive 状态互斥（闭关/移动/历练/封禁）
        // 在事务外执行，避免长时间持锁
        const PlayerStateMachine = require('../state/PlayerStateMachine');
        const stateCheck = await PlayerStateMachine.canStart(playerId, PlayerStateMachine.PlayerState.IN_BATTLE);
        if (!stateCheck.allowed) {
            throw new AppError(stateCheck.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家行，防止并发 encounter/attack/flee 导致状态错乱
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 兜底：如果玩家 HP <= 0（之前战斗死亡未恢复），先恢复到安全值再开始战斗
            // 避免一进入战斗就立即被判失败
            const currentHp = safeBigInt(player.hp_current);
            if (currentHp <= 0n) {
                // 上限取完整解析结果，和玩家面板一致（attributes 里的 hp_max 是建号时的陈旧值）
                const playerHpMax = (await CombatResolver.resolveCombatStats(player)).stats.hp_max ?? 100;
                const deathMinHp = getGameBalanceConfig().combat?.death_min_hp ?? 10;
                const deathRecoveryRate = getGameBalanceConfig().combat?.death_hp_recovery_rate ?? 0.3;
                player.hp_current = BigInt(Math.max(deathMinHp, Math.floor(playerHpMax * deathRecoveryRate)));
                await player.save({ transaction: t });
                console.log(`[Combat] 玩家 ${playerId} HP 为 0，遭遇前恢复至 ${player.hp_current}`);
            }

            // 行级锁查询 ActiveBattle，防止并发创建
            const activeBattle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (activeBattle) {
                await t.commit();
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
                    is_player_turn: isPlayersTurn(activeBattle),
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

            // 获取出战灵兽属性加成（灵兽参与战斗的核心集成点）
            // 加成 HP 会叠加到战斗初始 HP 上，使灵兽成为玩家战力的有机组成
            // 注意：灵兽加成查询是只读 SELECT，在事务内执行不影响锁语义
            const SpiritBeastService = require('./SpiritBeastService');
            const beastBonus = await SpiritBeastService.getActiveBeastBonus(playerId);
            const beastHpBonus = BigInt(beastBonus.hp_max || 0);
            const beastMpBonus = BigInt(beastBonus.mp_max || 0);

            // 获取出战傀儡属性加成（傀儡工坊·大衍诀·控傀 解锁的战斗加成）
            // 出战傀儡按 battle_stat_ratio（30%）提供额外 HP，叠加到战斗初始 HP
            // 注意：傀儡加成查询是只读 SELECT，在事务内执行不影响锁语义
            const PuppetService = require('./PuppetService');
            let puppetHpBonus = 0n;
            try {
                const puppetBonus = await PuppetService.getBattlePuppetBonus(playerId);
                if (puppetBonus) {
                    puppetHpBonus = BigInt(puppetBonus.hp || 0);
                }
            } catch (e) {
                // PuppetService 未初始化或查询失败时静默降级，不影响战斗主流程
                console.warn('[CombatService] 傀儡加成查询失败，降级处理:', e.message);
            }

            const battle = await ActiveBattle.create({
                player_id: playerId,
                monster_id: selectedMonster.id,
                monster_name: selectedMonster.name,
                monster_data: monsterData,
                map_id: player.current_map_id,
                battle_type: 'normal',
                round: 1,
                turn: 'player',
                // 战斗初始 HP/MP = 玩家当前 HP/MP + 灵兽加成 + 傀儡加成（出战傀儡额外提供生命值）
                player_hp: safeBigInt(player.hp_current) + beastHpBonus + puppetHpBonus,
                player_mp: safeBigInt(player.mp_current) + beastMpBonus,
                monster_hp: monsterData.max_hp,
                monster_max_hp: monsterData.max_hp,
                is_player_turn: true,
                // 战斗过期时间从配置读取，避免硬编码
                expires_at: new Date(Date.now() + (getGameBalanceConfig().combat?.battle_expire_minutes ?? 30) * 60 * 1000)
            }, { transaction: t });

            await t.commit();

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
                is_player_turn: true,
                message: `遭遇 ${selectedMonster.name}！`
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 生成怪物数据（根据玩家等级调整）
     * 通过懒加载函数读取配置，避免模块加载时配置未初始化的问题
     */
    static generateMonsterData(monsterConfig, player) {
        // 数值口径集中在 game/combat/MonsterStats：全局曲线 × 玩家境界浮动，
        // 再叠加内容里给这只怪声明的属性（stats / power_multiplier）
        const { combat } = getGameBalanceConfig();
        return buildMonsterStats(monsterConfig, {
            playerLevel: this.getPlayerLevel(player),
            combat
        });
    }

    /**
     * 获取玩家等级（基于境界）
     *
     * 修复 B1 bug：用 RealmService.getRealmRank 替代 REALM_ORDER.indexOf。
     * 旧逻辑 indexOf 在化神期及以上境界返回 -1，+1 后变成 0，等级计算错误。
     * 新逻辑直接返回 rank，与 realm_breakthrough.json 完全对齐。
     */
    static getPlayerLevel(player) {
        const RealmService = require('../core/RealmService');
        return RealmService.getRealmRank(player.realm);
    }

    /**
     * 玩家攻击
     * 事务包裹：扣血/扣蓝/写日志/回合切换必须原子性
     * 行级锁：防止 attack 与 monsterTurn 并发执行导致回合错乱
     */
    static async attack(playerId, action = 'attack') {
        const t = await sequelize.transaction();
        try {
            // 取锁次序按 game/persistence/lockOrder.js 口径：players 先于 active_battles。
            // 改造前先锁战斗行再锁玩家行，与 encounter 反向，双击遭遇 + 一次出手就能凑出 ABBA 环。
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!battle) {
                throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 自愈：旧版把回合切给怪物后依赖客户端再调 /monster-turn，
            // 客户端一旦没调（或刷新丢失），is_player_turn 永远 false，玩家再也打不出下一招。
            // 这里先补结算残留的怪物回合，再继续玩家出招，避免战斗卡死。
            let recoveredMonsterAction = null;
            if (!isPlayersTurn(battle)) {
                recoveredMonsterAction = await this._applyMonsterStrike(battle, player, t);
                if (recoveredMonsterAction.battleResult) {
                    await t.commit();
                    await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                        battle_type: 'pve',
                        is_win: recoveredMonsterAction.battleResult.result === 'win'
                    });
                    return {
                        ...recoveredMonsterAction.battleResult,
                        recovered_monster_action: recoveredMonsterAction.summary
                    };
                }
            }

            // 参战属性统一解析（境界+灵根+加点+天赋+称号+装备+灵兽+功法+法宝+傀儡）。
            // 改造前这里读的是 attributes.atk 这份陈旧快照，再手工补灵兽/傀儡两块，
            // 装备与功法根本不参与 PVE 伤害——面板 480 攻、实际按 25 收结算。
            const attacker = await CombatResolver.resolveCombatStats(player);
            const balanceConfig = getGameBalanceConfig();
            const combatConfig = balanceConfig.combat || {};
            const monsterStats = monsterCombatStats(battle.monster_data);

            // 技能分支：仅当 action=skill 且战斗内灵力足够时改走技能公式并扣灵力。
            // 灵力以战斗内 battle.player_mp 为准（含灵兽加成），不再读 players.mp_current 陈旧列。
            const skillProfile = CombatResolver.selectSkillProfile(
                attacker.info?.technique_skills, 'player_skill'
            );
            const skillMpCost = combatConfig.skill_mp_cost ?? 20;
            const canSkill = action === 'skill' && safeBigInt(battle.player_mp) >= BigInt(skillMpCost);
            const strike = CombatResolver.computeDamage(canSkill ? skillProfile : 'player_basic', {
                attackerStats: attacker.stats,
                defenderStats: monsterStats,
                // 神通的战斗特效（额外伤害/破防）随出手方进入结算
                skills: attacker.info?.technique_skills,
                balanceConfig
            });
            let damage = strike.damage;

            if (canSkill) {
                battle.player_mp = safeBigInt(battle.player_mp) - BigInt(skillMpCost);
            }

            // 使用 safeBigInt 防御 null/undefined 导致 500
            battle.monster_hp = safeBigInt(battle.monster_hp) - BigInt(damage);
            battle.damage_dealt = safeBigInt(battle.damage_dealt) + BigInt(damage);
            // 吸血：按解析出的气血上限封顶（provider 已含灵兽/傀儡的 HP 贡献，与开局 HP 同口径）
            const hpBeforeHeal = safeBigInt(battle.player_hp);
            const healed = applyLifesteal(battle, strike, attacker.stats.hp_max);

            // 修复：使用 appendBattleLog 替代直接 push，确保 save 时写入数据库
            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: action,
                damage: damage,
                damage_profile: strike.profile,
                crit: !!strike.crit,
                missed: !!strike.missed,
                lifesteal: healed || undefined,
                player_hp: hpBeforeHeal.toString(),
                round_hp_after: safeBigInt(battle.player_hp).toString(),
                target_hp: safeBigInt(battle.monster_hp).toString(),
                timestamp: new Date().toISOString()
            });

            const playerAction = {
                action,
                damage,
                damage_profile: strike.profile,
                crit: !!strike.crit,
                missed: !!strike.missed,
                lifesteal: healed || undefined,
                player_hp: hpBeforeHeal.toString(),
                round_hp_after: safeBigInt(battle.player_hp).toString(),
                target_hp: safeBigInt(battle.monster_hp).toString(),
                monster_hp: safeBigInt(battle.monster_hp).toString(),
                player_mp: safeBigInt(battle.player_mp).toString()
            };

            // checkBattleEnd 在事务内执行，胜利/失败时修改 player 和 battle
            const battleResult = await this.checkBattleEnd(battle, player, t);
            if (battleResult) {
                await t.commit();
                // 大五行幻世轮：PVE 战斗结算后自动积累悟印（未装备时静默返回，不影响主流程）
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: battleResult.result === 'win'
                });
                return {
                    ...battleResult,
                    player_action: playerAction,
                    recovered_monster_action: recoveredMonsterAction?.summary || null
                };
            }

            // 同一请求内结算怪物回击：一次出招 = 一个完整回合，回合权回到玩家。
            // 改造前这里只把 turn 切成 monster，等客户端再调 /monster-turn；
            // 前端从未调用 → 怪物永远不出手，下一招被「还未轮到你的回合」挡住。
            const monsterStrike = await this._applyMonsterStrike(battle, player, t);
            if (monsterStrike.battleResult) {
                await t.commit();
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: monsterStrike.battleResult.result === 'win'
                });
                return {
                    ...monsterStrike.battleResult,
                    player_action: playerAction,
                    monster_action: monsterStrike.summary,
                    recovered_monster_action: recoveredMonsterAction?.summary || null
                };
            }

            battle.round += 1;
            battle.is_player_turn = true;
            battle.turn = 'player';
            battle.last_action_time = new Date();
            await battle.save({ transaction: t });

            await t.commit();

            const messages = [];
            messages.push(`你对 ${battle.monster_name} 造成了 ${damage} 点伤害！`);
            if (recoveredMonsterAction?.summary) {
                messages.push(recoveredMonsterAction.summary.message);
            }
            messages.push(monsterStrike.summary.message);

            return {
                in_battle: true,
                battle_id: battle.battle_uuid,
                action: action,
                damage: damage,
                monster_hp: safeBigInt(battle.monster_hp).toString(),
                player_hp: safeBigInt(battle.player_hp).toString(),
                player_mp: safeBigInt(battle.player_mp).toString(),
                turn: 'player',
                is_player_turn: true,
                round: battle.round,
                player_action: playerAction,
                monster_action: monsterStrike.summary,
                recovered_monster_action: recoveredMonsterAction?.summary || null,
                // 与旧 monster-turn 回执同名，护道展示/测试不必再下钻一层
                protect_info: monsterStrike.summary.protect_info,
                message: messages.join(' ')
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 结算怪物一记回击（必须在调用方事务内、且已持有 battle/player 行锁）
     *
     * 不负责切换 is_player_turn/round——由调用方在完整回合收尾时统一改，
     * 这样 attack/useSkill/flee 失败/独立 monster-turn 四条路径共用同一套伤害与特效。
     *
     * @returns {{battleResult?: object, summary: object}}
     */
    static async _applyMonsterStrike(battle, player, t) {
        const defender = await CombatResolver.resolveCombatStats(player);

        const monsterData = battle.monster_data || {};
        // 与玩家出手共用同一套公式与触发结算：怪物这一记同样会被玩家的闪避、
        // 神通格挡/减伤减免。改造前这里是第五份手写伤害公式，玩家的防御类特效对 PVE 完全无效。
        const monsterStrike = CombatResolver.computeDamage('monster_basic', {
            // 整块怪物属性：内容里给它声明 crit_rate/dodge_rate/lifesteal 就直接进结算，
            // 不用回来改这里（改造前只有 atk 一个字段，怪物永远不可能暴击）
            attackerStats: monsterCombatStats(monsterData),
            defenderStats: defender.stats,
            defenderSkills: defender.info?.technique_skills,
            balanceConfig: getGameBalanceConfig()
        });
        let damage = monsterStrike.damage;

        // ===== 洞府防御加成减免（与 WorldBossService 一致的断链接通模式）=====
        // getCaveDefenseBonus 返回玩家因洞府设施获得的受击伤害减免比例（0~max_bonus），
        // 由 CaveService 统一计算，避免防御逻辑散落在各战斗入口。
        // try-catch 兜底：洞府服务异常不影响 PVE 战斗主流程。
        let caveDefenseReduction = 0;
        try {
            // 懒加载 CaveService，避免与服务层循环依赖
            const CaveService = require('./CaveService');
            caveDefenseReduction = Number(await CaveService.getCaveDefenseBonus(player.id)) || 0;
            // 已被闪避/格挡的一记不再被"至少 1 点"下限抬回伤害
            if (caveDefenseReduction > 0 && damage > 0) {
                const reduced = Math.floor(damage * caveDefenseReduction);
                damage = Math.max(1, damage - reduced);
            }
        } catch (caveErr) {
            // 洞府减免查询失败不影响战斗主流程
            console.warn('[CombatService] 洞府防御减免查询异常:', caveErr.message);
        }

        // ===== 道侣护道判定（与 PvpService 一致的集成模式）=====
        // 设计文档 5.6.1：心契等级 L2 解锁护道，被攻击时有概率触发道侣远程护持
        // PVE 场景下护道反击伤害作用于怪物（道侣远程协助攻击怪物），区别于 PVP 反击攻击方玩家
        // try-catch 兜底：护道判定失败不影响战斗主流程
        let protectInfo = null;
        let counterDamageToMonster = 0;
        try {
            // 懒加载 DaoCompanionService，避免循环依赖
            const DaoCompanionService = require('./DaoCompanionService');
            const protectResult = await DaoCompanionService.tryProtect(
                player.id,
                damage,
                {
                    battleType: 'combat',               // 野外战斗场景
                    battleId: battle.battle_uuid,        // 战斗实例ID
                    battleRound: battle.round,           // 当前回合
                    attackerId: null,                    // PVE 中攻击方是怪物，无玩家ID
                    protectorAtk: 0,                     // 今天传 0 就等于"护道方不反击"（配置里没有 ATK 这项，接线与否见 #24 与 tests/DaoCompanionCounterLink.test.js）
                    transaction: t                       // 复用当前事务
                }
            );
            if (protectResult.triggered) {
                protectInfo = protectResult;
                // 被攻击方实际承受伤害（护道方分担了部分）
                damage = Number(protectResult.actual_damage_to_defender);
                // 反击伤害（怪物承受）
                counterDamageToMonster = Number(protectResult.counter_damage) || 0;
                if (counterDamageToMonster > 0) {
                    battle.monster_hp = safeBigInt(battle.monster_hp) - BigInt(counterDamageToMonster);
                }
            }
        } catch (protectErr) {
            // 护道判定失败不影响战斗主流程
            console.warn('[CombatService] 道侣护道判定异常:', protectErr.message);
        }

        battle.player_hp = safeBigInt(battle.player_hp) - BigInt(damage);
        battle.damage_received = safeBigInt(battle.damage_received) + BigInt(damage);

        appendBattleLog(battle, {
            round: battle.round,
            attacker: 'monster',
            action: 'attack',
            damage: damage,
            crit: !!monsterStrike.crit,
            missed: !!monsterStrike.missed,
            // 洞府防御减免比例（0 表示无减免），便于前端/日志展示减免来源
            cave_defense_reduction: Number(caveDefenseReduction.toFixed(4)),
            target_hp: safeBigInt(battle.player_hp).toString(),
            timestamp: new Date().toISOString()
        });

        // 护道触发时追加战斗日志（让玩家看到"道侣远程护持"反馈）
        if (protectInfo && protectInfo.triggered) {
            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'dao_companion',
                action: 'protect',
                shared_damage: protectInfo.shared_damage,
                counter_damage: counterDamageToMonster,
                monster_hp_after_counter: safeBigInt(battle.monster_hp).toString(),
                timestamp: new Date().toISOString()
            });
        }

        let message = `${battle.monster_name} 对你造成了 ${damage} 点伤害！`;
        if (protectInfo && protectInfo.triggered) {
            message += ` 道侣远程护持，分担 ${protectInfo.shared_damage} 点伤害`;
            if (counterDamageToMonster > 0) {
                message += `，反击怪物 ${counterDamageToMonster} 点伤害`;
            }
            message += '。';
        }

        const summary = {
            action: 'monster_attack',
            damage,
            crit: !!monsterStrike.crit,
            missed: !!monsterStrike.missed,
            cave_defense_reduction: Number(caveDefenseReduction.toFixed(4)),
            player_hp: safeBigInt(battle.player_hp).toString(),
            monster_hp: safeBigInt(battle.monster_hp).toString(),
            message,
            protect_info: protectInfo
        };

        const battleResult = await this.checkBattleEnd(battle, player, t);
        return { battleResult: battleResult || undefined, summary };
    }

    /**
     * 怪物行动（兼容入口 / 残留怪物回合恢复）
     *
     * 主流程已在 attack/useSkill 内完整结算怪物回击，正常客户端不再依赖本接口。
     * 保留原因：
     *   1) 旧前端/脚本仍按「玩家出手 → 再调 monster-turn」两段式驱动；
     *   2) 历史卡死战斗（is_player_turn=false）可由此口恢复。
     * 事务包裹：扣血/写日志/回合切换必须原子性
     * 行级锁：防止与 attack/flee 并发
     */
    static async monsterTurn(playerId) {
        const t = await sequelize.transaction();
        try {
            // 与 attack 同口径：players 先于 active_battles，不与 encounter 构成 ABBA 环
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!battle || isPlayersTurn(battle)) {
                await t.commit();
                return null;
            }

            const strike = await this._applyMonsterStrike(battle, player, t);
            if (strike.battleResult) {
                await t.commit();
                // 大五行幻世轮：PVE 战斗结算后自动积累悟印（未装备时静默返回，不影响主流程）
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: strike.battleResult.result === 'win'
                });
                return {
                    ...strike.battleResult,
                    monster_action: strike.summary
                };
            }

            battle.round += 1;
            battle.is_player_turn = true;
            battle.turn = 'player';
            battle.last_action_time = new Date();
            await battle.save({ transaction: t });

            await t.commit();

            return {
                in_battle: true,
                battle_id: battle.battle_uuid,
                action: 'monster_attack',
                damage: strike.summary.damage,
                player_hp: strike.summary.player_hp,
                monster_hp: strike.summary.monster_hp,
                turn: 'player',
                is_player_turn: true,
                round: battle.round,
                monster_action: strike.summary,
                message: strike.summary.message,
                // 护道信息透传给前端（前端可展示"道侣护持"特效）
                protect_info: strike.summary.protect_info
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 逃跑
     * 事务包裹：保存战斗记录 + 删除 ActiveBattle 必须原子性
     * 行级锁：防止与 attack/monsterTurn 并发
     */
    static async flee(playerId) {
        const t = await sequelize.transaction();
        try {
            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!battle) {
                throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const escapeChance = getGameBalanceConfig().combat?.escape_chance ?? 0.5;
            const success = Math.random() < escapeChance;

            // 与 attack 同锁序：players 先于 active_battles
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            if (success) {
                appendBattleLog(battle, {
                    round: battle.round,
                    attacker: 'player',
                    action: 'flee',
                    success: true,
                    timestamp: new Date().toISOString()
                });

                await this.saveBattleRecord(battle, player, 'flee', null, t);
                await battle.destroy({ transaction: t });

                await t.commit();

                // 大五行幻世轮：逃跑按失败处理积累悟印（未装备时静默返回）
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: false
                });

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
                // 逃跑失败 = 空过一招，怪物立刻回击并把回合交还玩家。
                // 改造前只把 turn 切成 monster，若客户端不再调 monster-turn 就永久卡死。
                const strike = await this._applyMonsterStrike(battle, player, t);
                if (strike.battleResult) {
                    await t.commit();
                    await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                        battle_type: 'pve',
                        is_win: strike.battleResult.result === 'win'
                    });
                    return {
                        success: false,
                        fled: false,
                        ...strike.battleResult,
                        monster_action: strike.summary,
                        message: `逃跑失败！${strike.summary.message}`
                    };
                }

                battle.round += 1;
                battle.is_player_turn = true;
                battle.turn = 'player';
                battle.last_action_time = new Date();
                await battle.save({ transaction: t });

                await t.commit();

                return {
                    success: false,
                    fled: false,
                    in_battle: true,
                    battle_id: battle.battle_uuid,
                    turn: 'player',
                    is_player_turn: true,
                    round: battle.round,
                    player_hp: strike.summary.player_hp,
                    monster_hp: strike.summary.monster_hp,
                    monster_action: strike.summary,
                    message: `逃跑失败！${strike.summary.message}`
                };
            }
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 放弃战斗（玩家主动脱离卡死的战斗，不保存战斗记录）
     * 使用场景：玩家有遗留的过期战斗记录，无法通过正常途径清除
     * 与 flee 的区别：flee 有概率失败且记录到战斗历史，abandon 直接清除不计入历史
     * 事务包裹：防止并发请求导致 destroy 失败
     */
    static async abandon(playerId) {
        const t = await sequelize.transaction();
        try {
            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!battle) {
                throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            await battle.destroy({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '已放弃战斗'
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 检查战斗是否结束
     * 接受 transaction 参数，在调用方事务内执行，保证原子性
     * @param {object} battle - 战斗实例（已加锁）
     * @param {object} player - 玩家实例（已加锁）
     * @param {object} t - sequelize 事务实例
     */
    static async checkBattleEnd(battle, player, t = null) {
        const transactionOptions = t ? { transaction: t } : {};

        if (safeBigInt(battle.monster_hp) <= 0n) {
            // 修复 B7：DropLoader.rollDrop 在怪物无掉落配置时返回 null，需要 null 防御
            // 否则下方 dropResult.exp 会抛 TypeError，导致战斗无法结束、玩家卡死在战斗状态
            const dropResult = DropLoader.rollDrop(battle.monster_id) || { exp: 0, items: [] };

            const gainedExp = dropResult.exp || 0;
            // 经验到账走列上原子加。以前是"读这份快照 + 算绝对值 + 整行 save()"，
            // 正确性全靠注释里那句"调用方已加锁"的口头约定 —— 同一时间别的流程（历练结算、闭关出定、
            // 丹药）给的修为会被这份绝对值写回抹掉，而两边看起来都返回了"获得了经验"。
            if (gainedExp) {
                const { patchPlayerState } = require('../persistence/PlayerStateStore');
                await patchPlayerState(player.id, { amounts: { exp: BigInt(gainedExp) } }, { transaction: t });
            }

            // 掉落逐件入包，只有真发到的才记进 gainedItems。
            // 原来无论 addItem 成败都 push 一条，背包满时玩家看到的"获得 X"其实什么都没拿到，
            // 战斗记录与历史里也留着一条不存在的收获。
            const grant = await grantItems(player.id, dropResult.items || [], t, { label: '战斗掉落' });
            const gainedItems = grant.granted.map(g => ({ item_id: g.item_key, quantity: g.quantity }));

            await player.save(transactionOptions);

            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: 'victory',
                exp: gainedExp,
                items: withItemNames(gainedItems),
                timestamp: new Date().toISOString()
            });

            await this.saveBattleRecord(battle, player, 'win', { exp: gainedExp, items: gainedItems }, t);
            await battle.destroy(transactionOptions);

            // 击杀计数进账（PVE 胜利这一次才算）。以前这个键只在 players.stats 的默认 JSON 里出现过，
            // 全仓没有任何一处往上涨，而成就又按 `player.kill_count`（players 没这列）去读 → 5 条杀敌成就恒为 0。
            // 计数键名与含义都声明在 config/player_metrics.json，事件点只说"发生了什么"。
            const PlayerStateStore = require('../persistence/PlayerStateStore');
            await PlayerStateStore.bumpStat(player, 'kill_count', 1, { transaction: t });
            // 天道凶名：按累计击杀同步称号（血手人屠…天道宿敌），进属性/战力
            try {
                const WorldEventsService = require('./WorldEventsService');
                const we = (player.attributes && player.attributes.world_events) || {};
                const kills = (Number(we.kills) || 0) + 1;
                const synced = WorldEventsService.syncNotoriousTitle(player, kills, { transaction: t });
                if (synced.changed) {
                    appendBattleLog(battle, {
                        round: battle.round,
                        attacker: 'system',
                        action: 'notorious_title',
                        title: synced.title && synced.title.name,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (e) {
                console.warn('[CombatService] 凶名同步失败（不影响战斗结算）:', e.message);
            }

            return {
                in_battle: false,
                victory: true,
                result: 'win',
                battleEnded: true,
                message: `击败 ${battle.monster_name}！获得 ${gainedExp} 修为`
                    + (grant.failed.length ? `（背包放不下，${grant.failed.length} 件掉落未获得）` : ''),
                rewards: {
                    exp: gainedExp,
                    items: withItemNames(gainedItems)
                }
            };
        }

        if (safeBigInt(battle.player_hp) <= 0n) {
            // 陨落扣修为走全仓唯一一份实现（列上原子减）；penaltyExp 只用于战报与回执
            const deathPenalty = await applyExpPenalty({ playerId: player.id, scope: 'combat', transaction: t, reason: 'PVE战斗身死' });
            const penaltyExp = deathPenalty.penalty;
            // hp_max 存储在 attributes JSON 字段中，需要从中读取
            const playerHpMax = (await CombatResolver.resolveCombatStats(player)).stats.hp_max ?? 100;
            const deathMinHp = getGameBalanceConfig().combat?.death_min_hp ?? 10;
            const deathRecoveryRate = getGameBalanceConfig().combat?.death_hp_recovery_rate ?? 0.3;
            player.hp_current = BigInt(Math.max(deathMinHp, Math.floor(playerHpMax * deathRecoveryRate)));
            await player.save(transactionOptions);

            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'monster',
                action: 'defeat',
                penalty_exp: penaltyExp.toString(),
                timestamp: new Date().toISOString()
            });

            await this.saveBattleRecord(battle, player, 'lose', { penalty_exp: penaltyExp.toString() }, t);
            await battle.destroy(transactionOptions);

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
     * 接受 transaction 参数，在调用方事务内执行，保证原子性
     * @param {object} battle - 战斗实例
     * @param {object} player - 玩家实例
     * @param {string} result - 战斗结果 win/lose/flee
     * @param {object} rewards - 奖励
     * @param {object|null} t - sequelize 事务实例
     */
    static async saveBattleRecord(battle, player, result, rewards, t = null) {
        const transactionOptions = t ? { transaction: t } : {};
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
        }, transactionOptions);
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
        const battleStats = await CombatResolver.resolveCombatStats(player);
        const playerMaxHp = battleStats.stats.hp_max ?? 100;
        const playerMaxMp = battleStats.stats.mp_max ?? 0;

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
            is_player_turn: isPlayersTurn(battle),
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
            items: withItemNames(b.rewards_items),
            time: b.created_at
        }));
    }

    /**
     * 使用技能
     * 事务包裹：扣蓝/扣血/写日志/回合切换必须原子性
     * 行级锁：防止与 attack/monsterTurn 并发
     */
    static async useSkill(playerId, skillIndex = 0) {
        const t = await sequelize.transaction();
        try {
            // 与 attack 同口径：players 先于 active_battles
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!battle) {
                throw new AppError('没有正在进行的战斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 与 attack 同一套自愈：残留怪物回合先补结算，避免「还未轮到你的回合」永久卡死
            let recoveredMonsterAction = null;
            if (!isPlayersTurn(battle)) {
                recoveredMonsterAction = await this._applyMonsterStrike(battle, player, t);
                if (recoveredMonsterAction.battleResult) {
                    await t.commit();
                    await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                        battle_type: 'pve',
                        is_win: recoveredMonsterAction.battleResult.result === 'win'
                    });
                    return {
                        ...recoveredMonsterAction.battleResult,
                        recovered_monster_action: recoveredMonsterAction.summary
                    };
                }
            }

            const combatConfig = getGameBalanceConfig().combat || {};
            const skillMpCost = combatConfig.skill_mp_cost ?? 20;

            // 灵力以战斗内池为准（含灵兽加成），与 attack 技能分支同口径
            if (safeBigInt(battle.player_mp) < BigInt(skillMpCost)) {
                throw new AppError(`灵力不足，需要 ${skillMpCost} 点灵力`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 与普攻共用同一套解析与公式（此前这里又抄了一遍灵兽/傀儡加成 + 独立的手写公式）
            const attacker = await CombatResolver.resolveCombatStats(player);
            const skills = attacker.info?.technique_skills;
            // 档位与 attack 的技能分支同源：神通声明了 damage_profile 就用它，
            // 否则同一个已领悟神通在"出招"和"使用神通"两个入口会打出两种伤害
            const strike = CombatResolver.computeDamage(
                CombatResolver.selectSkillProfile(skills, 'player_skill'), {
                attackerStats: attacker.stats,
                defenderStats: monsterCombatStats(battle.monster_data),
                skills,
                balanceConfig: getGameBalanceConfig()
            });
            const damage = strike.damage;

            battle.player_mp = safeBigInt(battle.player_mp) - BigInt(skillMpCost);
            battle.monster_hp = safeBigInt(battle.monster_hp) - BigInt(damage);
            battle.damage_dealt = safeBigInt(battle.damage_dealt) + BigInt(damage);
            const hpBeforeHeal = safeBigInt(battle.player_hp);
            const healed = applyLifesteal(battle, strike, attacker.stats.hp_max);

            appendBattleLog(battle, {
                round: battle.round,
                attacker: 'player',
                action: 'skill',
                skill_index: skillIndex,
                damage: damage,
                damage_profile: strike.profile,
                crit: !!strike.crit,
                missed: !!strike.missed,
                lifesteal: healed || undefined,
                player_hp: hpBeforeHeal.toString(),
                round_hp_after: safeBigInt(battle.player_hp).toString(),
                target_hp: safeBigInt(battle.monster_hp).toString(),
                timestamp: new Date().toISOString()
            });

            const playerAction = {
                action: 'skill',
                skill_index: skillIndex,
                damage,
                damage_profile: strike.profile,
                crit: !!strike.crit,
                missed: !!strike.missed,
                lifesteal: healed || undefined,
                player_hp: hpBeforeHeal.toString(),
                round_hp_after: safeBigInt(battle.player_hp).toString(),
                target_hp: safeBigInt(battle.monster_hp).toString(),
                monster_hp: safeBigInt(battle.monster_hp).toString(),
                player_mp: safeBigInt(battle.player_mp).toString()
            };

            const battleResult = await this.checkBattleEnd(battle, player, t);
            if (battleResult) {
                await t.commit();
                // 大五行幻世轮：PVE 战斗结算后自动积累悟印（未装备时静默返回，不影响主流程）
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: battleResult.result === 'win'
                });
                return {
                    ...battleResult,
                    player_action: playerAction,
                    recovered_monster_action: recoveredMonsterAction?.summary || null
                };
            }

            // 同请求内结算怪物回击，回合权回到玩家（见 attack 内注释）
            const monsterStrike = await this._applyMonsterStrike(battle, player, t);
            if (monsterStrike.battleResult) {
                await t.commit();
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: monsterStrike.battleResult.result === 'win'
                });
                return {
                    ...monsterStrike.battleResult,
                    player_action: playerAction,
                    monster_action: monsterStrike.summary,
                    recovered_monster_action: recoveredMonsterAction?.summary || null
                };
            }

            battle.round += 1;
            battle.is_player_turn = true;
            battle.turn = 'player';
            battle.last_action_time = new Date();
            await battle.save({ transaction: t });

            await t.commit();

            return {
                in_battle: true,
                battle_id: battle.battle_uuid,
                action: 'skill',
                damage: damage,
                mp_used: skillMpCost,
                monster_hp: safeBigInt(battle.monster_hp).toString(),
                player_mp: safeBigInt(battle.player_mp).toString(),
                player_hp: safeBigInt(battle.player_hp).toString(),
                turn: 'player',
                is_player_turn: true,
                round: battle.round,
                player_action: playerAction,
                monster_action: monsterStrike.summary,
                recovered_monster_action: recoveredMonsterAction?.summary || null,
                protect_info: monsterStrike.summary.protect_info,
                message: `你对 ${battle.monster_name} 使用了技能，造成 ${damage} 点伤害！ ${monsterStrike.summary.message}`
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
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
        const amount = Math.max(1, Math.floor(Number(quantity) || 1));

        // 玩家行与物品行必须在同一事务里一起加锁：
        // 旧实现两次无锁读 + 分别 save，双击"使用"会把同一瓶药喝两次、
        // 或者把 hp 按各自的旧值写回，后写的把先写的回复量覆盖掉。
        return sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const item = await Item.findOne({
                where: { player_id: playerId, item_key: itemId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!item || item.quantity < amount) {
                throw new AppError('物品数量不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 物品配置走 ItemService（旧代码 require 了一个并不存在的 config/ItemConfigLoader，
            // 结果这个接口每次调用都在 require 处抛错）
            const ItemService = require('../core/ItemService');
            const itemConfig = ItemService.getItemById(itemId);
            if (!itemConfig || itemConfig.type !== 'consumable') {
                throw new AppError('该物品不可使用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 回复上限用完整属性快照（含装备/功法），与玩家面板显示的上限一致；
            // 旧代码读 attributes 里的陈旧 hp_max，容易把回复量算小甚至算成 0。
            const AttributeService = require('../core/AttributeService');
            const { final } = await AttributeService.calculateFullAttributesAsync(player);

            // 战斗中的回复必须写进战斗内 HP/MP 池（UI 与伤害结算读的都是 battle.player_*）。
            // 改造前只写 players.hp_current，战斗血条纹丝不动，丹药等于白喝。
            const battle = await ActiveBattle.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            let message = '使用物品成功';
            const updates = {};
            const effect = itemConfig.effect || {};
            let battleHpGain = 0;
            let battleMpGain = 0;

            if (effect.hp_restore) {
                const restoreAmount = Math.max(0, Math.min(
                    effect.hp_restore * amount,
                    (final.hp_max || 0) - Number(safeBigInt(player.hp_current))
                ));
                updates.hp_current = Number(safeBigInt(player.hp_current)) + restoreAmount;
                if (restoreAmount > 0) message += `，恢复 ${restoreAmount} 气血`;
                if (battle) {
                    // 战斗池上限取 battle.player_hp 当前可能的上限（开局已含灵兽/傀儡加成），
                    // 用「当前值 + 回复」再与开局口径的 max 比较没有单独存列，这里按回复量直接加、
                    // 再用玩家面板上限兜底，避免无限堆血。
                    const before = safeBigInt(battle.player_hp);
                    const cap = safeBigInt(Math.max(Number(final.hp_max || 0), Number(before)));
                    let next = before + BigInt(Math.floor(restoreAmount));
                    if (next > cap) next = cap;
                    battle.player_hp = next;
                    battleHpGain = Number(next - before);
                }
            }

            if (effect.mp_restore) {
                const restoreAmount = Math.max(0, Math.min(
                    effect.mp_restore * amount,
                    (final.mp_max || 0) - Number(safeBigInt(player.mp_current))
                ));
                updates.mp_current = Number(safeBigInt(player.mp_current)) + restoreAmount;
                if (restoreAmount > 0) message += `，恢复 ${restoreAmount} 灵力`;
                if (battle) {
                    const before = safeBigInt(battle.player_mp);
                    const cap = safeBigInt(Math.max(Number(final.mp_max || 0), Number(before)));
                    let next = before + BigInt(Math.floor(restoreAmount));
                    if (next > cap) next = cap;
                    battle.player_mp = next;
                    battleMpGain = Number(next - before);
                }
            }

            // 消耗丹药（在已加锁的行上改，数量不会被并发改没）
            item.quantity -= amount;
            if (item.quantity <= 0) {
                await item.destroy({ transaction: t });
            } else {
                await item.save({ transaction: t });
            }

            if (battle) {
                appendBattleLog(battle, {
                    round: battle.round,
                    attacker: 'player',
                    action: 'use_item',
                    item_id: itemId,
                    quantity: amount,
                    hp_restore: battleHpGain,
                    mp_restore: battleMpGain,
                    target_hp: safeBigInt(battle.player_hp).toString(),
                    timestamp: new Date().toISOString()
                });
                await battle.save({ transaction: t });
            }

            // 玩家状态经补丁写入：只写 hp/mp 两列（同步镜像 attributes 里的同名键），
            // 不用旧实例整块回写 attributes
            const PlayerStateStore = require('../persistence/PlayerStateStore');
            const updated = await PlayerStateStore.patchPlayerState(
                playerId,
                { columns: updates },
                { transaction: t }
            );

            return {
                message: message,
                player_hp: safeBigInt(battle ? battle.player_hp : updated.hp_current).toString(),
                player_mp: safeBigInt(battle ? battle.player_mp : updated.mp_current).toString(),
                in_battle: !!battle,
                battle_id: battle?.battle_uuid || null
            };
        });
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
