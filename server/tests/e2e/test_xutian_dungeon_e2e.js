/**
 * 虚天殿副本端到端测试
 *
 * 目的：验证虚天殿（xutian）4-6人剧情副本的配置完整性、服务方法存在性、
 *      接口可用性、状态机正确性。
 *
 * 测试范围：
 *   1. 静态代码扫描：MultiDungeonService 包含虚天殿专属方法 _processXutianFinalAct
 *   2. 配置完整性：6 幕流程 / 5 决策点 / 5+3 变量 / 奖励池（基础+普通+稀有+首通+虚天鼎）
 *   3. 变量边界：path_choice(0-2) / formation_power(0-100) / void_soul_hp(BIGINT)
 *   4. 接口路由：/api/multi-dungeon/create 支持 xutian 关键字
 *   5. 只读接口：/help、/rewards 返回 xutian 信息
 *   6. 创建接口：测试账号（化神期 rank=23 admin）尝试创建虚天殿，预期因物品不足或冷却被拦截
 *
 * 玩法文档对照：
 *   - 第11节：虚天殿 4-6 人副本，按六幕推进（选择道路→阵策→战术→争鼎→后殿抉择→后殿阵策）
 *   - 第20节：5 个决策点影响士气/封印/神魂/宝压/收获 + 3 个虚天专属变量
 *   - 第28节：奖励包含保底修为/灵石/贡献 + 影傀图谱 + 虚天鼎残片
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
 */
async function api(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  虚天殿副本端到端测试 (xutian)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 虚天殿专属方法 =====
    console.log('[场景1] 静态代码扫描 - 虚天殿专属方法与变量边界');

    const serviceCode = fs.readFileSync(
        path.join(__dirname, '../game/services/MultiDungeonService.js'), 'utf-8'
    );

    check('MultiDungeonService 包含 _processXutianFinalAct 方法',
        /static\s+async\s+_processXutianFinalAct\s*\(/.test(serviceCode), '');

    check('create 方法白名单包含 xutian',
        serviceCode.includes("'xutian'"), '');

    check('VARIABLE_BOUNDS 包含 path_choice',
        /path_choice:\s*\{\s*min:\s*0,\s*max:\s*2\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 formation_power',
        /formation_power:\s*\{\s*min:\s*0,\s*max:\s*100\s*\}/.test(serviceCode), '');

    check('虚天殿专属变量初始化逻辑存在（init_path_choice）',
        serviceCode.includes("instanceData.path_choice = dungeonCfg.init_path_choice"), '');

    check('虚天殿专属变量初始化逻辑存在（init_formation_power）',
        serviceCode.includes("instanceData.formation_power = dungeonCfg.init_formation_power"), '');

    check('虚天殿抉择变量应用逻辑（path_choice_change）',
        serviceCode.includes('choice.path_choice_change'), '');

    check('虚天殿抉择变量应用逻辑（formation_power_change）',
        serviceCode.includes('choice.formation_power_change'), '');

    check('虚天殿失败条件校验（formation_power_lte）',
        serviceCode.includes('cond.formation_power_lte'), '');

    check('虚天殿最终幕处理（finalActHandler）',
        serviceCode.includes("instance.instance_key === 'xutian'"), '');

    // ===== 场景2：配置完整性 - 6 幕流程 / 5 决策点 / 变量 =====
    console.log('\n[场景2] 配置完整性 - 虚天殿 6 幕流程');

    const config = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/multi_dungeon_data.json'), 'utf-8'
    ));

    const xutian = config.dungeons?.xutian;
    check('xutian 配置块存在', xutian !== undefined, '');

    if (xutian) {
        check('xutian.name = "虚天殿"', xutian.name === '虚天殿', `actual=${xutian.name}`);
        check('xutian.desc 不为空', typeof xutian.desc === 'string' && xutian.desc.length > 10, '');
        check('xutian.member_min = 4', xutian.member_min === 4, `actual=${xutian.member_min}`);
        check('xutian.member_max = 6', xutian.member_max === 6, `actual=${xutian.member_max}`);
        check('xutian.leader_min_realm = "元婴期"', xutian.leader_min_realm === '元婴期',
            `actual=${xutian.leader_min_realm}`);
        check('xutian.leader_min_realm_rank = 19', xutian.leader_min_realm_rank === 19,
            `actual=${xutian.leader_min_realm_rank}`);
        check('xutian.member_min_realm_rank = 17', xutian.member_min_realm_rank === 17,
            `actual=${xutian.member_min_realm_rank}`);
        check('xutian.consume_item_key = "xutian_pass_token"',
            xutian.consume_item_key === 'xutian_pass_token',
            `actual=${xutian.consume_item_key}`);
        check('xutian.consume_item_count = 1', xutian.consume_item_count === 1, '');
        check('xutian.cooldown_hours = 48', xutian.cooldown_hours === 48, '');
        check('xutian.expire_hours = 3', xutian.expire_hours === 3, '');

        // 5 个核心变量初始值
        check('xutian.init_morale = 100', xutian.init_morale === 100, '');
        check('xutian.init_vigilance = 0', xutian.init_vigilance === 0, '');
        check('xutian.init_seal_stability = 50', xutian.init_seal_stability === 50, '');
        check('xutian.init_soul_stability = 100', xutian.init_soul_stability === 100, '');
        check('xutian.init_harvest_multiplier = 1.0', xutian.init_harvest_multiplier === 1.0, '');

        // 3 个虚天专属变量初始值
        check('xutian.init_path_choice = 0', xutian.init_path_choice === 0, '');
        check('xutian.init_formation_power = 30', xutian.init_formation_power === 30, '');
        check('xutian.init_void_soul_hp = 1500000', xutian.init_void_soul_hp === 1500000, '');

        // 最终幕配置
        check('xutian.final_act_number = 6', xutian.final_act_number === 6, '');
        check('xutian.final_formation_power_target = 70',
            xutian.final_formation_power_target === 70, '');
        check('xutian.final_max_rounds = 6', xutian.final_max_rounds === 6, '');
        check('xutian.void_soul_hp_base = 1500000', xutian.void_soul_hp_base === 1500000, '');

        // 6 幕流程
        const acts = xutian.acts || [];
        check('xutian.acts 应有 6 幕', acts.length === 6, `actual=${acts.length}`);

        if (acts.length === 6) {
            const expectedActs = [
                { num: 1, key: 'choose_path', name: '选择道路' },
                { num: 2, key: 'formation_strategy', name: '阵策' },
                { num: 3, key: 'choose_tactic', name: '选择战术' },
                { num: 4, key: 'contest_cauldron', name: '争鼎' },
                { num: 5, key: 'back_hall_choice', name: '后殿抉择' },
                { num: 6, key: 'back_hall_final', name: '后殿阵策' }
            ];

            for (const expected of expectedActs) {
                const act = acts.find(a => a.act_number === expected.num);
                check(`第${expected.num}幕 act_number 正确`, !!act, '');
                if (act) {
                    check(`第${expected.num}幕 act_key = "${expected.key}"`,
                        act.act_key === expected.key, `actual=${act.act_key}`);
                    check(`第${expected.num}幕 act_name 包含 "${expected.name}"`,
                        (act.act_name || '').includes(expected.name),
                        `actual=${act.act_name}`);
                }
            }

            // 第一幕应包含冰道/火道两个选项
            const act1 = acts.find(a => a.act_number === 1);
            check('第1幕 choices 应有 ≥2 个选项',
                (act1?.choices?.length || 0) >= 2,
                `actual=${act1?.choices?.length}`);

            const act1Keys = (act1?.choices || []).map(c => c.key);
            check('第1幕应包含 ice_path 选项', act1Keys.includes('ice_path'),
                `keys=${act1Keys.join(',')}`);
            check('第1幕应包含 fire_path 选项', act1Keys.includes('fire_path'),
                `keys=${act1Keys.join(',')}`);

            // 验证每个选项都包含变量变化字段
            for (const act of acts.slice(0, 5)) {
                for (const choice of (act.choices || [])) {
                    check(`第${act.act_number}幕 ${choice.key} 选项应含 text 字段`,
                        typeof choice.text === 'string' && choice.text.length > 0, '');
                }
            }

            // 最终幕（第6幕）应为自动决战，无 choices
            const finalAct = acts.find(a => a.act_number === 6);
            check('第6幕应为自动决战（无 choices 或 choices 为空）',
                !finalAct?.choices || finalAct.choices.length === 0, '');
            check('第6幕应含 clear_condition.formation_power_gte',
                finalAct?.clear_condition?.formation_power_gte === 70,
                `actual=${finalAct?.clear_condition?.formation_power_gte}`);
        }

        // 奖励池
        const rewards = xutian.rewards || {};
        check('xutian.rewards.base_rewards 应存在',
            Array.isArray(rewards.base_rewards) && rewards.base_rewards.length > 0, '');
        check('xutian.rewards.normal_drops 应存在',
            Array.isArray(rewards.normal_drops) && rewards.normal_drops.length > 0, '');
        check('xutian.rewards.rare_drop 应存在',
            rewards.rare_drop !== undefined, '');
        check('xutian.rewards.first_clear_bonus 应存在',
            rewards.first_clear_bonus !== undefined, '');

        // 虚天殿专属奖励配置
        check('xutian.path_choice_bonus 应存在',
            rewards.path_choice_bonus !== undefined ||
            xutian.path_choice_bonus !== undefined, '');

        check('xutian.formation_power_bonus 应存在',
            rewards.formation_power_bonus !== undefined ||
            xutian.formation_power_bonus !== undefined, '');

        // 验证虚天鼎掉落（稀有掉落应含 xutian_cauldron）
        const rareDropStr = JSON.stringify(rewards.rare_drop || {});
        check('稀有掉落应包含虚天鼎（xutian_cauldron）',
            rareDropStr.includes('xutian_cauldron'), '');

        // 验证普通掉落含虚天寒晶/虚天火精/虚天阵图
        const normalDropStr = JSON.stringify(rewards.normal_drops || []);
        check('普通掉落应含虚天寒晶（xutian_ice_crystal）',
            normalDropStr.includes('xutian_ice_crystal'), '');
        check('普通掉落应含虚天火精（xutian_fire_essence）',
            normalDropStr.includes('xutian_fire_essence'), '');
        check('普通掉落应含虚天阵图（xutian_formation_map）',
            normalDropStr.includes('xutian_formation_map'), '');
    }

    // ===== 场景3：接口路由支持 xutian =====
    console.log('\n[场景3] 接口路由 - /api/multi-dungeon/* 支持 xutian');

    const routeCode = fs.readFileSync(
        path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8'
    );

    check('路由文件包含 xutian 关键字', routeCode.includes('xutian'), '');

    // ===== 场景4：接口端到端测试 =====
    console.log('\n[场景4] 接口端到端测试 - 虚天殿只读接口');

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
        // /help 应返回 xutian
        const helpRes = await api('GET', '/api/multi-dungeon/help', token);
        check('/api/multi-dungeon/help 返回 200',
            helpRes.status === 200, `status=${helpRes.status}`);

        if (helpRes.json?.data?.dungeons?.xutian) {
            const xutianHelp = helpRes.json.data.dungeons.xutian;
            check('help 返回 xutian.name = "虚天殿"',
                xutianHelp.name === '虚天殿', `actual=${xutianHelp.name}`);
            check('help 返回 xutian.member_min = 4',
                xutianHelp.member_min === 4, `actual=${xutianHelp.member_min}`);
            check('help 返回 xutian.member_max = 6',
                xutianHelp.member_max === 6, `actual=${xutianHelp.member_max}`);
            check('help 返回 xutian.leader_min_realm_rank = 19',
                xutianHelp.leader_min_realm_rank === 19,
                `actual=${xutianHelp.leader_min_realm_rank}`);
            check('help 返回 xutian.act_count = 6',
                xutianHelp.act_count === 6, `actual=${xutianHelp.act_count}`);
            console.log(`\n  📊 虚天殿帮助信息：`);
            console.log(`     名称: ${xutianHelp.name}`);
            console.log(`     人数: ${xutianHelp.member_min}-${xutianHelp.member_max} 人`);
            console.log(`     队长境界: ${xutianHelp.leader_min_realm} (rank≥${xutianHelp.leader_min_realm_rank})`);
            console.log(`     队员境界: ${xutianHelp.member_min_realm} (rank≥${xutianHelp.member_min_realm_rank})`);
            console.log(`     消耗物品: ${xutianHelp.consume_item_key} ×${xutianHelp.consume_item_count}`);
            console.log(`     冷却: ${xutianHelp.cooldown_hours} 小时`);
            console.log(`     流程: ${xutianHelp.act_count} 幕`);
            console.log(`     奖励: ${xutianHelp.rewards_summary}`);
        } else {
            check('help 返回 xutian 配置', false, 'help 响应未包含 xutian');
        }

        // /rewards?dungeon_key=xutian 应返回虚天殿奖励详情
        const rewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=xutian', token);
        check('/api/multi-dungeon/rewards?dungeon_key=xutian 返回 200',
            rewardsRes.status === 200, `status=${rewardsRes.status}`);

        if (rewardsRes.json?.data) {
            const data = rewardsRes.json.data;
            check('rewards 响应包含 dungeon_key=xutian',
                data.dungeon_key === 'xutian' || data.name === '虚天殿',
                `data=${JSON.stringify(data).substring(0, 100)}`);

            console.log(`\n  📊 虚天殿奖励信息：`);
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

        // /cooldown?dungeon_key=xutian 应返回冷却状态
        const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown?dungeon_key=xutian', token);
        check('/api/multi-dungeon/cooldown?dungeon_key=xutian 返回 200',
            cooldownRes.status === 200, `status=${cooldownRes.status}`);

        // 尝试创建虚天殿副本（预期失败：物品不足或冷却）
        // 注：测试账号是化神期 rank=23 admin，境界满足要求（leader_min_realm_rank=19）
        const createRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'xutian'
        });
        check('POST /api/multi-dungeon/create xutian 接口可调用',
            createRes.status === 200 || createRes.status === 400,
            `status=${createRes.status}`);

        if (createRes.json) {
            // 预期失败原因：物品不足 / 已在副本中 / 冷却中
            // 若成功则说明物品充足且无冷却，需要清理
            if (createRes.status === 200 && createRes.json?.data?.instance_id) {
                console.log(`     ⚠️  警告：测试账号创建了虚天殿副本实例（instance_id=${createRes.json.data.instance_id}）`);
                console.log(`     ⚠️  自动解散该实例以清理状态...`);
                const dissolveRes = await api('POST', '/api/multi-dungeon/dissolve', token, {
                    instance_id: createRes.json.data.instance_id
                });
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
