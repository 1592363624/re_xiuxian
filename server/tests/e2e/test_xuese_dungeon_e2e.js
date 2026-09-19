/**
 * 血色试炼副本端到端测试
 *
 * 目的：验证血色试炼（xuese）4-6人 PVPvE 淘汰制副本的配置完整性、服务方法存在性、
 *      模型字段同步性、接口可用性、淘汰机制、决战机制、奖励结算逻辑。
 *
 * 测试范围：
 *   1. 静态代码扫描：MultiDungeonService 包含血色试炼专属方法 _applyXueseElimination / _processXueseFinalAct
 *   2. 配置完整性：4 幕流程 / 5 个实例级变量 / 4 个抉择级变量 / 3 个成员级变量 / 淘汰配置 / 决战公式参数
 *   3. 变量边界：VARIABLE_BOUNDS 包含 blood_qi_avg(0-100) / blood_fury(0-200) / eliminations(0-6) /
 *      survivor_count(0-6) / member_blood_qi(0-100) / member_kill_score(0-200)
 *   4. 模型字段：MultiDungeonInstance / MultiDungeonChoice / MultiDungeonMember 含血色试炼专属字段
 *   5. 接口路由：/api/multi-dungeon/create 与 /api/multi-dungeon/rewards 支持 xuese
 *   6. 物品配置：blood_token / blood_soul_crystal / blood_sha_charm / blood_relic_fragment /
 *      blood_blade_remnant / blood_battle_armor 共 6 个物品已定义
 *   7. 只读接口：/help、/rewards、/cooldown 返回 xuese 信息
 *   8. 创建接口：测试账号尝试创建血色试炼，预期因物品不足或冷却被拦截
 *
 * 玩法文档对照：
 *   - 血色试炼：4-6人 PVPvE 淘汰制副本，4幕流程
 *   - 第1幕·血色试炼场（blood_arena）：is_pvp_eliminable=true, elimination_count=1，3选择（hunt/stealth/challenge）
 *   - 第2幕·血魂祭坛（blood_altar）：不淘汰，3选择（sacrifice/plunder/guard）
 *   - 第3幕·血雾迷踪（blood_mist）：is_pvp_eliminable=true, elimination_count=1，3选择（pursue/evade/ambush）
 *   - 第4幕·血色尊者决战（xuese_boss）：is_auto_advance=true, is_final_act=true, rounds_max=6
 *   - 淘汰排序规则：blood_qi 升序 → kill_score 升序 → join_time 升序，末位淘汰
 *   - 决战伤害公式：damage = 100000 + blood_fury × 3000 + survivor_count × 20000
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
    console.log('  血色试炼副本端到端测试 (xuese)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 血色试炼专属方法与变量边界 =====
    console.log('[场景1] 静态代码扫描 - 血色试炼专属方法与变量边界');

    const serviceCode = fs.readFileSync(
        path.join(__dirname, '../game/services/MultiDungeonService.js'), 'utf-8'
    );

    // 1.1 专属方法存在性
    check('MultiDungeonService 包含 _applyXueseElimination 静态方法',
        /static\s+async\s+_applyXueseElimination\s*\(/.test(serviceCode), '');

    check('MultiDungeonService 包含 _processXueseFinalAct 静态方法',
        /static\s+async\s+_processXueseFinalAct\s*\(/.test(serviceCode), '');

    check('create 方法白名单包含 xuese',
        serviceCode.includes("'xuese'"), '');

    check('finalActHandler 四分支分发包含 xuese',
        serviceCode.includes("instance.instance_key === 'xuese'") &&
        serviceCode.includes('_processXueseFinalAct'), '');

    // 1.2 VARIABLE_BOUNDS 边界定义
    check('VARIABLE_BOUNDS 包含 blood_qi_avg (0-100)',
        /blood_qi_avg:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 blood_fury (0-200)',
        /blood_fury:\s*\{\s*min:\s*0,\s*max:\s*200\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 eliminations (0-6)',
        /eliminations:\s*\{\s*min:\s*0,\s*max:\s*6\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 survivor_count (0-6)',
        /survivor_count:\s*\{\s*min:\s*0,\s*max:\s*6\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 member_blood_qi (0-100)',
        /member_blood_qi:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 member_kill_score (0-200)',
        /member_kill_score:\s*\{\s*min:\s*0,\s*max:\s*200\s*\}/.test(serviceCode), '');

    // 1.3 血色试炼专属变量初始化逻辑
    check('血色试炼实例级变量初始化（init_blood_qi_avg）',
        serviceCode.includes('init_blood_qi_avg'), '');

    check('血色试炼实例级变量初始化（init_blood_fury）',
        serviceCode.includes('init_blood_fury'), '');

    check('血色试炼实例级变量初始化（init_eliminations）',
        serviceCode.includes('init_eliminations'), '');

    check('血色试炼实例级变量初始化（init_survivor_count）',
        serviceCode.includes('init_survivor_count'), '');

    check('血色试炼成员级变量初始化（member_init_blood_qi）',
        serviceCode.includes('member_init_blood_qi'), '');

    check('血色试炼成员级变量初始化（member_init_kill_score）',
        serviceCode.includes('member_init_kill_score'), '');

    // 1.4 抉择变量应用逻辑
    check('血色试炼抉择变量应用（blood_fury_change 累加到实例）',
        serviceCode.includes('blood_fury_change') &&
        serviceCode.includes('instance.blood_fury'), '');

    check('血色试炼抉择变量应用（blood_qi_self_change 操作 member 表）',
        serviceCode.includes('blood_qi_self_change'), '');

    check('血色试炼抉择变量应用（blood_qi_others_change 影响他人）',
        serviceCode.includes('blood_qi_others_change'), '');

    check('血色试炼抉择变量应用（kill_score_change 操作 member 表）',
        serviceCode.includes('kill_score_change'), '');

    check('血色试炼平均血气同步更新（blood_qi_avg 重算）',
        serviceCode.includes('blood_qi_avg') &&
        serviceCode.includes('survivors'), '');

    // 1.5 淘汰机制
    check('血色试炼淘汰触发逻辑（choose 方法中调用 _applyXueseElimination）',
        serviceCode.includes('_applyXueseElimination') &&
        serviceCode.includes('is_pvp_eliminable'), '');

    check('血色试炼淘汰排序规则（blood_qi 升序 / kill_score 升序 / join_time 升序）',
        serviceCode.includes('blood_qi') &&
        serviceCode.includes('kill_score') &&
        serviceCode.includes('join_time'), '');

    check('血色试炼淘汰标记（is_eliminated=1, is_present=0）',
        serviceCode.includes('is_eliminated') &&
        serviceCode.includes('is_present'), '');

    // 1.6 决战机制
    check('血色试炼决战初始化（xuese_boss_hp = 1200000）',
        serviceCode.includes('xuese_boss_hp') &&
        serviceCode.includes('1200000'), '');

    check('血色试炼决战伤害公式（100000 + blood_fury × 3000 + survivor_count × 20000）',
        serviceCode.includes('100000') &&
        serviceCode.includes('3000') &&
        serviceCode.includes('20000'), '');

    check('血色试炼决战每回合血气衰减（blood_qi_avg_change_per_round = -10）',
        serviceCode.includes('blood_qi_avg_change_per_round') ||
        serviceCode.includes('blood_qi_avg') && serviceCode.includes('-10'), '');

    // 1.7 奖励结算
    check('血色试炼奖励结算块（kill_score_bonus 杀戮分加成）',
        serviceCode.includes('kill_score_bonus'), '');

    check('血色试炼奖励结算块（survivor_bonus 幸存者加成）',
        serviceCode.includes('survivor_bonus'), '');

    check('血色试炼奖励结算块（perfect_bonus 完美通关加成）',
        serviceCode.includes('perfect_bonus'), '');

    check('血色试炼稀有掉落幸存者分配逻辑',
        serviceCode.includes('is_eliminated') &&
        serviceCode.includes('survivors'), '');

    check('血色试炼 getRewards 白名单包含 xuese',
        /getRewards[\s\S]{0,2000}'xuese'/.test(serviceCode), '');

    check('血色试炼 getCooldown 列表包含 xuese',
        /getCooldown[\s\S]{0,3000}'xuese'/.test(serviceCode), '');

    // ===== 场景2：配置完整性 - 4 幕流程 / 专属变量 / 淘汰配置 =====
    console.log('\n[场景2] 配置完整性 - 血色试炼 4 幕流程');

    const config = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/multi_dungeon_data.json'), 'utf8')
    );

    const xuese = config.dungeons?.xuese;
    check('xuese 配置块存在', xuese !== undefined, '');

    if (xuese) {
        // 2.1 基础信息
        check('xuese.name = "血色试炼"', xuese.name === '血色试炼', `actual=${xuese.name}`);
        check('xuese.desc 不为空且描述 PVPvE 淘汰制',
            typeof xuese.desc === 'string' &&
            xuese.desc.length > 20 &&
            xuese.desc.includes('PVPvE') &&
            xuese.desc.includes('淘汰'),
            `desc 长度=${xuese.desc?.length}`);

        // 2.2 人数与境界
        check('xuese.member_min = 4', xuese.member_min === 4, `actual=${xuese.member_min}`);
        check('xuese.member_max = 6', xuese.member_max === 6, `actual=${xuese.member_max}`);
        check('xuese.leader_min_realm = "筑基后期"',
            xuese.leader_min_realm === '筑基后期',
            `actual=${xuese.leader_min_realm}`);
        check('xuese.leader_min_realm_rank = 13',
            xuese.leader_min_realm_rank === 13,
            `actual=${xuese.leader_min_realm_rank}`);
        check('xuese.member_min_realm = "筑基初期"',
            xuese.member_min_realm === '筑基初期',
            `actual=${xuese.member_min_realm}`);
        check('xuese.member_min_realm_rank = 11',
            xuese.member_min_realm_rank === 11,
            `actual=${xuese.member_min_realm_rank}`);

        // 2.3 门票与冷却
        check('xuese.consume_item_key = "blood_token"',
            xuese.consume_item_key === 'blood_token',
            `actual=${xuese.consume_item_key}`);
        check('xuese.consume_item_count = 1', xuese.consume_item_count === 1, '');
        check('xuese.cooldown_hours = 48', xuese.cooldown_hours === 48, '');
        check('xuese.expire_hours = 2', xuese.expire_hours === 2, '');

        // 2.4 实例级专属初始化变量
        check('xuese.init_blood_qi_avg = 100', xuese.init_blood_qi_avg === 100, '');
        check('xuese.init_blood_fury = 0', xuese.init_blood_fury === 0, '');
        check('xuese.init_eliminations = 0', xuese.init_eliminations === 0, '');
        check('xuese.init_survivor_count = 0', xuese.init_survivor_count === 0, '');

        // 2.5 成员级专属初始化变量
        check('xuese.member_init_blood_qi = 100', xuese.member_init_blood_qi === 100, '');
        check('xuese.member_init_kill_score = 0', xuese.member_init_kill_score === 0, '');

        // 2.6 淘汰配置
        check('xuese.elimination_enabled_acts = [1, 3]',
            Array.isArray(xuese.elimination_enabled_acts) &&
            xuese.elimination_enabled_acts.length === 2 &&
            xuese.elimination_enabled_acts[0] === 1 &&
            xuese.elimination_enabled_acts[1] === 3,
            `actual=${JSON.stringify(xuese.elimination_enabled_acts)}`);

        // 2.7 决战配置
        check('xuese.final_act_number = 4', xuese.final_act_number === 4, '');
        check('xuese.final_max_rounds = 6', xuese.final_max_rounds === 6, '');
        check('xuese.xuese_boss_hp_base = 1200000',
            xuese.xuese_boss_hp_base === 1200000, '');
        check('xuese.damage_per_round_base = 100000',
            xuese.damage_per_round_base === 100000, '');
        check('xuese.damage_blood_fury_bonus_per_point = 3000',
            xuese.damage_blood_fury_bonus_per_point === 3000, '');
        check('xuese.damage_survivor_bonus_per_point = 20000',
            xuese.damage_survivor_bonus_per_point === 20000, '');
        check('xuese.blood_qi_avg_change_per_round = -10',
            xuese.blood_qi_avg_change_per_round === -10, '');

        // 2.8 完美通关条件
        check('xuese.perfect_clear_no_elimination = true',
            xuese.perfect_clear_no_elimination === true, '');

        // 2.9 4 幕流程校验
        check('xuese.acts 数组长度 = 4',
            Array.isArray(xuese.acts) && xuese.acts.length === 4,
            `actual=${xuese.acts?.length}`);

        if (Array.isArray(xuese.acts) && xuese.acts.length === 4) {
            const act1 = xuese.acts[0];
            const act2 = xuese.acts[1];
            const act3 = xuese.acts[2];
            const act4 = xuese.acts[3];

            // 第1幕：血色试炼场
            check('第1幕 act_key = "blood_arena"', act1.act_key === 'blood_arena', '');
            check('第1幕 act_name = "血色试炼场"', act1.act_name === '血色试炼场', '');
            check('第1幕 is_entry_act = true', act1.is_entry_act === true, '');
            check('第1幕 is_pvp_eliminable = true', act1.is_pvp_eliminable === true, '');
            check('第1幕 elimination_count = 1', act1.elimination_count === 1, '');
            check('第1幕有 3 个 choices',
                Array.isArray(act1.choices) && act1.choices.length === 3,
                `actual=${act1.choices?.length}`);

            if (Array.isArray(act1.choices) && act1.choices.length === 3) {
                const hunt = act1.choices.find(c => c.key === 'hunt');
                const stealth = act1.choices.find(c => c.key === 'stealth');
                const challenge = act1.choices.find(c => c.key === 'challenge');

                check('第1幕 hunt 抉择存在', hunt !== undefined, '');
                check('第1幕 hunt.blood_qi_self_change = -10',
                    hunt?.blood_qi_self_change === -10, `actual=${hunt?.blood_qi_self_change}`);
                check('第1幕 hunt.blood_qi_others_change = -30',
                    hunt?.blood_qi_others_change === -30, `actual=${hunt?.blood_qi_others_change}`);
                check('第1幕 hunt.kill_score_change = 8',
                    hunt?.kill_score_change === 8, `actual=${hunt?.kill_score_change}`);
                check('第1幕 hunt.blood_fury_change = 5',
                    hunt?.blood_fury_change === 5, `actual=${hunt?.blood_fury_change}`);

                check('第1幕 stealth 抉择存在', stealth !== undefined, '');
                check('第1幕 stealth.blood_qi_self_change = 15',
                    stealth?.blood_qi_self_change === 15, '');
                check('第1幕 stealth.kill_score_change = 5',
                    stealth?.kill_score_change === 5, '');

                check('第1幕 challenge 抉择存在', challenge !== undefined, '');
                check('第1幕 challenge.blood_qi_others_change = -50',
                    challenge?.blood_qi_others_change === -50, '');
                check('第1幕 challenge.kill_score_change = 15',
                    challenge?.kill_score_change === 15, '');
                check('第1幕 challenge.blood_fury_change = 10',
                    challenge?.blood_fury_change === 10, '');
            }

            // 第2幕：血魂祭坛（不淘汰）
            check('第2幕 act_key = "blood_altar"', act2.act_key === 'blood_altar', '');
            check('第2幕 act_name = "血魂祭坛"', act2.act_name === '血魂祭坛', '');
            check('第2幕 is_pvp_eliminable = false', act2.is_pvp_eliminable === false, '');
            check('第2幕未设置 elimination_count',
                act2.elimination_count === undefined, '');
            check('第2幕有 3 个 choices',
                Array.isArray(act2.choices) && act2.choices.length === 3,
                `actual=${act2.choices?.length}`);

            if (Array.isArray(act2.choices) && act2.choices.length === 3) {
                const sacrifice = act2.choices.find(c => c.key === 'sacrifice');
                const plunder = act2.choices.find(c => c.key === 'plunder');
                const guard = act2.choices.find(c => c.key === 'guard');

                check('第2幕 sacrifice 抉择存在', sacrifice !== undefined, '');
                check('第2幕 sacrifice.blood_qi_self_change = -20',
                    sacrifice?.blood_qi_self_change === -20, '');
                check('第2幕 sacrifice.blood_fury_change = 30',
                    sacrifice?.blood_fury_change === 30, '');

                check('第2幕 plunder 抉择存在', plunder !== undefined, '');
                check('第2幕 plunder.blood_qi_others_change = -10',
                    plunder?.blood_qi_others_change === -10, '');
                check('第2幕 plunder.kill_score_change = 10',
                    plunder?.kill_score_change === 10, '');

                check('第2幕 guard 抉择存在', guard !== undefined, '');
                check('第2幕 guard.blood_qi_self_change = 10',
                    guard?.blood_qi_self_change === 10, '');
                check('第2幕 guard.blood_fury_change = 10',
                    guard?.blood_fury_change === 10, '');
            }

            // 第3幕：血雾迷踪（淘汰）
            check('第3幕 act_key = "blood_mist"', act3.act_key === 'blood_mist', '');
            check('第3幕 act_name = "血雾迷踪"', act3.act_name === '血雾迷踪', '');
            check('第3幕 is_pvp_eliminable = true', act3.is_pvp_eliminable === true, '');
            check('第3幕 elimination_count = 1', act3.elimination_count === 1, '');
            check('第3幕有 3 个 choices',
                Array.isArray(act3.choices) && act3.choices.length === 3,
                `actual=${act3.choices?.length}`);

            if (Array.isArray(act3.choices) && act3.choices.length === 3) {
                const pursue = act3.choices.find(c => c.key === 'pursue');
                const evade = act3.choices.find(c => c.key === 'evade');
                const ambush = act3.choices.find(c => c.key === 'ambush');

                check('第3幕 pursue 抉择存在', pursue !== undefined, '');
                check('第3幕 pursue.blood_qi_self_change = -15',
                    pursue?.blood_qi_self_change === -15, '');

                check('第3幕 evade 抉择存在', evade !== undefined, '');
                check('第3幕 evade.kill_score_change = -5',
                    evade?.kill_score_change === -5, '');

                check('第3幕 ambush 抉择存在', ambush !== undefined, '');
                check('第3幕 ambush.blood_qi_others_change = -25',
                    ambush?.blood_qi_others_change === -25, '');
                check('第3幕 ambush.kill_score_change = 12',
                    ambush?.kill_score_change === 12, '');
            }

            // 第4幕：血色尊者决战（自动决战）
            check('第4幕 act_key = "xuese_boss"', act4.act_key === 'xuese_boss', '');
            check('第4幕 act_name = "血色尊者决战"', act4.act_name === '血色尊者决战', '');
            check('第4幕 is_auto_advance = true', act4.is_auto_advance === true, '');
            check('第4幕 is_final_act = true', act4.is_final_act === true, '');
            check('第4幕 rounds_max = 6', act4.rounds_max === 6, '');
            check('第4幕 damage_per_round_base = 100000',
                act4.damage_per_round_base === 100000, '');
            check('第4幕 damage_blood_fury_bonus_per_point = 3000',
                act4.damage_blood_fury_bonus_per_point === 3000, '');
            check('第4幕 damage_survivor_bonus_per_point = 20000',
                act4.damage_survivor_bonus_per_point === 20000, '');
            check('第4幕 blood_qi_avg_change_per_round = -10',
                act4.blood_qi_avg_change_per_round === -10, '');

            // 通关 / 失败条件
            check('第4幕 clear_condition.boss_hp_zero = true',
                act4.clear_condition?.boss_hp_zero === true, '');
            check('第4幕 fail_condition.blood_qi_avg_lte = 0',
                act4.fail_condition?.blood_qi_avg_lte === 0, '');
        }

        // 2.10 奖励配置校验
        const rewards = xuese.rewards;
        check('rewards.base_rewards 数组长度 = 3',
            Array.isArray(rewards.base_rewards) && rewards.base_rewards.length === 3,
            `actual=${rewards.base_rewards?.length}`);

        if (Array.isArray(rewards.base_rewards)) {
            const expReward = rewards.base_rewards.find(r => r.type === 'exp');
            const stonesReward = rewards.base_rewards.find(r => r.type === 'spirit_stones');
            const dsReward = rewards.base_rewards.find(r => r.type === 'divine_sense');
            check('base_rewards 包含 exp=35000', expReward?.count === 35000, '');
            check('base_rewards 包含 spirit_stones=10000', stonesReward?.count === 10000, '');
            check('base_rewards 包含 divine_sense=60', dsReward?.count === 60, '');
        }

        check('rewards.normal_drops 数组长度 = 4',
            Array.isArray(rewards.normal_drops) && rewards.normal_drops.length === 4,
            `actual=${rewards.normal_drops?.length}`);

        if (Array.isArray(rewards.normal_drops)) {
            const dropKeys = rewards.normal_drops.map(d => d.item_key).sort();
            check('normal_drops 包含 blood_token/blood_soul_crystal/blood_sha_charm/blood_relic_fragment',
                dropKeys.join(',') === 'blood_relic_fragment,blood_sha_charm,blood_soul_crystal,blood_token',
                `actual=${dropKeys.join(',')}`);
        }

        check('rewards.first_clear_bonus 包含血色残刃',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.item_key === 'blood_blade_remnant'),
            '');

        check('rewards.first_clear_bonus 包含首通称号',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.type === 'title' &&
                b.title_id === 'blood_purgatory_survivor'),
            '');

        // 稀有掉落
        check('rewards.rare_drop.item_key = "blood_battle_armor"',
            rewards.rare_drop?.item_key === 'blood_battle_armor', '');
        check('rewards.rare_drop.chance = 0.008 (0.8%)',
            rewards.rare_drop?.chance === 0.008, `actual=${rewards.rare_drop?.chance}`);
        check('rewards.rare_drop.leader_only = false (随机分给幸存者)',
            rewards.rare_drop?.leader_only === false, '');

        // 杀戮分加成
        check('rewards.kill_score_bonus.exp_per_10_kill_score = 2000',
            rewards.kill_score_bonus?.exp_per_10_kill_score === 2000, '');
        check('rewards.kill_score_bonus.spirit_stones_per_10_kill_score = 150',
            rewards.kill_score_bonus?.spirit_stones_per_10_kill_score === 150, '');

        // 幸存者加成
        check('rewards.survivor_bonus.exp_per_survivor = 5000',
            rewards.survivor_bonus?.exp_per_survivor === 5000, '');
        check('rewards.survivor_bonus.spirit_stones_per_survivor = 800',
            rewards.survivor_bonus?.spirit_stones_per_survivor === 800, '');

        // 完美通关加成
        check('rewards.perfect_bonus.exp = 10000',
            rewards.perfect_bonus?.exp === 10000, '');
        check('rewards.perfect_bonus.spirit_stones = 2000',
            rewards.perfect_bonus?.spirit_stones === 2000, '');

        // 称号
        check('rewards.title = "blood_purgatory_survivor"',
            rewards.title === 'blood_purgatory_survivor', '');
        check('rewards.title_chance = 0.3 (30%)',
            rewards.title_chance === 0.3, `actual=${rewards.title_chance}`);
    }

    // ===== 场景3：模型字段校验 =====
    console.log('\n[场景3] 模型字段校验 - 血色试炼专属字段已同步至 Sequelize 模型');

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
    check('MultiDungeonInstance 含 blood_qi_avg 字段',
        instanceModelCode.includes('blood_qi_avg:'), '');
    check('MultiDungeonInstance 含 blood_fury 字段',
        instanceModelCode.includes('blood_fury:'), '');
    check('MultiDungeonInstance 含 eliminations 字段',
        instanceModelCode.includes('eliminations:'), '');
    check('MultiDungeonInstance 含 survivor_count 字段',
        instanceModelCode.includes('survivor_count:'), '');
    check('MultiDungeonInstance 含 xuese_boss_hp 字段',
        instanceModelCode.includes('xuese_boss_hp:'), '');
    check('MultiDungeonInstance.xuese_boss_hp 类型为 BIGINT',
        /xuese_boss_hp:[\s\S]{0,200}DataTypes\.BIGINT/.test(instanceModelCode), '');

    // 3.2 抉择模型字段
    check('MultiDungeonChoice 含 blood_qi_self_change 字段',
        choiceModelCode.includes('blood_qi_self_change:'), '');
    check('MultiDungeonChoice 含 blood_qi_others_change 字段',
        choiceModelCode.includes('blood_qi_others_change:'), '');
    check('MultiDungeonChoice 含 kill_score_change 字段',
        choiceModelCode.includes('kill_score_change:'), '');
    check('MultiDungeonChoice 含 blood_fury_change 字段',
        choiceModelCode.includes('blood_fury_change:'), '');

    // 3.3 成员模型字段
    check('MultiDungeonMember 含 blood_qi 字段',
        memberModelCode.includes('blood_qi:'), '');
    check('MultiDungeonMember 含 kill_score 字段',
        memberModelCode.includes('kill_score:'), '');
    check('MultiDungeonMember 含 is_eliminated 字段',
        memberModelCode.includes('is_eliminated:'), '');
    check('MultiDungeonMember.is_eliminated 类型为 TINYINT',
        /is_eliminated:[\s\S]{0,200}DataTypes\.TINYINT/.test(memberModelCode), '');

    // ===== 场景4：物品配置校验 =====
    console.log('\n[场景4] 物品配置校验 - 血色试炼相关物品已定义');

    const itemData = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/item_data.json'), 'utf8')
    );

    const items = itemData.items || [];
    const itemMap = new Map(items.map(i => [i.id, i]));

    // 4.1 必需物品列表
    const requiredItems = [
        { id: 'blood_token', name: '血色令牌', expectedType: 'consumable', expectedSubtype: 'ticket' },
        { id: 'blood_soul_crystal', name: '血魂晶', expectedType: 'material', expectedSubtype: 'crystal' },
        { id: 'blood_sha_charm', name: '血煞符', expectedType: 'material', expectedSubtype: 'charm' },
        { id: 'blood_relic_fragment', name: '血色遗物残片', expectedType: 'material', expectedSubtype: 'relic' },
        { id: 'blood_blade_remnant', name: '血色残刃', expectedType: 'material', expectedSubtype: 'weapon_part' },
        { id: 'blood_battle_armor', name: '血色战甲', expectedType: 'material', expectedSubtype: 'armor' }
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
    const bloodToken = itemMap.get('blood_token');
    if (bloodToken) {
        check('blood_token.quality = "legendary"',
            bloodToken.quality === 'legendary', `actual=${bloodToken.quality}`);
        check('blood_token.effect 包含 dungeon_ticket: "xuese"',
            bloodToken.effect?.dungeon_ticket === 'xuese', '');
    }

    // 4.3 首通奖励物品特殊校验
    const bloodBladeRemnant = itemMap.get('blood_blade_remnant');
    if (bloodBladeRemnant) {
        check('blood_blade_remnant.quality = "legendary"',
            bloodBladeRemnant.quality === 'legendary', `actual=${bloodBladeRemnant.quality}`);
    }

    // 4.4 稀有掉落物品特殊校验
    const bloodBattleArmor = itemMap.get('blood_battle_armor');
    if (bloodBattleArmor) {
        check('blood_battle_armor.quality = "epic"',
            bloodBattleArmor.quality === 'epic', `actual=${bloodBattleArmor.quality}`);
    }

    // ===== 场景5：迁移脚本校验 =====
    console.log('\n[场景5] 迁移脚本校验 - migration_0058 存在且字段完整');

    const migrationPath = path.join(__dirname, 'migration_0058_xuese_fields.js');
    check('migration_0058_xuese_fields.js 文件存在', fs.existsSync(migrationPath), '');

    if (fs.existsSync(migrationPath)) {
        const migrationCode = fs.readFileSync(migrationPath, 'utf-8');

        // 5.1 字段添加逻辑
        const requiredMigrationColumns = [
            // instance 表
            { table: 'multi_dungeon_instance', column: 'blood_qi_avg' },
            { table: 'multi_dungeon_instance', column: 'blood_fury' },
            { table: 'multi_dungeon_instance', column: 'eliminations' },
            { table: 'multi_dungeon_instance', column: 'survivor_count' },
            { table: 'multi_dungeon_instance', column: 'xuese_boss_hp' },
            // choice 表
            { table: 'multi_dungeon_choice', column: 'blood_qi_self_change' },
            { table: 'multi_dungeon_choice', column: 'blood_qi_others_change' },
            { table: 'multi_dungeon_choice', column: 'kill_score_change' },
            { table: 'multi_dungeon_choice', column: 'blood_fury_change' },
            // member 表
            { table: 'multi_dungeon_member', column: 'blood_qi' },
            { table: 'multi_dungeon_member', column: 'kill_score' },
            { table: 'multi_dungeon_member', column: 'is_eliminated' }
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

        // 5.4 xuese_boss_hp 字段类型为 BIGINT
        check('迁移脚本 xuese_boss_hp 字段类型为 BIGINT',
            migrationCode.includes('BIGINT DEFAULT NULL') ||
            /xuese_boss_hp[\s\S]{0,200}BIGINT/.test(migrationCode), '');

        // 5.5 is_eliminated 字段类型为 TINYINT(1)
        check('迁移脚本 is_eliminated 字段类型为 TINYINT(1)',
            migrationCode.includes('TINYINT(1)'), '');
    }

    // ===== 场景6：接口路由校验 =====
    console.log('\n[场景6] 接口路由 - /api/multi-dungeon/* 支持 xuese');

    const routeCode = fs.readFileSync(
        path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8'
    );

    check('路由 create 接口白名单包含 xuese',
        routeCode.includes("'xuese'"), '');
    check('路由 create 接口注释提及血色试炼',
        routeCode.includes('血色试炼'), '');
    check('路由 rewards 接口白名单包含 xuese',
        /rewards[\s\S]{0,2000}'xuese'/.test(routeCode), '');

    // ===== 场景7：接口端到端测试 =====
    console.log('\n[场景7] 接口端到端测试 - 血色试炼只读接口');

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
        // 7.1 /help 应返回 xuese
        const helpRes = await api('GET', '/api/multi-dungeon/help', token);
        check('/api/multi-dungeon/help 返回 200',
            helpRes.status === 200, `status=${helpRes.status}`);

        if (helpRes.json?.data?.dungeons?.xuese) {
            const xueseHelp = helpRes.json.data.dungeons.xuese;
            check('help 返回 xuese.name = "血色试炼"',
                xueseHelp.name === '血色试炼', `actual=${xueseHelp.name}`);
            check('help 返回 xuese.member_min = 4',
                xueseHelp.member_min === 4, `actual=${xueseHelp.member_min}`);
            check('help 返回 xuese.member_max = 6',
                xueseHelp.member_max === 6, `actual=${xueseHelp.member_max}`);
            console.log(`\n  📊 血色试炼帮助信息：`);
            console.log(`     名称: ${xueseHelp.name}`);
            console.log(`     人数: ${xueseHelp.member_min}-${xueseHelp.member_max} 人`);
            console.log(`     队长境界: ${xueseHelp.leader_min_realm} (rank≥${xueseHelp.leader_min_realm_rank})`);
            console.log(`     队员境界: ${xueseHelp.member_min_realm} (rank≥${xueseHelp.member_min_realm_rank})`);
            console.log(`     消耗物品: ${xueseHelp.consume_item_key} ×${xueseHelp.consume_item_count}`);
            console.log(`     冷却: ${xueseHelp.cooldown_hours} 小时`);
            console.log(`     流程: ${xueseHelp.act_count} 幕`);
        } else {
            check('help 返回 xuese 配置', false, 'help 响应未包含 xuese');
        }

        // 7.2 /rewards?dungeon_key=xuese 应返回血色试炼奖励详情
        const rewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=xuese', token);
        check('/api/multi-dungeon/rewards?dungeon_key=xuese 返回 200',
            rewardsRes.status === 200, `status=${rewardsRes.status}`);

        if (rewardsRes.json?.data) {
            const data = rewardsRes.json.data;
            check('rewards 响应包含血色试炼',
                data.dungeon_key === 'xuese' || data.name === '血色试炼',
                `data=${JSON.stringify(data).substring(0, 100)}`);

            console.log(`\n  📊 血色试炼奖励信息：`);
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
                if (data.rewards.kill_score_bonus) {
                    console.log(`     杀戮分加成: 每10点 +${data.rewards.kill_score_bonus.exp_per_10_kill_score}修为`);
                }
                if (data.rewards.survivor_bonus) {
                    console.log(`     幸存者加成: 每位幸存者 +${data.rewards.survivor_bonus.exp_per_survivor}修为`);
                }
                if (data.rewards.perfect_bonus) {
                    console.log(`     完美通关加成: +${data.rewards.perfect_bonus.exp}修为 +${data.rewards.perfect_bonus.spirit_stones}灵石`);
                }
            }
        }

        // 7.3 /cooldown 应返回 xuese 冷却状态
        const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown', token);
        check('/api/multi-dungeon/cooldown 返回 200',
            cooldownRes.status === 200, `status=${cooldownRes.status}`);
        check('cooldown 响应包含 xuese 键',
            cooldownRes.json?.data?.cooldowns?.xuese !== undefined,
            `keys=${Object.keys(cooldownRes.json?.data?.cooldowns || {}).join(',')}`);

        // 7.4 尝试创建血色试炼副本（预期失败：物品不足或冷却或已在副本中）
        // 注：测试账号是化神期 rank=23 admin，境界满足要求（leader_min_realm_rank=13）
        const createRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'xuese'
        });
        check('POST /api/multi-dungeon/create xuese 接口可调用',
            createRes.status === 200 || createRes.status === 400,
            `status=${createRes.status}`);

        if (createRes.json) {
            if (createRes.status === 200 && createRes.json?.data?.instance_id) {
                console.log(`     ⚠️  警告：测试账号创建了血色试炼副本实例（instance_id=${createRes.json.data.instance_id}）`);
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
