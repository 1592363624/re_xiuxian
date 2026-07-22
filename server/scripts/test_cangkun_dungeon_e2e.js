/**
 * 苍坤洞府副本端到端测试
 *
 * 目的：验证苍坤洞府（cangkun）3-5人剧情副本的配置完整性、服务方法存在性、
 *      接口可用性、动态权重掉落机制、escape_choice 脱身抉择流程。
 *
 * 测试范围：
 *   1. 静态代码扫描：MultiDungeonService 包含苍坤专属方法 _processCangkunFinalAct
 *   2. 配置完整性：4 幕流程 / 3 专属变量 / escape_choices / 动态权重掉落公式
 *   3. 变量边界：forbidden_rift(0-100) / scroll_clue(0-100) / escape_difficulty(0-100) / cangkun_guardian_hp(BIGINT)
 *   4. 模型字段：MultiDungeonInstance 与 MultiDungeonChoice 含苍坤专属字段
 *   5. 接口路由：/api/multi-dungeon/create 与 /api/multi-dungeon/advance 支持 cangkun
 *   6. 物品配置：cangkun_pass_token / qianji_fragment / moon_shadow_letter 等 10 个物品已定义
 *   7. 只读接口：/help、/rewards、/cooldown 返回 cangkun 信息
 *   8. 创建接口：测试账号尝试创建苍坤洞府，预期因物品不足或冷却被拦截
 *
 * 玩法文档对照：
 *   - 苍坤洞府：3-5人剧情副本，4幕抉择：入府探秘→搜寻宝物→禁制触发→脱身抉择
 *   - 3 个专属变量：forbidden_rift(禁制裂隙) / scroll_clue(卷轴线索) / escape_difficulty(脱身难度)
 *   - 脱身抉择影响掩月抢亲门票线索动态掉率
 *   - 动态权重公式：final_chance = base_chance * (1 + scroll_clue/100 + forbidden_rift/100 + escape_choice_bonus)
 *
 * 测试账号：1592363624 / 1592363624（韩天尊，化神初期 rank=23，admin）
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
    console.log('  苍坤洞府副本端到端测试 (cangkun)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 苍坤洞府专属方法与变量边界 =====
    console.log('[场景1] 静态代码扫描 - 苍坤洞府专属方法与变量边界');

    const serviceCode = fs.readFileSync(
        path.join(__dirname, '../game/services/MultiDungeonService.js'), 'utf-8'
    );

    check('MultiDungeonService 包含 _processCangkunFinalAct 方法',
        /static\s+async\s+_processCangkunFinalAct\s*\(/.test(serviceCode), '');

    check('create 方法白名单包含 cangkun',
        serviceCode.includes("'cangkun'"), '');

    check('VARIABLE_BOUNDS 包含 forbidden_rift',
        /forbidden_rift:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 scroll_clue',
        /scroll_clue:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 escape_difficulty',
        /escape_difficulty:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('苍坤洞府专属变量初始化逻辑存在（init_forbidden_rift）',
        serviceCode.includes('instanceData.forbidden_rift = dungeonCfg.init_forbidden_rift'), '');

    check('苍坤洞府专属变量初始化逻辑存在（init_scroll_clue）',
        serviceCode.includes('instanceData.scroll_clue = dungeonCfg.init_scroll_clue'), '');

    check('苍坤洞府专属变量初始化逻辑存在（init_escape_difficulty）',
        serviceCode.includes('instanceData.escape_difficulty = dungeonCfg.init_escape_difficulty'), '');

    check('苍坤洞府抉择变量应用逻辑（forbidden_rift_change）',
        serviceCode.includes('choice.forbidden_rift_change'), '');

    check('苍坤洞府抉择变量应用逻辑（scroll_clue_change）',
        serviceCode.includes('choice.scroll_clue_change'), '');

    check('苍坤洞府抉择变量应用逻辑（escape_difficulty_change）',
        serviceCode.includes('choice.escape_difficulty_change'), '');

    check('苍坤洞府最终幕处理（finalActHandler 三分支）',
        serviceCode.includes("instance.instance_key === 'cangkun'") &&
        serviceCode.includes('_processCangkunFinalAct'), '');

    check('苍坤洞府动态权重掉落公式实现（ticket_clue_drops）',
        serviceCode.includes('rewards.ticket_clue_drops') &&
        serviceCode.includes('dynamicMultiplier'), '');

    check('苍坤洞府 escape_choice 校验逻辑',
        serviceCode.includes("instance.instance_key === 'cangkun'") &&
        serviceCode.includes('escapeChoiceKey'), '');

    check('苍坤洞府 escape_difficulty 加成逻辑（forced_breakout/stealth_escape）',
        serviceCode.includes("instance.escape_choice === 'forced_breakout'") &&
        serviceCode.includes("instance.escape_choice === 'stealth_escape'"), '');

    // ===== 场景2：配置完整性 - 4 幕流程 / 3 专属变量 / escape_choices =====
    console.log('\n[场景2] 配置完整性 - 苍坤洞府 4 幕流程');

    const config = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/multi_dungeon_data.json'), 'utf-8')
    );

    const cangkun = config.dungeons?.cangkun;
    check('cangkun 配置块存在', cangkun !== undefined, '');

    if (cangkun) {
        check('cangkun.name = "苍坤洞府"', cangkun.name === '苍坤洞府', `actual=${cangkun.name}`);
        check('cangkun.desc 不为空', typeof cangkun.desc === 'string' && cangkun.desc.length > 10, '');
        check('cangkun.member_min = 3', cangkun.member_min === 3, `actual=${cangkun.member_min}`);
        check('cangkun.member_max = 5', cangkun.member_max === 5, `actual=${cangkun.member_max}`);
        check('cangkun.leader_min_realm = "结丹后期"',
            cangkun.leader_min_realm === '结丹后期',
            `actual=${cangkun.leader_min_realm}`);
        check('cangkun.leader_min_realm_rank = 17',
            cangkun.leader_min_realm_rank === 17,
            `actual=${cangkun.leader_min_realm_rank}`);
        check('cangkun.member_min_realm_rank = 13',
            cangkun.member_min_realm_rank === 13,
            `actual=${cangkun.member_min_realm_rank}`);
        check('cangkun.consume_item_key = "cangkun_pass_token"',
            cangkun.consume_item_key === 'cangkun_pass_token',
            `actual=${cangkun.consume_item_key}`);
        check('cangkun.consume_item_count = 1', cangkun.consume_item_count === 1, '');
        check('cangkun.cooldown_hours = 48', cangkun.cooldown_hours === 48, '');
        check('cangkun.expire_hours = 2', cangkun.expire_hours === 2, '');

        // 苍坤专属初始化变量
        check('cangkun.init_forbidden_rift = 0', cangkun.init_forbidden_rift === 0, '');
        check('cangkun.init_scroll_clue = 0', cangkun.init_scroll_clue === 0, '');
        check('cangkun.init_escape_difficulty = 30', cangkun.init_escape_difficulty === 30, '');

        // 守灵HP基础值
        check('cangkun.cangkun_guardian_hp_base = 800000',
            cangkun.cangkun_guardian_hp_base === 800000, '');

        // 完美通关阈值
        check('cangkun.perfect_clear_morale_min = 50',
            cangkun.perfect_clear_morale_min === 50, '');
        check('cangkun.perfect_clear_soul_stability_min = 60',
            cangkun.perfect_clear_soul_stability_min === 60, '');

        // 4 幕流程校验
        check('cangkun.acts 数组长度 = 4',
            Array.isArray(cangkun.acts) && cangkun.acts.length === 4,
            `actual=${cangkun.acts?.length}`);

        if (Array.isArray(cangkun.acts) && cangkun.acts.length === 4) {
            const act1 = cangkun.acts[0];
            const act2 = cangkun.acts[1];
            const act3 = cangkun.acts[2];
            const act4 = cangkun.acts[3];

            check('第1幕 act_key = "enter_cave"', act1.act_key === 'enter_cave', '');
            check('第1幕 is_entry_act = true', act1.is_entry_act === true, '');
            check('第1幕有 3 个 choices', Array.isArray(act1.choices) && act1.choices.length === 3,
                `actual=${act1.choices?.length}`);

            check('第2幕 act_key = "search_treasure"', act2.act_key === 'search_treasure', '');
            check('第2幕 is_random_choice = true', act2.is_random_choice === true, '');
            check('第2幕 random_pool 长度 = 5',
                Array.isArray(act2.random_pool) && act2.random_pool.length === 5,
                `actual=${act2.random_pool?.length}`);
            check('第2幕 random_choice_count = 3', act2.random_choice_count === 3, '');

            check('第3幕 act_key = "trigger_seal"', act3.act_key === 'trigger_seal', '');
            check('第3幕有 3 个 choices', Array.isArray(act3.choices) && act3.choices.length === 3,
                `actual=${act3.choices?.length}`);

            check('第4幕 act_key = "escape_choice"', act4.act_key === 'escape_choice', '');
            check('第4幕 is_auto_advance = true', act4.is_auto_advance === true, '');
            check('第4幕 is_final_act = true', act4.is_final_act === true, '');
            check('第4幕 rounds_max = 5', act4.rounds_max === 5, '');
            check('第4幕 damage_per_round_base = 150000',
                act4.damage_per_round_base === 150000, '');
            check('第4幕 damage_scroll_bonus_per_point = 2000',
                act4.damage_scroll_bonus_per_point === 2000, '');

            // escape_choices 校验
            check('第4幕 escape_choices 数组长度 = 3',
                Array.isArray(act4.escape_choices) && act4.escape_choices.length === 3,
                `actual=${act4.escape_choices?.length}`);

            if (Array.isArray(act4.escape_choices) && act4.escape_choices.length === 3) {
                const escapeKeys = act4.escape_choices.map(c => c.escape_choice).sort();
                check('escape_choices 包含 forced_breakout/formation_escape/stealth_escape',
                    escapeKeys.join(',') === 'forced_breakout,formation_escape,stealth_escape',
                    `actual=${escapeKeys.join(',')}`);

                const forcedBreakout = act4.escape_choices.find(c => c.escape_choice === 'forced_breakout');
                const formationEscape = act4.escape_choices.find(c => c.escape_choice === 'formation_escape');
                const stealthEscape = act4.escape_choices.find(c => c.escape_choice === 'stealth_escape');

                check('forced_breakout escape_difficulty_change = 30',
                    forcedBreakout?.escape_difficulty_change === 30, '');
                check('forced_breakout ticket_clue_bonus = 0.0',
                    forcedBreakout?.ticket_clue_bonus === 0.0, '');

                check('formation_escape escape_difficulty_change = 10',
                    formationEscape?.escape_difficulty_change === 10, '');
                check('formation_escape ticket_clue_bonus = 0.3',
                    formationEscape?.ticket_clue_bonus === 0.3, '');

                check('stealth_escape escape_difficulty_change = 0',
                    stealthEscape?.escape_difficulty_change === 0, '');
                check('stealth_escape ticket_clue_bonus = 0.5',
                    stealthEscape?.ticket_clue_bonus === 0.5, '');
            }

            // 通关 / 失败条件
            check('第4幕 clear_condition.guardian_hp_zero = true',
                act4.clear_condition?.guardian_hp_zero === true, '');
            check('第4幕 fail_condition 包含 morale_lte 与 soul_stability_lte',
                act4.fail_condition?.morale_lte !== undefined &&
                act4.fail_condition?.soul_stability_lte !== undefined, '');
        }

        // 奖励配置校验
        const rewards = cangkun.rewards;
        check('rewards.base_rewards 数组长度 = 3',
            Array.isArray(rewards.base_rewards) && rewards.base_rewards.length === 3,
            `actual=${rewards.base_rewards?.length}`);
        check('rewards.normal_drops 数组长度 ≥ 5',
            Array.isArray(rewards.normal_drops) && rewards.normal_drops.length >= 5,
            `actual=${rewards.normal_drops?.length}`);
        check('rewards.first_clear_bonus 包含千机残篇',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.item_key === 'qianji_fragment'), '');

        check('rewards.rare_drop.item_key = "puppet_blueprint_ying"',
            rewards.rare_drop?.item_key === 'puppet_blueprint_ying', '');
        check('rewards.rare_drop.chance = 0.005',
            rewards.rare_drop?.chance === 0.005, '');

        // 动态权重掉落配置
        check('rewards.ticket_clue_drops.drops 数组长度 = 2',
            Array.isArray(rewards.ticket_clue_drops?.drops) &&
            rewards.ticket_clue_drops.drops.length === 2,
            `actual=${rewards.ticket_clue_drops?.drops?.length}`);

        const moonShadow = rewards.ticket_clue_drops?.drops?.find(d => d.item_key === 'moon_shadow_letter');
        const yanyueSecret = rewards.ticket_clue_drops?.drops?.find(d => d.item_key === 'yanyue_secret');
        check('月影传书残页 base_chance = 0.0759',
            moonShadow?.base_chance === 0.0759, `actual=${moonShadow?.base_chance}`);
        check('掩月密讯 base_chance = 0.0316',
            yanyueSecret?.base_chance === 0.0316, `actual=${yanyueSecret?.base_chance}`);

        const escapeBonus = rewards.ticket_clue_drops?.escape_choice_bonus;
        check('escape_choice_bonus.forced_breakout = 0.0',
            escapeBonus?.forced_breakout === 0.0, '');
        check('escape_choice_bonus.formation_escape = 0.3',
            escapeBonus?.formation_escape === 0.3, '');
        check('escape_choice_bonus.stealth_escape = 0.5',
            escapeBonus?.stealth_escape === 0.5, '');

        // 卷轴线索加成
        check('rewards.scroll_clue_bonus.exp_per_10_scroll_clue = 1000',
            rewards.scroll_clue_bonus?.exp_per_10_scroll_clue === 1000, '');
        check('rewards.scroll_clue_bonus.spirit_stones_per_10_scroll_clue = 100',
            rewards.scroll_clue_bonus?.spirit_stones_per_10_scroll_clue === 100, '');

        // 禁制裂隙稀有掉落加成
        check('rewards.forbidden_rift_bonus.rare_drop_bonus_per_10_rift = 0.03',
            rewards.forbidden_rift_bonus?.rare_drop_bonus_per_10_rift === 0.03, '');

        // 完美通关加成
        check('rewards.perfect_bonus.exp = 3000',
            rewards.perfect_bonus?.exp === 3000, '');
        check('rewards.perfect_bonus.spirit_stones = 500',
            rewards.perfect_bonus?.spirit_stones === 500, '');

        // 称号
        check('rewards.title = "cangkun_explorer"',
            rewards.title === 'cangkun_explorer', '');
        check('rewards.title_chance = 0.20',
            rewards.title_chance === 0.20, '');
    }

    // ===== 场景3：模型字段校验 =====
    console.log('\n[场景3] 模型字段校验 - 苍坤专属字段已添加');

    const instanceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonInstance.js'), 'utf-8'
    );
    const choiceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonChoice.js'), 'utf-8'
    );

    check('MultiDungeonInstance 含 forbidden_rift 字段',
        instanceModelCode.includes('forbidden_rift:'), '');
    check('MultiDungeonInstance 含 scroll_clue 字段',
        instanceModelCode.includes('scroll_clue:'), '');
    check('MultiDungeonInstance 含 escape_difficulty 字段',
        instanceModelCode.includes('escape_difficulty:'), '');
    check('MultiDungeonInstance 含 escape_choice 字段',
        instanceModelCode.includes('escape_choice:'), '');
    check('MultiDungeonInstance 含 cangkun_guardian_hp 字段',
        instanceModelCode.includes('cangkun_guardian_hp:'), '');

    check('MultiDungeonChoice 含 forbidden_rift_change 字段',
        choiceModelCode.includes('forbidden_rift_change:'), '');
    check('MultiDungeonChoice 含 scroll_clue_change 字段',
        choiceModelCode.includes('scroll_clue_change:'), '');
    check('MultiDungeonChoice 含 escape_difficulty_change 字段',
        choiceModelCode.includes('escape_difficulty_change:'), '');
    check('MultiDungeonChoice 含 cangkun_guardian_hp_change 字段',
        choiceModelCode.includes('cangkun_guardian_hp_change:'), '');

    // ===== 场景4：物品配置校验 =====
    console.log('\n[场景4] 物品配置校验 - 苍坤相关物品已定义');

    const itemData = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/item_data.json'), 'utf-8')
    );

    // item_data.json 结构：{ items: [...] } 或类似
    const items = itemData.items || itemData.dungeons || [];
    const itemIds = new Set(items.map(i => i.id));

    const requiredItems = [
        'cangkun_pass_token', 'cangkun_old_seal_fragment', 'cangkun_rune_scroll',
        'ancient_puppet_fragment', 'soul_crystal', 'qianji_fragment',
        'moon_shadow_letter', 'yanyue_secret', 'puppet_blueprint_ying', 'fabao_tupu'
    ];

    for (const itemId of requiredItems) {
        check(`物品 ${itemId} 已定义`, itemIds.has(itemId), '');
    }

    // ===== 场景5：迁移脚本校验 =====
    console.log('\n[场景5] 迁移脚本校验 - migration_0057 存在');

    const migrationPath = path.join(__dirname, 'migration_0057_cangkun_fields.js');
    check('migration_0057_cangkun_fields.js 文件存在', fs.existsSync(migrationPath), '');

    if (fs.existsSync(migrationPath)) {
        const migrationCode = fs.readFileSync(migrationPath, 'utf-8');
        check('迁移脚本包含 forbidden_rift 字段添加',
            migrationCode.includes('forbidden_rift'), '');
        check('迁移脚本包含 cangkun_guardian_hp 字段添加',
            migrationCode.includes('cangkun_guardian_hp'), '');
        check('迁移脚本包含 down 回滚逻辑',
            migrationCode.includes('down:') && migrationCode.includes('DROP COLUMN'), '');
    }

    // ===== 场景6：接口路由校验 =====
    console.log('\n[场景6] 接口路由 - /api/multi-dungeon/* 支持 cangkun');

    const routeCode = fs.readFileSync(
        path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8'
    );

    check('路由 create 接口白名单包含 cangkun',
        routeCode.includes("'cangkun'"), '');
    check('路由 rewards 接口白名单包含 cangkun',
        /rewards[\s\S]*?'cangkun'/.test(routeCode), '');
    check('路由 advance 接口支持 escape_choice 参数',
        routeCode.includes('escape_choice'), '');
    check('路由 advance 接口校验 forced_breakout/formation_escape/stealth_escape',
        routeCode.includes('forced_breakout') &&
        routeCode.includes('formation_escape') &&
        routeCode.includes('stealth_escape'), '');

    // ===== 场景7：接口端到端测试 =====
    console.log('\n[场景7] 接口端到端测试 - 苍坤洞府只读接口');

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
        // /help 应返回 cangkun
        const helpRes = await api('GET', '/api/multi-dungeon/help', token);
        check('/api/multi-dungeon/help 返回 200',
            helpRes.status === 200, `status=${helpRes.status}`);

        if (helpRes.json?.data?.dungeons?.cangkun) {
            const cangkunHelp = helpRes.json.data.dungeons.cangkun;
            check('help 返回 cangkun.name = "苍坤洞府"',
                cangkunHelp.name === '苍坤洞府', `actual=${cangkunHelp.name}`);
            check('help 返回 cangkun.member_min = 3',
                cangkunHelp.member_min === 3, `actual=${cangkunHelp.member_min}`);
            check('help 返回 cangkun.member_max = 5',
                cangkunHelp.member_max === 5, `actual=${cangkunHelp.member_max}`);
            console.log(`\n  📊 苍坤洞府帮助信息：`);
            console.log(`     名称: ${cangkunHelp.name}`);
            console.log(`     人数: ${cangkunHelp.member_min}-${cangkunHelp.member_max} 人`);
            console.log(`     队长境界: ${cangkunHelp.leader_min_realm} (rank≥${cangkunHelp.leader_min_realm_rank})`);
            console.log(`     队员境界: ${cangkunHelp.member_min_realm} (rank≥${cangkunHelp.member_min_realm_rank})`);
            console.log(`     消耗物品: ${cangkunHelp.consume_item_key} ×${cangkunHelp.consume_item_count}`);
            console.log(`     冷却: ${cangkunHelp.cooldown_hours} 小时`);
            console.log(`     流程: ${cangkunHelp.act_count} 幕`);
        } else {
            check('help 返回 cangkun 配置', false, 'help 响应未包含 cangkun');
        }

        // /rewards?dungeon_key=cangkun 应返回苍坤洞府奖励详情
        const rewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=cangkun', token);
        check('/api/multi-dungeon/rewards?dungeon_key=cangkun 返回 200',
            rewardsRes.status === 200, `status=${rewardsRes.status}`);

        if (rewardsRes.json?.data) {
            const data = rewardsRes.json.data;
            check('rewards 响应包含苍坤洞府',
                data.dungeon_key === 'cangkun' || data.name === '苍坤洞府',
                `data=${JSON.stringify(data).substring(0, 100)}`);

            console.log(`\n  📊 苍坤洞府奖励信息：`);
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
                    console.log(`     首通奖励: ${JSON.stringify(data.rewards.first_clear_bonus).substring(0, 80)}`);
                }
            }
        }

        // /cooldown 应返回 cangkun 冷却状态
        const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown', token);
        check('/api/multi-dungeon/cooldown 返回 200',
            cooldownRes.status === 200, `status=${cooldownRes.status}`);
        check('cooldown 响应包含 cangkun 键',
            cooldownRes.json?.data?.cooldowns?.cangkun !== undefined,
            `keys=${Object.keys(cooldownRes.json?.data?.cooldowns || {}).join(',')}`);

        // 尝试创建苍坤洞府副本（预期失败：物品不足或冷却或已在副本中）
        // 注：测试账号是化神期 rank=23 admin，境界满足要求（leader_min_realm_rank=17）
        const createRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'cangkun'
        });
        check('POST /api/multi-dungeon/create cangkun 接口可调用',
            createRes.status === 200 || createRes.status === 400,
            `status=${createRes.status}`);

        if (createRes.json) {
            // 预期失败原因：物品不足 / 已在副本中 / 冷却中
            // 若成功则说明物品充足且无冷却，需要清理
            if (createRes.status === 200 && createRes.json?.data?.instance_id) {
                console.log(`     ⚠️  警告：测试账号创建了苍坤洞府副本实例（instance_id=${createRes.json.data.instance_id}）`);
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

        // 错误的 dungeon_key 应被拒绝
        const wrongKeyRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'wrong_dungeon'
        });
        check('错误的 dungeon_key 应被拒绝',
            wrongKeyRes.status === 400, `status=${wrongKeyRes.status}`);

        // 错误的 escape_choice 应被拒绝（仅当调用 /advance 时校验）
        // 这里只能校验路由层的参数校验，无法直接测试 advance（因为没有 active 副本）
        const wrongEscapeRes = await api('POST', '/api/multi-dungeon/advance', token, {
            escape_choice: 'wrong_escape'
        });
        check('错误的 escape_choice 应被路由层拒绝（400）',
            wrongEscapeRes.status === 400, `status=${wrongEscapeRes.status}`);
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
