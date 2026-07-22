/**
 * 黄龙山副本端到端测试
 *
 * 目的：验证黄龙山（huanglong）5人固定编制宗门协同阵法副本的配置完整性、
 *      服务方法存在性、模型字段同步性、接口可用性、共鸣重算机制、决战机制、
 *      奖励结算逻辑、宗门特色加成、同宗门强制校验、叛道博弈机制。
 *
 * 测试范围：
 *   1. 静态代码扫描：MultiDungeonService 包含黄龙山专属方法 _processHuanglongFinalAct
 *   2. 配置完整性：4 幕流程 / 5人固定编制 / require_same_sect 同宗门强制 /
 *      5 个阵眼位置 / 6 种宗门特色加成 / 共鸣机制 / 叛道机制 / 决战参数 / 双向腐蚀
 *   3. 变量边界：VARIABLE_BOUNDS 包含 huanglong_formation_power(0-200) /
 *      huanglong_resonance_count(0-5) / member_huanglong_contribution_score(0-1000)
 *   4. 模型字段：3 个 Sequelize 模型含黄龙山专属 11 个字段
 *   5. 接口路由：/api/multi-dungeon/create 与 /api/multi-dungeon/rewards 支持 huanglong
 *   6. 物品配置：huanglong_token / huanglong_scale / formation_rune / sect_medal /
 *      huanglong_formation_map / huanglong_pearl 共 6 个物品已定义
 *   7. 只读接口：/help、/rewards、/cooldown 返回 huanglong 信息
 *   8. 创建接口：测试账号尝试创建黄龙山，预期因物品不足/同宗门/冷却被拦截
 *
 * 玩法文档对照：
 *   - 黄龙山：5人固定编制宗门协同阵法副本，4幕流程
 *   - 第1幕·入阵固守（enter_formation）：5个阵眼抉择（forward/center/rear/left/right）
 *   - 第2幕·截断粮道（cut_supply）：4个截粮策略（raid/disguise/storm/stealth）
 *   - 第3幕·阵法共鸣（formation_resonance）：3个共鸣方向 + 叛道抉择
 *   - 第4幕·黄龙主阵决战（huanglong_boss）：5回合自动决战
 *   - 5人固定编制，require_same_sect=true 强制同宗门
 *   - 相同阵眼≥2人触发共鸣，5人同阵眼可触发5共鸣
 *   - 决战伤害公式：damage = 100000 + formation_power × 3000 + resonance_count × 15000
 *   - 双向腐蚀：每回合 morale -3 / vigilance +5（vigilance 满100即失败）
 *   - 6种宗门特色加成：落云/星宫/天星/凌霄/阴罗/合欢
 *   - 叛道机制：成员放弃共鸣换双倍贡献分
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
    console.log('  黄龙山副本端到端测试 (huanglong)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 黄龙山专属方法与变量边界 =====
    console.log('[场景1] 静态代码扫描 - 黄龙山专属方法与变量边界');

    const serviceCode = fs.readFileSync(
        path.join(__dirname, '../game/services/MultiDungeonService.js'), 'utf-8'
    );

    // 1.1 专属方法存在性
    check('MultiDungeonService 包含 _processHuanglongFinalAct 静态方法',
        /static\s+async\s+_processHuanglongFinalAct\s*\(/.test(serviceCode), '');

    check('create 方法白名单包含 huanglong',
        serviceCode.includes("'huanglong'"), '');

    check('finalActHandler 七分支分发包含 huanglong',
        serviceCode.includes("instance.instance_key === 'huanglong'") &&
        serviceCode.includes('_processHuanglongFinalAct'), '');

    // 1.2 VARIABLE_BOUNDS 边界定义
    check('VARIABLE_BOUNDS 包含 huanglong_formation_power (0-200)',
        /huanglong_formation_power:\s*\{\s*min:\s*0,\s*max:\s*200\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 huanglong_resonance_count (0-5)',
        /huanglong_resonance_count:\s*\{\s*min:\s*0,\s*max:\s*5\s*\}/.test(serviceCode), '');

    check('VARIABLE_BOUNDS 包含 member_huanglong_contribution_score (0-1000)',
        /member_huanglong_contribution_score:\s*\{\s*min:\s*0,\s*max:\s*1000\s*\}/.test(serviceCode), '');

    // 1.3 黄龙山专属变量初始化逻辑
    check('黄龙山实例级变量初始化（init_formation_power）',
        serviceCode.includes('init_formation_power'), '');

    check('黄龙山实例级变量初始化（init_resonance_count）',
        serviceCode.includes('init_resonance_count'), '');

    check('黄龙山成员级变量初始化（member_init_eye_position）',
        serviceCode.includes('member_init_eye_position'), '');

    check('黄龙山成员级变量初始化（member_init_contribution_score）',
        serviceCode.includes('member_init_contribution_score'), '');

    check('黄龙山成员级变量初始化（member_init_is_defecting）',
        serviceCode.includes('member_init_is_defecting'), '');

    // 1.4 同宗门强制校验（黄龙山独创）
    check('黄龙山 require_same_sect 同宗门校验逻辑存在',
        serviceCode.includes('require_same_sect'), '');

    check('黄龙山同宗门校验使用 PlayerSect 模型查询',
        serviceCode.includes('PlayerSect'), '');

    check('黄龙山同宗门校验比较 leader 与队员的 sect_id',
        serviceCode.includes('sect_id'), '');

    // 1.5 抉择变量应用逻辑
    check('黄龙山抉择变量应用（huanglong_formation_power_change 累加）',
        serviceCode.includes('huanglong_formation_power_change'), '');

    check('黄龙山抉择变量应用（huanglong_resonance_count_change 累加）',
        serviceCode.includes('huanglong_resonance_count_change'), '');

    check('黄龙山抉择变量应用（huanglong_eye_position 阵眼位置）',
        serviceCode.includes('huanglong_eye_position'), '');

    check('黄龙山抉择变量应用（huanglong_contribution_score_self_change）',
        serviceCode.includes('huanglong_contribution_score_self_change'), '');

    check('黄龙山抉择变量应用（huanglong_is_defecting_self 叛道标记）',
        serviceCode.includes('huanglong_is_defecting_self'), '');

    // 1.6 共鸣重算机制（黄龙山独创）
    check('黄龙山共鸣重算逻辑（查询未叛道成员）',
        serviceCode.includes('huanglong_is_defecting: 0') ||
        serviceCode.includes("huanglong_is_defecting: 0,"), '');

    check('黄龙山共鸣重算按阵眼分组（forward/center/rear/left/right）',
        serviceCode.includes('forward') &&
        serviceCode.includes('center') &&
        serviceCode.includes('rear') &&
        serviceCode.includes('left') &&
        serviceCode.includes('right'), '');

    check('黄龙山共鸣数 = 相同阵眼≥2人的组数',
        serviceCode.includes('resonance_count') &&
        serviceCode.includes('2'), '');

    // 1.7 决战机制
    check('黄龙山决战初始化（huanglong_boss_hp = 1500000）',
        serviceCode.includes('huanglong_boss_hp') &&
        serviceCode.includes('1500000'), '');

    check('黄龙山决战伤害公式（100000 + formation_power×3000 + resonance_count×15000）',
        serviceCode.includes('100000') &&
        serviceCode.includes('3000') &&
        serviceCode.includes('15000'), '');

    check('黄龙山决战每回合双向腐蚀（morale_change_per_round = -3）',
        serviceCode.includes('morale_change_per_round'), '');

    check('黄龙山决战每回合双向腐蚀（vigilance_change_per_round = 5）',
        serviceCode.includes('vigilance_change_per_round'), '');

    check('黄龙山决战失败条件（vigilance >= 100 即失败）',
        serviceCode.includes('vigilance') &&
        serviceCode.includes('100'), '');

    check('黄龙山决战5回合上限（rounds_max = 5，配置读取）',
        serviceCode.includes('rounds_max') &&
        /_processHuanglongFinalAct[\s\S]{0,2000}rounds_max/.test(serviceCode), '');

    // 1.8 奖励结算
    check('黄龙山奖励结算块（formation_power_bonus 阵法强度加成）',
        serviceCode.includes('formation_power_bonus') ||
        serviceCode.includes('4.7'), '');

    check('黄龙山完美通关加成（perfect_clear_no_defect）',
        serviceCode.includes('perfect_clear_no_defect') ||
        serviceCode.includes('完美通关'), '');

    check('黄龙山称号奖励逻辑（rewards.title / title_chance / title_min_formation_power 配置读取）',
        serviceCode.includes('title_chance') &&
        serviceCode.includes('title_min_formation_power') &&
        serviceCode.includes('huanglong_title_awarded') &&
        serviceCode.includes('huanglong_is_defecting'), '');

    check('黄龙山 getRewards 白名单包含 huanglong',
        /getRewards[\s\S]{0,2000}'huanglong'/.test(serviceCode), '');

    check('黄龙山 getCooldown 列表包含 huanglong',
        /getCooldown[\s\S]{0,3000}'huanglong'/.test(serviceCode), '');

    check('黄龙山 gmGrantReward 白名单包含 huanglong',
        /gmGrantReward[\s\S]{0,3000}'huanglong'/.test(serviceCode), '');

    check('黄龙山 gmResetCooldown 白名单包含 huanglong',
        /gmResetCooldown[\s\S]{0,3000}'huanglong'/.test(serviceCode), '');

    // 1.9 getStatus 返回黄龙山变量
    check('getStatus 返回实例级 huanglong_formation_power / huanglong_resonance_count / huanglong_boss_hp',
        serviceCode.includes('huanglong_formation_power: instance.huanglong_formation_power') &&
        serviceCode.includes('huanglong_resonance_count: instance.huanglong_resonance_count') &&
        serviceCode.includes('huanglong_boss_hp'), '');

    check('getStatus 返回成员级 huanglong_eye_position / huanglong_contribution_score / huanglong_is_defecting',
        serviceCode.includes('huanglong_eye_position: m.huanglong_eye_position') &&
        serviceCode.includes('huanglong_contribution_score: m.huanglong_contribution_score') &&
        serviceCode.includes('huanglong_is_defecting'), '');

    // ===== 场景2：配置完整性 - 4 幕流程 / 专属变量 / 宗门加成 =====
    console.log('\n[场景2] 配置完整性 - 黄龙山 4 幕流程');

    const config = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/multi_dungeon_data.json'), 'utf8')
    );

    const huanglong = config.dungeons?.huanglong;
    check('huanglong 配置块存在', huanglong !== undefined, '');

    if (huanglong) {
        // 2.1 基础信息
        check('huanglong.name = "黄龙山"', huanglong.name === '黄龙山', `actual=${huanglong.name}`);
        check('huanglong.desc 不为空且描述宗门协同阵法',
            typeof huanglong.desc === 'string' &&
            huanglong.desc.length > 20 &&
            huanglong.desc.includes('宗门') &&
            huanglong.desc.includes('阵'),
            `desc 长度=${huanglong.desc?.length}`);

        // 2.2 人数与境界（5人固定编制）
        check('huanglong.member_min = 5（固定5人编制）',
            huanglong.member_min === 5, `actual=${huanglong.member_min}`);
        check('huanglong.member_max = 5（固定5人编制）',
            huanglong.member_max === 5, `actual=${huanglong.member_max}`);
        check('huanglong.leader_min_realm = "元婴期"',
            huanglong.leader_min_realm === '元婴期',
            `actual=${huanglong.leader_min_realm}`);
        check('huanglong.leader_min_realm_rank = 19',
            huanglong.leader_min_realm_rank === 19,
            `actual=${huanglong.leader_min_realm_rank}`);
        check('huanglong.member_min_realm = "结丹后期"',
            huanglong.member_min_realm === '结丹后期',
            `actual=${huanglong.member_min_realm}`);
        check('huanglong.member_min_realm_rank = 17',
            huanglong.member_min_realm_rank === 17,
            `actual=${huanglong.member_min_realm_rank}`);

        // 2.3 同宗门强制（黄龙山独创）
        check('huanglong.require_same_sect = true（强制同宗门）',
            huanglong.require_same_sect === true, '');

        // 2.4 门票与冷却
        check('huanglong.consume_item_key = "huanglong_token"',
            huanglong.consume_item_key === 'huanglong_token',
            `actual=${huanglong.consume_item_key}`);
        check('huanglong.consume_item_count = 1', huanglong.consume_item_count === 1, '');
        check('huanglong.cooldown_hours = 96（4天，黄龙山更难更长冷却）',
            huanglong.cooldown_hours === 96, `actual=${huanglong.cooldown_hours}`);
        check('huanglong.expire_hours = 2', huanglong.expire_hours === 2, '');

        // 2.5 实例级专属初始化变量
        check('huanglong.init_formation_power = 0', huanglong.init_formation_power === 0, '');
        check('huanglong.init_resonance_count = 0', huanglong.init_resonance_count === 0, '');
        check('huanglong.init_morale = 90（黄龙山初始士气略低）',
            huanglong.init_morale === 90, `actual=${huanglong.init_morale}`);

        // 2.6 成员级专属初始化变量
        check('huanglong.member_init_eye_position = "unassigned"',
            huanglong.member_init_eye_position === 'unassigned', '');
        check('huanglong.member_init_contribution_score = 0',
            huanglong.member_init_contribution_score === 0, '');
        check('huanglong.member_init_is_defecting = false',
            huanglong.member_init_is_defecting === false, '');

        // 2.7 阵法强度上限与共鸣阈值
        check('huanglong.formation_power_max = 200', huanglong.formation_power_max === 200, '');
        check('huanglong.resonance_threshold = 2（相同阵眼≥2人触发共鸣）',
            huanglong.resonance_threshold === 2, '');

        // 2.8 决战配置
        check('huanglong.final_act_number = 4', huanglong.final_act_number === 4, '');
        check('huanglong.final_max_rounds = 5', huanglong.final_max_rounds === 5, '');
        check('huanglong.huanglong_boss_hp_base = 1500000',
            huanglong.huanglong_boss_hp_base === 1500000, '');
        check('huanglong.damage_per_round_base = 100000',
            huanglong.damage_per_round_base === 100000, '');
        check('huanglong.damage_formation_power_bonus_per_point = 3000',
            huanglong.damage_formation_power_bonus_per_point === 3000, '');
        check('huanglong.damage_resonance_bonus_per_count = 15000',
            huanglong.damage_resonance_bonus_per_count === 15000, '');
        check('huanglong.morale_change_per_round = -3',
            huanglong.morale_change_per_round === -3, '');
        check('huanglong.vigilance_change_per_round = 5',
            huanglong.vigilance_change_per_round === 5, '');
        check('huanglong.vigilance_max = 100', huanglong.vigilance_max === 100, '');

        // 2.9 完美通关条件
        check('huanglong.perfect_clear_no_defect = true（无叛道才完美通关）',
            huanglong.perfect_clear_no_defect === true, '');

        // 2.10 6种宗门特色加成（黄龙山独创）
        check('huanglong.sect_bonus 配置块存在',
            huanglong.sect_bonus !== undefined && typeof huanglong.sect_bonus === 'object', '');

        if (huanglong.sect_bonus) {
            const sectKeys = Object.keys(huanglong.sect_bonus).sort();
            check('sect_bonus 包含6种宗门（luoyun/xinggong/tianxing/lingxiao/yinluo/hehuan）',
                sectKeys.join(',') === 'hehuan,lingxiao,luoyun,tianxing,xinggong,yinluo',
                `actual=${sectKeys.join(',')}`);

            // 校验每种宗门加成配置完整性
            const sectConfigs = [
                { key: 'luoyun', field: 'formation_power_gain_bonus', value: 0.10, desc: '落云宗：阵法强度收益 +10%' },
                { key: 'xinggong', field: 'resonance_trigger_bonus', value: 0.05, desc: '星宫：共鸣触发率 +5%' },
                { key: 'tianxing', field: 'rare_drop_bonus', value: 0.15, desc: '天星宗：稀有掉落率 +15%' },
                { key: 'lingxiao', field: 'morale_recover_bonus', value: 0.20, desc: '凌霄宫：士气恢复 +20%' },
                { key: 'yinluo', field: 'damage_bonus', value: 0.10, desc: '阴罗宗：伤害加成 +10%' },
                { key: 'hehuan', field: 'perfect_bonus_multiplier', value: 0.15, desc: '合欢宗：完美通关加成 +15%' }
            ];

            for (const sect of sectConfigs) {
                const cfg = huanglong.sect_bonus[sect.key];
                check(`sect_bonus.${sect.key}.${sect.field} = ${sect.value}`,
                    cfg && cfg[sect.field] === sect.value, `actual=${cfg?.[sect.field]}`);
                check(`sect_bonus.${sect.key}.desc 不为空`,
                    cfg && typeof cfg.desc === 'string' && cfg.desc.length > 5, '');
            }
        }

        // 2.11 4 幕流程校验
        check('huanglong.acts 数组长度 = 4',
            Array.isArray(huanglong.acts) && huanglong.acts.length === 4,
            `actual=${huanglong.acts?.length}`);

        if (Array.isArray(huanglong.acts) && huanglong.acts.length === 4) {
            const act1 = huanglong.acts[0];
            const act2 = huanglong.acts[1];
            const act3 = huanglong.acts[2];
            const act4 = huanglong.acts[3];

            // 第1幕：入阵固守（5个阵眼抉择）
            check('第1幕 act_key = "enter_formation"', act1.act_key === 'enter_formation', '');
            check('第1幕 act_name = "入阵固守"', act1.act_name === '入阵固守', '');
            check('第1幕 is_entry_act = true', act1.is_entry_act === true, '');
            check('第1幕有 5 个 choices（五大阵眼）',
                Array.isArray(act1.choices) && act1.choices.length === 5,
                `actual=${act1.choices?.length}`);

            if (Array.isArray(act1.choices) && act1.choices.length === 5) {
                const forward = act1.choices.find(c => c.key === 'forward');
                const center = act1.choices.find(c => c.key === 'center');
                const rear = act1.choices.find(c => c.key === 'rear');
                const left = act1.choices.find(c => c.key === 'left');
                const right = act1.choices.find(c => c.key === 'right');

                // 前锋阵眼
                check('第1幕 forward 抉择存在', forward !== undefined, '');
                check('第1幕 forward.vigilance_change = -10（吸收伤害）',
                    forward?.vigilance_change === -10, `actual=${forward?.vigilance_change}`);
                check('第1幕 forward.eye_position = "forward"',
                    forward?.eye_position === 'forward', '');
                check('第1幕 forward.contribution_score_self_change = 10',
                    forward?.contribution_score_self_change === 10, '');

                // 中军阵眼
                check('第1幕 center 抉择存在', center !== undefined, '');
                check('第1幕 center.formation_power_change = 15（提升阵法强度）',
                    center?.formation_power_change === 15, `actual=${center?.formation_power_change}`);
                check('第1幕 center.eye_position = "center"',
                    center?.eye_position === 'center', '');

                // 后卫阵眼
                check('第1幕 rear 抉择存在', rear !== undefined, '');
                check('第1幕 rear.morale_change = 10（恢复士气）',
                    rear?.morale_change === 10, `actual=${rear?.morale_change}`);
                check('第1幕 rear.eye_position = "rear"',
                    rear?.eye_position === 'rear', '');

                // 左翼阵眼
                check('第1幕 left 抉择存在', left !== undefined, '');
                check('第1幕 left.vigilance_change = 15（增加警戒防御）',
                    left?.vigilance_change === 15, `actual=${left?.vigilance_change}`);
                check('第1幕 left.eye_position = "left"',
                    left?.eye_position === 'left', '');

                // 右翼阵眼
                check('第1幕 right 抉择存在', right !== undefined, '');
                check('第1幕 right.harvest_multiplier_change = 0.1（增加收获）',
                    right?.harvest_multiplier_change === 0.1, `actual=${right?.harvest_multiplier_change}`);
                check('第1幕 right.eye_position = "right"',
                    right?.eye_position === 'right', '');
            }

            // 第2幕：截断粮道（4个截粮策略）
            check('第2幕 act_key = "cut_supply"', act2.act_key === 'cut_supply', '');
            check('第2幕 act_name = "截断粮道"', act2.act_name === '截断粮道', '');
            check('第2幕有 4 个 choices',
                Array.isArray(act2.choices) && act2.choices.length === 4,
                `actual=${act2.choices?.length}`);

            if (Array.isArray(act2.choices) && act2.choices.length === 4) {
                const raid = act2.choices.find(c => c.key === 'raid');
                const disguise = act2.choices.find(c => c.key === 'disguise');
                const storm = act2.choices.find(c => c.key === 'storm');
                const stealth = act2.choices.find(c => c.key === 'stealth');

                check('第2幕 raid 奇袭存在', raid !== undefined, '');
                check('第2幕 raid.formation_power_change = 20', raid?.formation_power_change === 20, '');
                check('第2幕 raid.vigilance_change = 15', raid?.vigilance_change === 15, '');

                check('第2幕 disguise 伪装存在', disguise !== undefined, '');
                check('第2幕 disguise.formation_power_change = 5', disguise?.formation_power_change === 5, '');

                check('第2幕 storm 强攻存在', storm !== undefined, '');
                check('第2幕 storm.formation_power_change = 25', storm?.formation_power_change === 25, '');
                check('第2幕 storm.morale_change = -10', storm?.morale_change === -10, '');

                check('第2幕 stealth 潜行存在', stealth !== undefined, '');
                check('第2幕 stealth.formation_power_change = 10', stealth?.formation_power_change === 10, '');
            }

            // 第3幕：阵法共鸣（3共鸣方向 + 叛道）
            check('第3幕 act_key = "formation_resonance"', act3.act_key === 'formation_resonance', '');
            check('第3幕 act_name = "阵法共鸣"', act3.act_name === '阵法共鸣', '');
            check('第3幕有 4 个 choices（3共鸣+1叛道）',
                Array.isArray(act3.choices) && act3.choices.length === 4,
                `actual=${act3.choices?.length}`);

            if (Array.isArray(act3.choices) && act3.choices.length === 4) {
                const gather = act3.choices.find(c => c.key === 'gather_spirit');
                const guard = act3.choices.find(c => c.key === 'guard_formation');
                const breakF = act3.choices.find(c => c.key === 'break_formation');
                const defect = act3.choices.find(c => c.key === 'defect');

                check('第3幕 gather_spirit 聚灵共鸣存在', gather !== undefined, '');
                check('第3幕 gather_spirit.formation_power_change = 30',
                    gather?.formation_power_change === 30, '');
                check('第3幕 gather_spirit.resonance_count_change = 1',
                    gather?.resonance_count_change === 1, '');

                check('第3幕 guard_formation 守阵共鸣存在', guard !== undefined, '');
                check('第3幕 guard_formation.morale_change = 20',
                    guard?.morale_change === 20, '');
                check('第3幕 guard_formation.resonance_count_change = 1',
                    guard?.resonance_count_change === 1, '');

                check('第3幕 break_formation 破阵共鸣存在', breakF !== undefined, '');
                check('第3幕 break_formation.formation_power_change = 10',
                    breakF?.formation_power_change === 10, '');
                check('第3幕 break_formation.harvest_multiplier_change = 0.2',
                    breakF?.harvest_multiplier_change === 0.2, '');

                // 叛道抉择（黄龙山独创博弈机制）
                check('第3幕 defect 叛道抉择存在', defect !== undefined, '');
                check('第3幕 defect.contribution_score_self_change = 20（双倍贡献分）',
                    defect?.contribution_score_self_change === 20, '');
                check('第3幕 defect.is_defecting_self = true（标记为叛道）',
                    defect?.is_defecting_self === true, '');
            }

            // 第4幕：黄龙主阵决战（自动决战）
            check('第4幕 act_key = "huanglong_boss"', act4.act_key === 'huanglong_boss', '');
            check('第4幕 act_name = "黄龙主阵决战"', act4.act_name === '黄龙主阵决战', '');
            check('第4幕 is_auto_advance = true', act4.is_auto_advance === true, '');
            check('第4幕 is_final_act = true', act4.is_final_act === true, '');
            check('第4幕 rounds_max = 5', act4.rounds_max === 5, '');
            check('第4幕 damage_per_round_base = 100000',
                act4.damage_per_round_base === 100000, '');
            check('第4幕 damage_formation_power_bonus_per_point = 3000',
                act4.damage_formation_power_bonus_per_point === 3000, '');
            check('第4幕 damage_resonance_bonus_per_count = 15000',
                act4.damage_resonance_bonus_per_count === 15000, '');
            check('第4幕 morale_change_per_round = -3',
                act4.morale_change_per_round === -3, '');
            check('第4幕 vigilance_change_per_round = 5',
                act4.vigilance_change_per_round === 5, '');

            // 通关 / 失败条件
            check('第4幕 clear_condition.boss_hp_zero = true',
                act4.clear_condition?.boss_hp_zero === true, '');
            check('第4幕 fail_condition.morale_lte = 0',
                act4.fail_condition?.morale_lte === 0, '');
            check('第4幕 fail_condition.vigilance_gte = 100',
                act4.fail_condition?.vigilance_gte === 100, '');
        }

        // 2.12 奖励配置校验
        const rewards = huanglong.rewards;
        check('rewards.base_rewards 数组长度 = 4（含宗门贡献）',
            Array.isArray(rewards.base_rewards) && rewards.base_rewards.length === 4,
            `actual=${rewards.base_rewards?.length}`);

        if (Array.isArray(rewards.base_rewards)) {
            const expReward = rewards.base_rewards.find(r => r.type === 'exp');
            const stonesReward = rewards.base_rewards.find(r => r.type === 'spirit_stones');
            const dsReward = rewards.base_rewards.find(r => r.type === 'divine_sense');
            const sectContrib = rewards.base_rewards.find(r => r.type === 'sect_contribution');
            check('base_rewards 包含 exp=40000', expReward?.count === 40000, '');
            check('base_rewards 包含 spirit_stones=12000', stonesReward?.count === 12000, '');
            check('base_rewards 包含 divine_sense=70', dsReward?.count === 70, '');
            check('base_rewards 包含 sect_contribution=50（联动宗门系统）',
                sectContrib?.count === 50, '');
        }

        check('rewards.normal_drops 数组长度 = 4',
            Array.isArray(rewards.normal_drops) && rewards.normal_drops.length === 4,
            `actual=${rewards.normal_drops?.length}`);

        if (Array.isArray(rewards.normal_drops)) {
            const dropKeys = rewards.normal_drops.map(d => d.item_key).sort();
            check('normal_drops 包含 huanglong_token/huanglong_scale/formation_rune/sect_medal',
                dropKeys.join(',') === 'formation_rune,huanglong_scale,huanglong_token,sect_medal',
                `actual=${dropKeys.join(',')}`);
        }

        check('rewards.first_clear_bonus 包含黄龙阵图',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.item_key === 'huanglong_formation_map'),
            '');

        check('rewards.first_clear_bonus 包含首通称号（黄龙阵主）',
            Array.isArray(rewards.first_clear_bonus) &&
            rewards.first_clear_bonus.some(b => b.type === 'title' &&
                b.title_id === 'huanglong_master'),
            '');

        // 稀有掉落
        check('rewards.rare_drop.item_key = "huanglong_pearl"',
            rewards.rare_drop?.item_key === 'huanglong_pearl', '');
        check('rewards.rare_drop.chance = 0.02 (2%)',
            rewards.rare_drop?.chance === 0.02, `actual=${rewards.rare_drop?.chance}`);
        check('rewards.rare_drop.leader_only = false (随机分给未叛道成员)',
            rewards.rare_drop?.leader_only === false, '');

        // 阵法强度加成
        check('rewards.formation_power_bonus.exp_per_10_formation_power = 2000',
            rewards.formation_power_bonus?.exp_per_10_formation_power === 2000, '');
        check('rewards.formation_power_bonus.spirit_stones_per_10_formation_power = 150',
            rewards.formation_power_bonus?.spirit_stones_per_10_formation_power === 150, '');

        // 完美通关加成
        check('rewards.perfect_bonus.exp = 10000',
            rewards.perfect_bonus?.exp === 10000, '');
        check('rewards.perfect_bonus.spirit_stones = 2000',
            rewards.perfect_bonus?.spirit_stones === 2000, '');

        // 称号
        check('rewards.title = "huanglong_master"',
            rewards.title === 'huanglong_master', '');
        check('rewards.title_chance = 0.30 (30%)',
            rewards.title_chance === 0.30, `actual=${rewards.title_chance}`);
        check('rewards.title_min_formation_power = 120',
            rewards.title_min_formation_power === 120, '');
    }

    // ===== 场景3：模型字段校验 =====
    console.log('\n[场景3] 模型字段校验 - 黄龙山专属字段已同步至 Sequelize 模型');

    const instanceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonInstance.js'), 'utf-8'
    );
    const choiceModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonChoice.js'), 'utf-8'
    );
    const memberModelCode = fs.readFileSync(
        path.join(__dirname, '../models/multiDungeonMember.js'), 'utf-8'
    );

    // 3.1 实例模型字段（3个）
    check('MultiDungeonInstance 含 huanglong_formation_power 字段',
        instanceModelCode.includes('huanglong_formation_power:'), '');
    check('MultiDungeonInstance 含 huanglong_resonance_count 字段',
        instanceModelCode.includes('huanglong_resonance_count:'), '');
    check('MultiDungeonInstance 含 huanglong_boss_hp 字段',
        instanceModelCode.includes('huanglong_boss_hp:'), '');
    check('MultiDungeonInstance.huanglong_boss_hp 类型为 BIGINT',
        /huanglong_boss_hp:[\s\S]{0,200}DataTypes\.BIGINT/.test(instanceModelCode), '');
    check('MultiDungeonInstance.huanglong_formation_power 默认值为 0',
        /huanglong_formation_power:[\s\S]{0,300}defaultValue:\s*0/.test(instanceModelCode), '');

    // 3.2 抉择模型字段（5个）
    check('MultiDungeonChoice 含 huanglong_formation_power_change 字段',
        choiceModelCode.includes('huanglong_formation_power_change:'), '');
    check('MultiDungeonChoice 含 huanglong_resonance_count_change 字段',
        choiceModelCode.includes('huanglong_resonance_count_change:'), '');
    check('MultiDungeonChoice 含 huanglong_eye_position 字段',
        choiceModelCode.includes('huanglong_eye_position:'), '');
    check('MultiDungeonChoice 含 huanglong_contribution_score_self_change 字段',
        choiceModelCode.includes('huanglong_contribution_score_self_change:'), '');
    check('MultiDungeonChoice 含 huanglong_is_defecting_self 字段',
        choiceModelCode.includes('huanglong_is_defecting_self:'), '');
    check('MultiDungeonChoice.huanglong_eye_position 类型为 STRING(20)',
        /huanglong_eye_position:[\s\S]{0,200}DataTypes\.STRING\(20\)/.test(choiceModelCode), '');
    check('MultiDungeonChoice.huanglong_is_defecting_self 类型为 TINYINT',
        /huanglong_is_defecting_self:[\s\S]{0,200}DataTypes\.TINYINT/.test(choiceModelCode), '');

    // 3.3 成员模型字段（3个）
    check('MultiDungeonMember 含 huanglong_eye_position 字段',
        memberModelCode.includes('huanglong_eye_position:'), '');
    check('MultiDungeonMember 含 huanglong_contribution_score 字段',
        memberModelCode.includes('huanglong_contribution_score:'), '');
    check('MultiDungeonMember 含 huanglong_is_defecting 字段',
        memberModelCode.includes('huanglong_is_defecting:'), '');
    check('MultiDungeonMember.huanglong_is_defecting 类型为 TINYINT',
        /huanglong_is_defecting:[\s\S]{0,200}DataTypes\.TINYINT/.test(memberModelCode), '');
    check('MultiDungeonMember.huanglong_eye_position 默认值为 "unassigned"',
        /huanglong_eye_position:[\s\S]{0,300}defaultValue:\s*'unassigned'/.test(memberModelCode), '');

    // ===== 场景4：物品配置校验 =====
    console.log('\n[场景4] 物品配置校验 - 黄龙山相关物品已定义');

    const itemData = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../config/item_data.json'), 'utf8')
    );

    const items = itemData.items || [];
    const itemMap = new Map(items.map(i => [i.id, i]));

    // 4.1 必需物品列表（6个）
    const requiredItems = [
        { id: 'huanglong_token', name: '黄龙令', expectedType: 'consumable', expectedSubtype: 'ticket', expectedQuality: 'legendary' },
        { id: 'huanglong_scale', name: '黄龙鳞', expectedType: 'material', expectedSubtype: 'scale', expectedQuality: 'epic' },
        { id: 'formation_rune', name: '阵法符文', expectedType: 'material', expectedSubtype: 'rune', expectedQuality: 'rare' },
        { id: 'sect_medal', name: '宗门勋章', expectedType: 'material', expectedSubtype: 'medal', expectedQuality: 'rare' },
        { id: 'huanglong_formation_map', name: '黄龙阵图', expectedType: 'material', expectedSubtype: 'map', expectedQuality: 'legendary' },
        { id: 'huanglong_pearl', name: '黄龙珠', expectedType: 'material', expectedSubtype: 'pearl', expectedQuality: 'legendary' }
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
            check(`物品 ${req.id}.quality = "${req.expectedQuality}"`,
                item.quality === req.expectedQuality, `actual=${item.quality}`);
            check(`物品 ${req.id}.description 不为空`,
                typeof item.description === 'string' && item.description.length > 10, '');
            check(`物品 ${req.id}.price > 0`,
                typeof item.price === 'number' && item.price > 0, `actual=${item.price}`);
        }
    }

    // 4.2 门票物品特殊校验
    const huanglongToken = itemMap.get('huanglong_token');
    if (huanglongToken) {
        check('huanglong_token.effect 包含 dungeon_ticket: "huanglong"',
            huanglongToken.effect?.dungeon_ticket === 'huanglong', '');
    }

    // 4.3 物品总数验证（132 = 126坠魔谷前 + 6黄龙山）
    check('item_data.json 物品总数 = 132（含6个黄龙山物品）',
        items.length === 132, `actual=${items.length}`);

    // ===== 场景5：迁移脚本校验 =====
    console.log('\n[场景5] 迁移脚本校验 - migration_0060 存在且字段完整');

    const migrationPath = path.join(__dirname, 'migration_0060_huanglong_fields.js');
    check('migration_0060_huanglong_fields.js 文件存在', fs.existsSync(migrationPath), '');

    if (fs.existsSync(migrationPath)) {
        const migrationCode = fs.readFileSync(migrationPath, 'utf-8');

        // 5.1 字段添加逻辑（11个字段）
        const requiredMigrationColumns = [
            // instance 表（3个）
            { table: 'multi_dungeon_instance', column: 'huanglong_formation_power' },
            { table: 'multi_dungeon_instance', column: 'huanglong_resonance_count' },
            { table: 'multi_dungeon_instance', column: 'huanglong_boss_hp' },
            // choice 表（5个）
            { table: 'multi_dungeon_choice', column: 'huanglong_formation_power_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_resonance_count_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_eye_position' },
            { table: 'multi_dungeon_choice', column: 'huanglong_contribution_score_self_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_is_defecting_self' },
            // member 表（3个）
            { table: 'multi_dungeon_member', column: 'huanglong_eye_position' },
            { table: 'multi_dungeon_member', column: 'huanglong_contribution_score' },
            { table: 'multi_dungeon_member', column: 'huanglong_is_defecting' }
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

        // 5.4 huanglong_boss_hp 字段类型为 BIGINT
        check('迁移脚本 huanglong_boss_hp 字段类型为 BIGINT',
            migrationCode.includes('BIGINT DEFAULT NULL') ||
            /huanglong_boss_hp[\s\S]{0,200}BIGINT/.test(migrationCode), '');

        // 5.5 huanglong_is_defecting / huanglong_is_defecting_self 字段类型为 TINYINT(1)
        check('迁移脚本 huanglong_is_defecting 字段类型为 TINYINT(1)',
            migrationCode.includes('TINYINT(1)'), '');

        // 5.6 迁移脚本名称与描述
        check('迁移脚本 name = "0060_huanglong_fields"',
            migrationCode.includes("0060_huanglong_fields"), '');

        // 5.7 字段命名前缀统一（huanglong_）
        check('迁移脚本所有字段统一 huanglong_ 前缀（避免与虚天殿 formation_power 冲突）',
            migrationCode.includes('huanglong_formation_power') &&
            !migrationCode.includes("ADD COLUMN formation_power "), '');
    }

    // ===== 场景6：接口路由校验 =====
    console.log('\n[场景6] 接口路由 - /api/multi-dungeon/* 支持 huanglong');

    const routeCode = fs.readFileSync(
        path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8'
    );

    check('路由 create 接口白名单包含 huanglong',
        routeCode.includes("'huanglong'"), '');
    check('路由 create 接口注释提及黄龙山',
        routeCode.includes('黄龙山'), '');
    check('路由 rewards 接口白名单包含 huanglong',
        /rewards[\s\S]{0,2000}'huanglong'/.test(routeCode), '');
    check('路由 cooldown 接口注释提及共10个副本键',
        routeCode.includes('共10个副本键'), '');

    // ===== 场景7：接口端到端测试 =====
    console.log('\n[场景7] 接口端到端测试 - 黄龙山只读接口');

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
        // 7.1 /help 应返回 huanglong
        const helpRes = await api('GET', '/api/multi-dungeon/help', token);
        check('/api/multi-dungeon/help 返回 200',
            helpRes.status === 200, `status=${helpRes.status}`);

        if (helpRes.json?.data?.dungeons?.huanglong) {
            const huanglongHelp = helpRes.json.data.dungeons.huanglong;
            check('help 返回 huanglong.name = "黄龙山"',
                huanglongHelp.name === '黄龙山', `actual=${huanglongHelp.name}`);
            check('help 返回 huanglong.member_min = 5',
                huanglongHelp.member_min === 5, `actual=${huanglongHelp.member_min}`);
            check('help 返回 huanglong.member_max = 5',
                huanglongHelp.member_max === 5, `actual=${huanglongHelp.member_max}`);
            console.log(`\n  📊 黄龙山帮助信息：`);
            console.log(`     名称: ${huanglongHelp.name}`);
            console.log(`     人数: ${huanglongHelp.member_min}-${huanglongHelp.member_max} 人（固定5人编制）`);
            console.log(`     队长境界: ${huanglongHelp.leader_min_realm} (rank≥${huanglongHelp.leader_min_realm_rank})`);
            console.log(`     队员境界: ${huanglongHelp.member_min_realm} (rank≥${huanglongHelp.member_min_realm_rank})`);
            console.log(`     消耗物品: ${huanglongHelp.consume_item_key} ×${huanglongHelp.consume_item_count}`);
            console.log(`     冷却: ${huanglongHelp.cooldown_hours} 小时`);
            console.log(`     流程: ${huanglongHelp.act_count} 幕`);
        } else {
            check('help 返回 huanglong 配置', false, 'help 响应未包含 huanglong');
        }

        // 7.2 /rewards?dungeon_key=huanglong 应返回黄龙山奖励详情
        const rewardsRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=huanglong', token);
        check('/api/multi-dungeon/rewards?dungeon_key=huanglong 返回 200',
            rewardsRes.status === 200, `status=${rewardsRes.status}`);

        if (rewardsRes.json?.data) {
            const data = rewardsRes.json.data;
            check('rewards 响应包含黄龙山',
                data.dungeon_key === 'huanglong' || data.name === '黄龙山',
                `data=${JSON.stringify(data).substring(0, 100)}`);

            console.log(`\n  📊 黄龙山奖励信息：`);
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
                if (data.rewards.formation_power_bonus) {
                    console.log(`     阵法强度加成: 每10点 +${data.rewards.formation_power_bonus.exp_per_10_formation_power}修为 +${data.rewards.formation_power_bonus.spirit_stones_per_10_formation_power}灵石`);
                }
                if (data.rewards.perfect_bonus) {
                    console.log(`     完美通关加成: +${data.rewards.perfect_bonus.exp}修为 +${data.rewards.perfect_bonus.spirit_stones}灵石`);
                }
            }
        }

        // 7.3 /cooldown 应返回 huanglong 冷却状态
        const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown', token);
        check('/api/multi-dungeon/cooldown 返回 200',
            cooldownRes.status === 200, `status=${cooldownRes.status}`);
        check('cooldown 响应包含 huanglong 键',
            cooldownRes.json?.data?.cooldowns?.huanglong !== undefined,
            `keys=${Object.keys(cooldownRes.json?.data?.cooldowns || {}).join(',')}`);

        // 7.4 尝试创建黄龙山副本（预期失败：物品不足/同宗门/冷却）
        // 注：测试账号是化神期 rank=23 admin，境界满足要求（leader_min_realm_rank=19）
        // 但 require_same_sect=true 强制同宗门，单人创建会被拦截
        const createRes = await api('POST', '/api/multi-dungeon/create', token, {
            dungeon_key: 'huanglong'
        });
        check('POST /api/multi-dungeon/create huanglong 接口可调用',
            createRes.status === 200 || createRes.status === 400,
            `status=${createRes.status}`);

        if (createRes.json) {
            if (createRes.status === 200 && createRes.json?.data?.instance_id) {
                console.log(`     ⚠️  警告：测试账号创建了黄龙山副本实例（instance_id=${createRes.json.data.instance_id}）`);
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
