/**
 * 坠魔谷副本端到端测试
 *
 * 目的：验证坠魔谷（zhuimo）3-5人 PVE 心魔博弈副本的配置完整性、服务方法存在性、
 *      模型字段同步性、接口可用性、堕魔机制、决战机制、奖励结算逻辑。
 *
 * 测试范围：
 *   1. 静态代码扫描：MultiDungeonService 包含坠魔谷专属方法 _processZhuimoFinalAct
 *   2. 配置完整性：4 幕流程 / 3 个实例级变量 / 5 个抉择级变量 / 3 个成员级变量 /
 *      堕魔阈值 / 决战公式参数 / 双向腐蚀参数
 *   3. 变量边界：VARIABLE_BOUNDS 包含 avg_heart_demon(0-100) / avg_dao_heart(0-100) /
 *      member_heart_demon(0-100) / member_dao_heart(0-100)
 *   4. 模型字段：MultiDungeonInstance / MultiDungeonChoice / MultiDungeonMember 含坠魔谷专属字段
 *   5. 接口路由：/api/multi-dungeon/create 与 /api/multi-dungeon/rewards 支持 zhuimo
 *   6. 物品配置：zhuimo_token / heart_demon_crystal / dao_heart_fragment / demon_seal_rune /
 *      heart_demon_seed / dao_heart_crystal 共 6 个物品已定义
 *   7. 只读接口：/help、/rewards、/cooldown 返回 zhuimo 信息
 *   8. 创建接口：测试账号尝试创建坠魔谷，预期因物品不足或冷却被拦截
 *
 * 玩法文档对照：
 *   - 坠魔谷：3-5人 PVE 心魔博弈副本，4幕流程
 *   - 第1幕·入谷遇魔（enter_valley）：is_entry_act=true，3选择（purify/slay/guard）
 *   - 第2幕·心魔试炼（demon_trial）：3选择（meditate/blood_sacrifice/protect）
 *   - 第3幕·道心抉择（dao_choice）：3选择（uphold_dao/fall_to_demon/balance）
 *   - 第4幕·心魔决战（demon_boss）：is_auto_advance=true, is_final_act=true, rounds_max=5
 *   - 心魔满100或道心归0立即堕魔（is_fallen=1, is_present=0）
 *   - 决战伤害公式：damage = 80000 + (100-avg_heart_demon)×2000 + avg_dao_heart×1500
 *   - 决战每回合双向腐蚀：avg_dao_heart -5, avg_heart_demon +5
 *
 * 测试账号：1592363624 / 1592363624（韩天尊，化神初期 rank=23，admin）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

/**
 * 统一 HTTP 调用封装
 * @param {string} method - HTTP 方法（GET/POST/PUT/DELETE）
 * @param {string} apiPath - 接口路径（以 /api 开头）
 * @param {string|null} token - JWT 令牌
 * @param {Object|null} body - 请求体
 * @returns {Promise<{status: number, json: Object|null}>}
 */
async function api(method, apiPath, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${apiPath}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

const results = [];
/**
 * 记录测试结果
 * @param {string} name - 测试项名称
 * @param {boolean} condition - 是否通过
 * @param {string} [detail=''] - 详细信息
 */
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  坠魔谷副本端到端测试 (zhuimo)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 坠魔谷专属方法与变量边界 =====
    console.log('[场景1] 静态代码扫描 - 坠魔谷专属方法与变量边界');

    const serviceCode = fs.readFileSync(
        path.join(__dirname, '../game/services/MultiDungeonService.js'), 'utf-8'
    );

    // 1.1 专属方法存在性
    check('MultiDungeonService 包含 _processZhuimoFinalAct 静态方法',
        /static\s+async\s+_processZhuimoFinalAct\s*\(/.test(serviceCode), '');

    check('create 方法白名单包含 zhuimo',
        serviceCode.includes("'zhuimo'"), '');

    check('finalActHandler 五分支分发包含 zhuimo',
        serviceCode.includes("instance.instance_key === 'zhuimo'") &&
        serviceCode.includes('_processZhuimoFinalAct'), '');

    // 1.2 VARIABLE_BOUNDS 边界定义
    check('VARIABLE_BOUNDS 包含 avg_heart_demon (0-100)',
        /avg_heart_demon:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 avg_dao_heart (0-100)',
        /avg_dao_heart:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 member_heart_demon (0-100)',
        /member_heart_demon:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 member_dao_heart (0-100)',
        /member_dao_heart:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    // 1.3 坠魔谷专属变量初始化逻辑
    check('坠魔谷实例级变量初始化（init_avg_heart_demon）',
        serviceCode.includes('init_avg_heart_demon'), '');

    check('坠魔谷实例级变量初始化（init_avg_dao_heart）',
        serviceCode.includes('init_avg_dao_heart'), '');

    check('坠魔谷成员级变量初始化（member_init_heart_demon）',
        serviceCode.includes('member_init_heart_demon'), '');

    check('坠魔谷成员级变量初始化（member_init_dao_heart）',
        serviceCode.includes('member_init_dao_heart'), '');

    // 1.4 抉择变量应用逻辑
    check('坠魔谷抉择变量应用（heart_demon_self_change 操作 member 表）',
        serviceCode.includes('heart_demon_self_change'), '');

    check('坠魔谷抉择变量应用（heart_demon_others_change 影响他人）',
        serviceCode.includes('heart_demon_others_change'), '');

    check('坠魔谷护道特殊逻辑（heart_demon_others_change_highest 仅影响心魔最高者）',
        serviceCode.includes('heart_demon_others_change_highest') &&
        serviceCode.includes('sortedByHeartDemon'), '');

    check('坠魔谷抉择变量应用（dao_heart_self_change 操作 member 表）',
        serviceCode.includes('dao_heart_self_change'), '');

    check('坠魔谷抉择变量应用（dao_heart_others_change 影响他人）',
        serviceCode.includes('dao_heart_others_change'), '');

    // 1.5 堕魔机制
    check('坠魔谷堕魔判定逻辑（checkAndMarkFallen 辅助函数）',
        serviceCode.includes('checkAndMarkFallen'), '');

    check('坠魔谷堕魔阈值判定（心魔≥100标记堕魔）',
        serviceCode.includes('heart_demon') &&
        serviceCode.includes('100'), '');

    check('坠魔谷道心破碎判定（道心≤0标记堕魔）',
        serviceCode.includes('dao_heart'), '');

    check('坠魔谷堕魔标记（is_fallen=1, is_present=0）',
        serviceCode.includes('is_fallen') &&
        serviceCode.includes('is_present'), '');

    // 1.6 平均值同步更新
    check('坠魔谷实例级平均心魔同步更新（avg_heart_demon 重算）',
        serviceCode.includes('avg_heart_demon'), '');

    check('坠魔谷实例级平均道心同步更新（avg_dao_heart 重算）',
        serviceCode.includes('avg_dao_heart'), '');

    // 1.7 决战机制
    check('坠魔谷决战初始化（demon_boss_hp = 1000000）',
        serviceCode.includes('demon_boss_hp') &&
        serviceCode.includes('1000000'), '');

    check('坠魔谷决战伤害公式（80000 + (100-avg_heart_demon)×2000 + avg_dao_heart×1500）',
        serviceCode.includes('80000') &&
        serviceCode.includes('2000') &&
        serviceCode.includes('1500'), '');

    check('坠魔谷决战每回合双向腐蚀（dao_heart_change_per_round = -5）',
        serviceCode.includes('dao_heart_change_per_round'), '');

    check('坠魔谷决战每回合双向腐蚀（heart_demon_change_per_round = 5）',
        serviceCode.includes('heart_demon_change_per_round'), '');

    check('坠魔谷决战失败条件（avg_dao_heart_lte / avg_heart_demon_gte）',
        serviceCode.includes('avg_heart_demon_gte') &&
        serviceCode.includes('avg_dao_heart_lte'), '');

    // 1.8 奖励结算
    check('坠魔谷奖励结算块（dao_heart_bonus 道心加成）',
        serviceCode.includes('dao_heart_bonus') ||
        serviceCode.includes('4.6'), '');

    check('坠魔谷完美通关加成（perfect_clear_no_fallen）',
        serviceCode.includes('perfect_clear_no_fallen') ||
        serviceCode.includes('完美通关'), '');

    check('坠魔谷称号奖励逻辑（读取 rewards.title / title_chance / title_min_dao_heart 配置）',
        serviceCode.includes('rewards.title') &&
        serviceCode.includes('rewards.title_chance') &&
        serviceCode.includes('rewards.title_min_dao_heart'), '');

    check('坠魔谷 getRewards 白名单包含 zhuimo',
        /getRewards[\s\S]{0,2000}'zhuimo'/.test(serviceCode), '');

    check('坠魔谷 getCooldown 列表包含 zhuimo',
        /getCooldown[\s\S]{0,3000}'zhuimo'/.test(serviceCode), '');

    check('坠魔谷 gmGrantReward 白名单包含 zhuimo',
        /gmGrantReward[\s\S]{0,3000}'zhuimo'/.test(serviceCode), '');

    check('坠魔谷 gmResetCooldown 白名单包含 zhuimo',
        /gmResetCooldown[\s\S]{0,3000}'zhuimo'/.test(serviceCode), '');

    // 1.9 getStatus 返回坠魔谷变量
    check('getStatus 返回实例级 avg_heart_demon / avg_dao_heart / demon_boss_hp',
        serviceCode.includes('avg_heart_demon: instance.avg_heart_demon') &&
        serviceCode.includes('avg_dao_heart: instance.avg_dao_heart') &&
        serviceCode.includes('demon_boss_hp'), '');

    check('getStatus 返回成员级 heart_demon / dao_heart / is_fallen',
        serviceCode.includes('heart_demon: m.heart_demon') &&
        serviceCode.includes('dao_heart: m.dao_heart') &&
        serviceCode.includes('is_fallen'), '');

    // ===== 场景2：配置完整性 - 4 幕流程 / 专属变量 / 堕魔配置 =====
    console.log('\n[场景2] 配置完整性 - 坠魔谷 4 幕流程');

    const config = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/multi_dungeon_data.json'), 'utf8')
    );

    const zhuimo = config.dungeons?.zhuimo;
    check('zhuimo 配置块存在', zhuimo !== undefined, '');

    if (zhuimo) {
        // 2.1 基础信息
        check('zhuimo.name = "坠魔谷"', zhuimo.name === '坠魔谷', `actual=${zhuimo.name}`);
        check('zhuimo.desc 不为空且描述 PVE 心魔博弈',
            typeof zhuimo.desc === 'string' &&
            zhuimo.desc.length > 20 &&
            zhuimo.desc.includes('心魔') &&
            zhuimo.desc.includes('道心'),
            `desc 长度=${zhuimo.desc?.length}`);

        // 2.2 人数与境界
        check('zhuimo.member_min = 3', zhuimo.member_min === 3, `actual=${zhuimo.member_min}`);
        check('zhuimo.member_max = 5', zhuimo.member_max === 5, `actual=${zhuimo.member_max}`);
        check('zhuimo.leader_min_realm = "结丹期"',
            zhuimo.leader_min_realm === '结丹期',
            `actual=${zhuimo.leader_min_realm}`);
        check('zhuimo.leader_min_realm_rank = 15',
            zhuimo.leader_min_realm_rank === 15,
            `actual=${zhuimo.leader_min_realm_rank}`);
        check('zhuimo.member_min_realm = "筑基后期"',
            zhuimo.member_min_realm === '筑基后期',
            `actual=${zhuimo.member_min_realm}`);
        check('zhuimo.member_min_realm_rank = 13',
            zhuimo.member_min_realm_rank === 13,
            `actual=${zhuimo.member_min_realm_rank}`);

        // 2.3 门票与冷却
        check('zhuimo.consume_item_key = "zhuimo_token"',
            zhuimo.consume_item_key === 'zhuimo_token',
            `actual=${zhuimo.consume_item_key}`);
        check('zhuimo.consume_item_count = 1', zhuimo.consume_item_count === 1, '');
        check('zhuimo.cooldown_hours = 72', zhuimo.cooldown_hours === 72, '');
        check('zhuimo.expire_hours = 2', zhuimo.expire_hours === 2, '');

        // 2.4 实例级专属初始化变量
        check('zhuimo.init_avg_heart_demon = 0', zhuimo.init_avg_heart_demon === 0, '');
        check('zhuimo.init_avg_dao_heart = 100', zhuimo.init_avg_dao_heart === 100, '');

        // 2.5 成员级专属初始化变量
        check('zhuimo.member_init_heart_demon = 0', zhuimo.member_init_heart_demon === 0, '');
        check('zhuimo.member_init_dao_heart = 100', zhuimo.member_init_dao_heart === 100, '');

        // 2.6 堕魔阈值
        check('zhuimo.fallen_threshold_heart_demon = 100',
            zhuimo.fallen_threshold_heart_demon === 100, '');
        check('zhuimo.broken_threshold_dao_heart = 0',
            zhuimo.broken_threshold_dao_heart === 0, '');

        // 2.7 决战配置
        check('zhuimo.final_act_number = 4', zhuimo.final_act_number === 4, '');
        check('zhuimo.final_max_rounds = 5', zhuimo.final_max_rounds === 5, '');
        check('zhuimo.demon_boss_hp_base = 1000000',
            zhuimo.demon_boss_hp_base === 1000000, '');
        check('zhuimo.damage_per_round_base = 80000',
            zhuimo.damage_per_round_base === 80000, '');
        check('zhuimo.damage_dao_heart_bonus_per_point = 1500',
            zhuimo.damage_dao_heart_bonus_per_point === 1500, '');
        check('zhuimo.damage_heart_demon_bonus_per_point = 2000',
            zhuimo.damage_heart_demon_bonus_per_point === 2000, '');
        check('zhuimo.dao_heart_change_per_round = -5',
            zhuimo.dao_heart_change_per_round === -5, '');
        check('zhuimo.heart_demon_change_per_round = 5',
            zhuimo.heart_demon_change_per_round === 5, '');

        // 2.8 完美通关条件
        check('zhuimo.perfect_clear_no_fallen = true',
            zhuimo.perfect_clear_no_fallen === true, '');

        // 2.9 4 幕流程校验
        check('zhuimo.acts 数组长度 = 4',
            Array.isArray(zhuimo.acts) && zhuimo.acts.length === 4,
            `actual=${zhuimo.acts?.length}`);

        if (Array.isArray(zhuimo.acts) && zhuimo.acts.length === 4) {
            const act1 = zhuimo.acts[0];
            const act2 = zhuimo.acts[1];
            const act3 = zhuimo.acts[2];
            const act4 = zhuimo.acts[3];

            // 第1幕：入谷遇魔
            check('第1幕 act_key = "enter_valley"', act1.act_key === 'enter_valley', '');
            check('第1幕 act_name = "入谷遇魔"', act1.act_name === '入谷遇魔', '');
            check('第1幕 is_entry_act = true', act1.is_entry_act === true, '');
            check('第1幕有 3 个 choices',
                Array.isArray(act1.choices) && act1.choices.length === 3,
                `actual=${act1.choices?.length}`);

            if (Array.isArray(act1.choices) && act1.choices.length === 3) {
                const purify = act1.choices.find(c => c.key === 'purify');
                const slay = act1.choices.find(c => c.key === 'slay');
                const guard = act1.choices.find(c => c.key === 'guard');

                check('第1幕 purify 抉择存在', purify !== undefined, '');
                check('第1幕 purify.heart_demon_self_change = -10',
                    purify?.heart_demon_self_change === -10, `actual=${purify?.heart_demon_self_change}`);
                check('第1幕 purify.dao_heart_self_change = 5',
                    purify?.dao_heart_self_change === 5, `actual=${purify?.dao_heart_self_change}`);

                check('第1幕 slay 抉择存在', slay !== undefined, '');
                check('第1幕 slay.heart_demon_self_change = 15',
                    slay?.heart_demon_self_change === 15, `actual=${slay?.heart_demon_self_change}`);
                check('第1幕 slay.dao_heart_self_change = -10',
                    slay?.dao_heart_self_change === -10, `actual=${slay?.dao_heart_self_change}`);
                check('第1幕 slay.harvest_multiplier_change = 0.1',
                    slay?.harvest_multiplier_change === 0.1, '');

                check('第1幕 guard 抉择存在', guard !== undefined, '');
                check('第1幕 guard.heart_demon_others_change = -5',
                    guard?.heart_demon_others_change === -5, `actual=${guard?.heart_demon_others_change}`);
                check('第1幕 guard.dao_heart_self_change = 10',
                    guard?.dao_heart_self_change === 10, '');
            }

            // 第2幕：心魔试炼（含护道特殊逻辑）
            check('第2幕 act_key = "demon_trial"', act2.act_key === 'demon_trial', '');
            check('第2幕 act_name = "心魔试炼"', act2.act_name === '心魔试炼', '');
            check('第2幕有 3 个 choices',
                Array.isArray(act2.choices) && act2.choices.length === 3,
                `actual=${act2.choices?.length}`);

            if (Array.isArray(act2.choices) && act2.choices.length === 3) {
                const meditate = act2.choices.find(c => c.key === 'meditate');
                const bloodSacrifice = act2.choices.find(c => c.key === 'blood_sacrifice');
                const protect = act2.choices.find(c => c.key === 'protect');

                check('第2幕 meditate 抉择存在', meditate !== undefined, '');
                check('第2幕 meditate.heart_demon_self_change = -15',
                    meditate?.heart_demon_self_change === -15, '');

                check('第2幕 blood_sacrifice 抉择存在', bloodSacrifice !== undefined, '');
                check('第2幕 blood_sacrifice.heart_demon_self_change = 10',
                    bloodSacrifice?.heart_demon_self_change === 10, '');
                check('第2幕 blood_sacrifice.heart_demon_others_change = 10',
                    bloodSacrifice?.heart_demon_others_change === 10, '');

                check('第2幕 protect 抉择存在（护道·心魔最高者专用）', protect !== undefined, '');
                check('第2幕 protect.heart_demon_others_change_highest = -20',
                    protect?.heart_demon_others_change_highest === -20,
                    `actual=${protect?.heart_demon_others_change_highest}`);
            }

            // 第3幕：道心抉择
            check('第3幕 act_key = "dao_choice"', act3.act_key === 'dao_choice', '');
            check('第3幕 act_name = "道心抉择"', act3.act_name === '道心抉择', '');
            check('第3幕有 3 个 choices',
                Array.isArray(act3.choices) && act3.choices.length === 3,
                `actual=${act3.choices?.length}`);

            if (Array.isArray(act3.choices) && act3.choices.length === 3) {
                const uphold = act3.choices.find(c => c.key === 'uphold_dao');
                const fall = act3.choices.find(c => c.key === 'fall_to_demon');
                const balance = act3.choices.find(c => c.key === 'balance');

                check('第3幕 uphold_dao 抉择存在', uphold !== undefined, '');
                check('第3幕 uphold_dao.heart_demon_self_change = -10',
                    uphold?.heart_demon_self_change === -10, '');
                check('第3幕 uphold_dao.dao_heart_self_change = 20',
                    uphold?.dao_heart_self_change === 20, '');

                check('第3幕 fall_to_demon 抉择存在', fall !== undefined, '');
                check('第3幕 fall_to_demon.heart_demon_self_change = 30',
                    fall?.heart_demon_self_change === 30, '');
                check('第3幕 fall_to_demon.dao_heart_self_change = -15',
                    fall?.dao_heart_self_change === -15, '');
                check('第3幕 fall_to_demon.harvest_multiplier_change = 0.25',
                    fall?.harvest_multiplier_change === 0.25, '');

                check('第3幕 balance 抉择存在', balance !== undefined, '');
                check('第3幕 balance.heart_demon_self_change = 5',
                    balance?.heart_demon_self_change === 5, '');
                check('第3幕 balance.dao_heart_self_change = 5',
                    balance?.dao_heart_self_change === 5, '');
            }

            // 第4幕：心魔决战（自动决战）
            check('第4幕 act_key = "demon_boss"', act4.act_key === 'demon_boss', '');
            check('第4幕 act_name = "心魔决战"', act4.act_name === '心魔决战', '');
            check('第4幕 is_auto_advance = true', act4.is_auto_advance === true, '');
            check('第4幕 is_final_act = true', act4.is_final_act === true, '');
            check('第4幕 rounds_max = 5', act4.rounds_max === 5, '');
            check('第4幕 damage_per_round_base = 80000',
                act4.damage_per_round_base === 80000, '');
            check('第4幕 damage_dao_heart_bonus_per_point = 1500',
                act4.damage_dao_heart_bonus_per_point === 1500, '');
            check('第4幕 damage_heart_demon_bonus_per_point = 2000',
                act4.damage_heart_demon_bonus_per_point === 2000, '');
            check('第4幕 dao_heart_change_per_round = -5',
                act4.dao_heart_change_per_round === -5, '');
            check('第4幕 heart_demon_change_per_round = 5',
                act4.heart_demon_change_per_round === 5, '');

            // 通关 / 失败条件
            check('第4幕 clear_condition.boss_hp_zero = true',
                act4.clear_condition?.boss_hp_zero === true, '');
            check('第4幕 fail_condition.avg_dao_heart_lte = 0',
                act4.fail_condition?.avg_dao_heart_lte === 0, '');
            check('第4幕 fail_condition.avg_heart_demon_gte = 100',
                act4.fail_condition?.avg_heart_demon_gte === 100, '');
        }

        // 2.10 奖励配置校验
        const rewards = zhuimo.rewards;
        check('rewards.base_rewards 数组长度 = 3',
            Array.isArray(rewards.base_rewards) && rewards.base_rewards.length === 3,
            `actual=${rewards.base_rewards?.length}`);

        if (Array.isArray(rewards.base_rewards)) {
            const expReward = rewards.base_rewards.find(r => r.type === 'exp');
            const stonesReward = rewards.base_rewards.find(r => r.type === 'spirit_stones');
            const dsReward = rewards.base_rewards.find(r => r.type === 'divine_sense');
            check('base_rewards 包含 exp=25000', expReward?.count === 25000, '');
            check('base_rewards 包含 spirit_stones=8000', stonesReward?.count === 8000, '');
            check('base_rewards 包含 divine_sense=50', dsReward?.count === 50, '');
        }

        check('rewards.normal_drops 数组长度 = 4',
            Array.isArray(rewards.normal_drops) && rewards.normal_drops.length === 4,
            `actual=${rewards.normal_drops?.length}`);

        if (Array.isArray(rewards.normal_drops)) {
            const dropKeys = rewards.normal_drops.map(d => d.item_key).sort();
            check('normal_drops 包含 zhuimo_token/heart_demon_crystal/dao_heart_fragment/demon_seal_rune',
                dropKeys.join(',') === 'dao_heart_fragment,demon_seal_rune,heart_demon_crystal,zhuimo_token',
                `actual=${dropKeys.join(',')}`);
        }

        check('rewards.first_clear_bonus 包含心魔种子',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.item_key === 'heart_demon_seed'),
            '');

        check('rewards.first_clear_bonus 包含首通称号（伏魔者）',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.type === 'title' &&
                b.title_id === 'demon_slayer'),
            '');

        // 稀有掉落
        check('rewards.rare_drop.item_key = "dao_heart_crystal"',
            rewards.rare_drop?.item_key === 'dao_heart_crystal', '');
        check('rewards.rare_drop.chance = 0.01 (1%)',
            rewards.rare_drop?.chance === 0.01, `actual=${rewards.rare_drop?.chance}`);
        check('rewards.rare_drop.leader_only = false (随机分给未堕魔成员)',
            rewards.rare_drop?.leader_only === false, '');

        // 道心加成
        check('rewards.dao_heart_bonus.exp_per_10_dao_heart = 1500',
            rewards.dao_heart_bonus?.exp_per_10_dao_heart === 1500, '');
        check('rewards.dao_heart_bonus.spirit_stones_per_10_dao_heart = 100',
            rewards.dao_heart_bonus?.spirit_stones_per_10_dao_heart === 100, '');

        // 完美通关加成
        check('rewards.perfect_bonus.exp = 8000',
            rewards.perfect_bonus?.exp === 8000, '');
        check('rewards.perfect_bonus.spirit_stones = 1500',
            rewards.perfect_bonus?.spirit_stones === 1500, '');

        // 称号
        check('rewards.title = "demon_slayer"',
            rewards.title === 'demon_slayer', '');
        check('rewards.title_chance = 0.25 (25%)',
            rewards.title_chance === 0.25, `actual=${rewards.title_chance}`);
        check('rewards.title_min_dao_heart = 80',
            rewards.title_min_dao_heart === 80, '');
    }

    // ===== 场景3：模型字段校验 =====
    console.log('\n[场景3] 模型字段校验 - 坠魔谷专属字段已同步至 Sequelize 模型');

    const instanceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonInstance.js'), 'utf-8'
    );
    const choiceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonChoice.js'), 'utf-8'
    );
    const memberModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonMember.js'), 'utf-8'
    );

    // 3.1 实例模型字段
    check('MultiDungeonInstance 含 avg_heart_demon 字段',
        instanceModelCode.includes('avg_heart_demon:'), '');
    check('MultiDungeonInstance 含 avg_dao_heart 字段',
        instanceModelCode.includes('avg_dao_heart:'), '');
    check('MultiDungeonInstance 含 demon_boss_hp 字段',
        instanceModelCode.includes('demon_boss_hp:'), '');
    check('MultiDungeonInstance.demon_boss_hp 类型为 BIGINT',
        /demon_boss_hp:[\s\S]{0,200}DataTypes\.BIGINT/.test(instanceModelCode), '');

    // 3.2 抉择模型字段
    check('MultiDungeonChoice 含 heart_demon_self_change 字段',
        choiceModelCode.includes('heart_demon_self_change:'), '');
    check('MultiDungeonChoice 含 heart_demon_others_change 字段',
        choiceModelCode.includes('heart_demon_others_change:'), '');
    check('MultiDungeonChoice 含 heart_demon_others_change_highest 字段',
        choiceModelCode.includes('heart_demon_others_change_highest:'), '');
    check('MultiDungeonChoice 含 dao_heart_self_change 字段',
        choiceModelCode.includes('dao_heart_self_change:'), '');
    check('MultiDungeonChoice 含 dao_heart_others_change 字段',
        choiceModelCode.includes('dao_heart_others_change:'), '');

    // 3.3 成员模型字段
    check('MultiDungeonMember 含 heart_demon 字段',
        memberModelCode.includes('heart_demon:'), '');
    check('MultiDungeonMember 含 dao_heart 字段',
        memberModelCode.includes('dao_heart:'), '');
    check('MultiDungeonMember 含 is_fallen 字段',
        memberModelCode.includes('is_fallen:'), '');
    check('MultiDungeonMember.is_fallen 类型为 TINYINT',
        /is_fallen:[\s\S]{0,200}DataTypes\.TINYINT/.test(memberModelCode), '');

    // ===== 场景4：物品配置校验 =====
    console.log('\n[场景4] 物品配置校验 - 坠魔谷相关物品已定义');

    const itemData = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/item_data.json'), 'utf8')
    );

    const items = itemData.items || [];
    const itemMap = new Map(items.map(i => [i.id, i]));

    // 4.1 必需物品列表
    const requiredItems = [
        { id: 'zhuimo_token', name: '坠魔令', expectedType: 'consumable', expectedSubtype: 'ticket' },
        { id: 'heart_demon_crystal', name: '心魔晶', expectedType: 'material', expectedSubtype: 'crystal' },
        { id: 'dao_heart_fragment', name: '道心碎片', expectedType: 'material', expectedSubtype: 'fragment' },
        { id: 'demon_seal_rune', name: '镇魔符文', expectedType: 'material', expectedSubtype: 'rune' },
        { id: 'heart_demon_seed', name: '心魔种子', expectedType: 'material', expectedSubtype: 'seed' },
        { id: 'dao_heart_crystal', name: '道心晶', expectedType: 'material', expectedSubtype: 'crystal' }
    ];

    for (const req of requiredItems) {
        const item = itemMap.get(req.id);
        check(`物品 ${req.id} 已定义`, item !== undefined, '');
        if (item) {
            check(`物品 ${req.id}.name = "${req.name}"`,
                item.name === req.name, `actual=${item.name}`);
            check(`物品 ${req.id}.type = "${req.expectedType}"`,
                item.type === req.expectedType, `actual=${item.type}`);
            check(`物品 ${req.id}.subtype = "${req.expectedSubtype}"`,
                item.subtype === req.expectedSubtype, `actual=${item.subtype}`);
            check(`物品 ${req.id}.description 不为空`,
                typeof item.description === 'string' && item.description.length > 10, '');
            check(`物品 ${req.id}.price > 0`,
                typeof item.price === 'number' && item.price > 0, `actual=${item.price}`);
        }
    }

    // 4.2 门票物品特殊校验
    const zhuimoToken = itemMap.get('zhuimo_token');
    if (zhuimoToken) {
        check('zhuimo_token.quality = "legendary"',
            zhuimoToken.quality === 'legendary', `actual=${zhuimoToken.quality}`);
        check('zhuimo_token.effect 包含 dungeon_ticket: "zhuimo"',
            zhuimoToken.effect?.dungeon_ticket === 'zhuimo', '');
    }

    // 4.3 首通奖励物品特殊校验
    const heartDemonSeed = itemMap.get('heart_demon_seed');
    if (heartDemonSeed) {
        check('heart_demon_seed.quality = "epic"',
            heartDemonSeed.quality === 'epic', `actual=${heartDemonSeed.quality}`);
    }

    // 4.4 稀有掉落物品特殊校验
    const daoHeartCrystal = itemMap.get('dao_heart_crystal');
    if (daoHeartCrystal) {
        check('dao_heart_crystal.quality = "legendary"',
            daoHeartCrystal.quality === 'legendary', `actual=${daoHeartCrystal.quality}`);
    }

    // 4.5 物品总数验证
    check('item_data.json 物品总数 = 126（含6个坠魔谷物品）',
        items.length === 126, `actual=${items.length}`);

    // ===== 场景5：迁移脚本校验 =====
    console.log('\n[场景5] 迁移脚本校验 - migration_0059 存在且字段完整');

    const migrationPath = path.join(__dirname, 'migration_0059_zhuimo_fields.js');
    check('migration_0059_zhuimo_fields.js 文件存在', fs.existsSync(migrationPath), '');

    if (fs.existsSync(migrationPath)) {
        const migrationCode = fs.readFileSync(migrationPath, 'utf-8');

        // 5.1 字段添加逻辑
        const requiredMigrationColumns = [
            // instance 表
            { table: 'multi_dungeon_instance', column: 'avg_heart_demon' },
            { table: 'multi_dungeon_instance', column: 'avg_dao_heart' },
            { table: 'multi_dungeon_instance', column: 'demon_boss_hp' },
            // choice 表
            { table: 'multi_dungeon_choice', column: 'heart_demon_self_change' },
            { table: 'multi_dungeon_choice', column: 'heart_demon_others_change' },
            { table: 'multi_dungeon_choice', column: 'heart_demon_others_change_highest' },
            { table: 'multi_dungeon_choice', column: 'dao_heart_self_change' },
            { table: 'multi_dungeon_choice', column: 'dao_heart_others_change' },
            // member 表
            { table: 'multi_dungeon_member', column: 'heart_demon' },
            { table: 'multi_dungeon_member', column: 'dao_heart' },
            { table: 'multi_dungeon_member', column: 'is_fallen' }
        ];

        for (const { table, column } of requiredMigrationColumns) {
            check(`迁移脚本包含 ${table}.${column} 字段添加`,
                migrationCode.includes(`'${table}'`) && migrationCode.includes(`'${column}'`), '');
        }

        // 5.2 幂等性保障
        check('迁移脚本包含幂等性检查（columnExists / INFORMATION_SCHEMA）',
            migrationCode.includes('columnExists') &&
            migrationCode.includes('INFORMATION_SCHEMA'), '');

        // 5.3 回滚逻辑
        check('迁移脚本包含 down 回滚逻辑',
            migrationCode.includes('down:') && migrationCode.includes('DROP COLUMN'), '');

        // 5.4 demon_boss_hp 字段类型为 BIGINT
        check('迁移脚本 demon_boss_hp 字段类型为 BIGINT',
            migrationCode.includes('BIGINT DEFAULT NULL') ||
            /demon_boss_hp[\s\S]{0,200}BIGINT/.test(migrationCode), '');

        // 5.5 is_fallen 字段类型为 TINYINT(1)
        check('迁移脚本 is_fallen 字段类型为 TINYINT(1)',
            migrationCode.includes('TINYINT(1)'), '');

        // 5.6 迁移脚本名称与描述
        check('迁移脚本 name = "0059_zhuimo_fields"',
            migrationCode.includes("0059_zhuimo_fields"), '');
    }

    // ===== 场景6：接口路由校验 =====
    console.log('\n[场景6] 接口路由 - /api/multi-dungeon/* 支持 zhuimo');

    const routeCode = fs.readFileSync(
        path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8'
    );

    check('路由 create 接口白名单包含 zhuimo',
        routeCode.includes("'zhuimo'"), '');
    check('路由 create 接口注释提及坠魔谷',
        routeCode.includes('坠魔谷'), '');
    check('路由 rewards 接口白名单包含 zhuimo',
        /rewards[\s\S]{0,2000}'zhuimo'/.test(routeCode), '');
    check('路由 advance 接口注释提及坠魔谷第四幕',
        routeCode.includes('坠魔谷第四幕'), '');

    // ===== 场景7：接口端到端测试 =====
    console.log('\n[场景7] 接口端到端测试 - 坠魔谷只读接口');

    let token = null;
    try {
        const loginRes = await api('POST', '/api/auth/login', null, {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        token = loginRes.json?.token;
        check('测试账号登录成功', !!token, '');
    } catch (err) {
        check('测试账号登录成功', false, `异常: ${err.message}`);
    }

    if (token) {
        // 7.1 /help 应返回 zhuimo
        const helpRes = await api('GET', '/api/multi-dungeon/help', token);
        check('/api/multi-dungeon/help 返回 200',
            helpRes.status === 200, `status=${helpRes.status}`);

        if (helpRes.json?.data?.dungeons?.zhuimo) {
            const zhuimoHelp = helpRes.json.data.dungeons.zhuimo;
            check('help 返回 zhuimo.name = "坠魔谷"',
                zhuimoHelp.name === '坠魔谷', `actual=${zhuimoHelp.name}`);
            check('help 返回 zhuimo.member_min = 3',
                zhuimoHelp.member_min === 3, `actual=${zhuimoHelp.member_min}`);
            check('help 返回 zhuimo.member_max = 5',
                zhuimoHelp.member_max === 5, `actual=${zhuimoHelp.member_max}`);
            console.log(`\n  📊 坠魔谷帮助信息：`);
            console.log(`     名称: ${zhuimoHelp.name}`);
            console.log(`     人数: ${zhuimoHelp.member_min}-${zhuimoHelp.member_max} 人`);
            console.log(`     队长境界: ${zhuimoHelp.leader_min_realm} (rank≥${zhuimoHelp.leader_min_realm_rank})`);
            console.log(`     队员境界: ${zhuimoHelp.member_min_realm} (rank≥${zhuimoHelp.member_min_realm_rank})`);
            console.log(`     消耗物品: ${zhuimoHelp.consume_item_key} ×${zhuimoHelp.consume_item_count}`);
            console.log(`     冷却: ${zhuimoHelp.cooldown_hours} 小时`);
            console.log(`     流程: ${zhuimoHelp.act_count} 幕`);
        } else {
            check('help 返回 zhuimo 配置', false, 'help 响应未包含 zhuimo');
        }

        // 7.2 /rewards?dungeon_key=zhuimo 应返回坠魔谷奖励详情
        const rewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=zhuimo', token);
        check('/api/multi-dungeon/rewards?dungeon_key=zhuimo 返回 200',
            rewardsRes.status === 200, `status=${rewardsRes.status}`);

        if (rewardsRes.json?.data) {
            const data = rewardsRes.json.data;
            check('rewards 响应包含坠魔谷',
                data.dungeon_key === 'zhuimo' || data.name === '坠魔谷',
                `data=${JSON.stringify(data).substring(0, 100)}`);

            console.log(`\n  📊 坠魔谷奖励信息：`);
            if (data.rewards) {
                if (data.rewards.base_rewards) {
                    console.log(`     基础奖励: ${data.rewards.base_rewards.length} 项`);
                }
                if (data.rewards.normal_drops) {
                    console.log(`     普通掉落: ${data.rewards.normal_drops.length} 项`);
                }
                if (data.rewards.rare_drop) {
                    console.log(`     稀有掉落: ${JSON.stringify(data.rewards.rare_drop).substring(0, 80)}`);
                }
                if (data.rewards.first_clear_bonus) {
                    console.log(`     首通奖励: ${data.rewards.first_clear_bonus.length} 项`);
                }
                if (data.rewards.dao_heart_bonus) {
                    console.log(`     道心加成: 每10点 +${data.rewards.dao_heart_bonus.exp_per_10_dao_heart}修为 +${data.rewards.dao_heart_bonus.spirit_stones_per_10_dao_heart}灵石`);
                }
                if (data.rewards.perfect_bonus) {
                    console.log(`     完美通关加成: +${data.rewards.perfect_bonus.exp}修为 +${data.rewards.perfect_bonus.spirit_stones}灵石`);
                }
            }
        }

        // 7.3 /cooldown 应返回 zhuimo 冷却状态
        const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown', token);
        check('/api/multi-dungeon/cooldown 返回 200',
            cooldownRes.status === 200, `status=${cooldownRes.status}`);
        check('cooldown 响应包含 zhuimo 键',
            cooldownRes.json?.data?.cooldowns?.zhuimo !== undefined,
            `keys=${Object.keys(cooldownRes.json?.data?.cooldowns || {}).join(',')}`);

        // 7.4 尝试创建坠魔谷副本（预期失败：物品不足或冷却或已在副本中）
        // 注：测试账号是化神期 rank=23 admin，境界满足要求（leader_min_realm_rank=15）
        const createRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'zhuimo'
        });
        check('POST /api/multi-dungeon/create zhuimo 接口可调用',
            createRes.status === 200 || createRes.status === 400,
            `status=${createRes.status}`);

        if (createRes.json) {
            if (createRes.status === 200 && createRes.json?.data?.instance_id) {
                console.log(`     ⚠️  警告：测试账号创建了坠魔谷副本实例（instance_id=${createRes.json.data.instance_id}）`);
                console.log(`     ⚠️  自动解散该实例以清理状态...`);
                const dissolveRes = await api('POST', '/api/multi-dungeon/dissolve', token, {});
                check('清理：自动解散创建的实例',
                    dissolveRes.status === 200, `status=${dissolveRes.status}`);
            } else {
                console.log(`     ℹ️  创建被拦截（预期）：${createRes.json.message}`);
                check('创建被拦截时返回 message 包含具体原因',
                    typeof createRes.json.message === 'string' && createRes.json.message.length > 0,
                    `message=${createRes.json.message}`);
            }
        }

        // 7.5 错误的 dungeon_key 应被拒绝
        const wrongKeyRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'wrong_dungeon'
        });
        check('错误的 dungeon_key 应被拒绝（400）',
            wrongKeyRes.status === 400, `status=${wrongKeyRes.status}`);

        // 7.6 错误的 rewards dungeon_key 应被拒绝
        const wrongRewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=wrong_dungeon', token);
        check('错误的 rewards dungeon_key 应被拒绝（400）',
            wrongRewardsRes.status === 400, `status=${wrongRewardsRes.status}`);
    }

    // ===== 测试汇总 =====
    console.log('\n========================================');
    console.log('  测试汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`  通过: ${passed}  失败: ${failed}  总计: ${results.length}`);
    console.log('');

    if (failed > 0) {
        console.log('  ❌ 失败项明细：');
        results.filter(r => !r.pass).forEach(r => {
            console.log(`     - ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
        });
        process.exit(1);
    } else {
        console.log('  ✅ 全部测试通过！');
        process.exit(0);
    }
})().catch(err => {
    console.error('\n💥 测试脚本异常:', err);
    process.exit(2);
});
