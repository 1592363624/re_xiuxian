/**
 * 批次4-4 道侣系统完整业务流程调研测试
 *
 * 目的：
 *   单账号视角验证道侣系统完整业务流程，识别未实现/有 bug 的功能点。
 *   由于只有一个测试账号（1592363624），无法做"双账号互相结缘"端到端测试，
 *   但可以：
 *   1. 查询当前道侣状态（已确认 has_companion=true, heart_contract_level=2）
 *   2. 测试所有道侣接口的可用性（propose/respond/interact/dual-cultivation/break/heart-tribulation/heart-imprint/protect-logs/protect-stats）
 *   3. 静态代码扫描 DaoCompanionService 的核心方法实现
 *   4. 验证配置文件 dao_companion_data.json 的核心数值
 *
 * 不破坏现有道侣关系（不调用 break 解除）。
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

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
    console.log('  批次4-4 道侣系统完整业务流程调研');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 DaoCompanionService 核心方法 =====
    console.log('[场景1] 静态代码扫描 DaoCompanionService 核心方法');
    const servicePath = path.join(__dirname, '../game/services/DaoCompanionService.js');
    const serviceCode = fs.readFileSync(servicePath, 'utf-8');

    const expectedMethods = [
        'static async propose(',
        'static async respond(',
        'static async interact(',
        'static async dualCultivate(',
        'static async breakCompanion(',
        'static async respondHeartTribulation(',
        'static async condenseHeartImprint(',
        'static async tryProtect(',
        'static async getProtectLogs(',
        'static async getProtectStats(',
        'static async getMyCompanion(',
        'static async getProposals('
    ];
    for (const m of expectedMethods) {
        check(`DaoCompanionService 应实现 ${m.replace(' static async ', '').replace('(', '')}`,
            serviceCode.includes(m),
            `缺失方法：${m}`);
    }

    // ===== 场景2：静态代码扫描 配置文件 =====
    console.log('\n[场景2] 配置文件 dao_companion_data.json 核心数值');
    const configPath = path.join(__dirname, '../config/dao_companion_data.json');
    const configCode = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configCode);

    // 核心配置项检查 —— 实际配置在 config.heart_contract_protect 下
    const protectConfig = config.heart_contract_protect || {};
    check('heart_contract_protect.enabled 配置应存在', protectConfig.enabled !== undefined, `enabled=${protectConfig.enabled}`);
    check('heart_contract_protect.min_level 配置应存在（心契等级门槛）', protectConfig.min_level !== undefined, `min_level=${protectConfig.min_level}`);
    check('heart_contract_protect.min_intimacy 配置应存在（亲密度门槛）', protectConfig.min_intimacy !== undefined, `min_intimacy=${protectConfig.min_intimacy}`);
    check('heart_contract_protect.cooldown_seconds 配置应存在', protectConfig.cooldown_seconds !== undefined, `cooldown_seconds=${protectConfig.cooldown_seconds}`);
    check('heart_contract_protect.damage_share_rate 配置应存在（伤害分担率）', protectConfig.damage_share_rate !== undefined, `damage_share_rate=${protectConfig.damage_share_rate}`);
    check('heart_contract_protect.counter_attack_rate 配置应存在（反击触发率）', protectConfig.counter_attack_rate !== undefined, `counter_attack_rate=${protectConfig.counter_attack_rate}`);
    check('heart_contract_protect.counter_attack_multiplier 配置应存在（反击伤害倍率）', protectConfig.counter_attack_multiplier !== undefined, `counter_attack_multiplier=${protectConfig.counter_attack_multiplier}`);
    check('heart_contract_protect.level_protect_rate 配置应存在（按心契等级的概率表）',
        protectConfig.level_protect_rate && typeof protectConfig.level_protect_rate === 'object',
        `level_protect_rate=${JSON.stringify(protectConfig.level_protect_rate)}`);

    // 通用配置在 config.settings 下，键名形如 dual_cultivation_* / interact_* / heart_tribulation_* / heart_imprint_*
    const settingsConfig = config.settings || {};
    check('settings.dual_cultivation_cooldown_seconds 应存在', settingsConfig.dual_cultivation_cooldown_seconds !== undefined,
        `dual_cultivation_cooldown_seconds=${settingsConfig.dual_cultivation_cooldown_seconds}`);
    check('settings.dual_cultivation_exp_multiplier 应存在', settingsConfig.dual_cultivation_exp_multiplier !== undefined,
        `dual_cultivation_exp_multiplier=${settingsConfig.dual_cultivation_exp_multiplier}`);
    check('settings.interact_intimacy_bonus 应存在', settingsConfig.interact_intimacy_bonus !== undefined,
        `interact_intimacy_bonus=${settingsConfig.interact_intimacy_bonus}`);
    check('settings.heart_tribulation_trigger_rate 应存在', settingsConfig.heart_tribulation_trigger_rate !== undefined,
        `heart_tribulation_trigger_rate=${settingsConfig.heart_tribulation_trigger_rate}`);
    check('settings.min_intimacy_for_heart_tribulation 应存在', settingsConfig.min_intimacy_for_heart_tribulation !== undefined,
        `min_intimacy_for_heart_tribulation=${settingsConfig.min_intimacy_for_heart_tribulation}`);
    check('settings.heart_imprint_exp_cost 应存在', settingsConfig.heart_imprint_exp_cost !== undefined,
        `heart_imprint_exp_cost=${settingsConfig.heart_imprint_exp_cost}`);
    check('settings.min_intimacy_for_heart_imprint 应存在', settingsConfig.min_intimacy_for_heart_imprint !== undefined,
        `min_intimacy_for_heart_imprint=${settingsConfig.min_intimacy_for_heart_imprint}`);
    check('settings.min_realm_rank 应存在（结丹期=15）', settingsConfig.min_realm_rank !== undefined,
        `min_realm_rank=${settingsConfig.min_realm_rank}`);
    check('settings.max_heart_contract_level 应存在（心契上限=9）', settingsConfig.max_heart_contract_level !== undefined,
        `max_heart_contract_level=${settingsConfig.max_heart_contract_level}`);

    console.log(`\n  心契等级护道概率表：${JSON.stringify(protectConfig.level_protect_rate)}`);
    console.log(`  通用设置键名列表：${Object.keys(settingsConfig).join(',')}`);

    // ===== 场景3：登录 =====
    console.log('\n[场景3] 登录测试账号');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200);
    const token = loginRes.json?.token;
    check('应返回 token', !!token);
    if (!token) process.exit(1);

    // ===== 场景4：道侣状态查询 =====
    console.log('\n[场景4] 道侣状态查询');
    const myRes = await api('GET', '/api/dao-companion/my', token);
    check('dao-companion/my 应返回 200', myRes.status === 200);
    const myData = myRes.json?.data;
    if (myData) {
        console.log(`  has_companion: ${myData.has_companion}`);
        console.log(`  companion_id: ${myData.companion_id}`);
        console.log(`  partner: ${JSON.stringify(myData.partner)}`);
        console.log(`  status: ${myData.status}`);
        console.log(`  intimacy: ${myData.intimacy}`);
        console.log(`  heart_contract_level: ${myData.heart_contract_level}`);
        console.log(`  heart_imprint_count: ${myData.heart_imprint_count}`);
        console.log(`  dual_cultivation_count: ${myData.dual_cultivation_count}`);
        console.log(`  dual_cultivation_bonus_rate: ${myData.dual_cultivation_bonus_rate}`);
        console.log(`  interact_cooldown_remaining: ${myData.interact_cooldown_remaining}`);
        console.log(`  dual_cultivation_cooldown_remaining: ${myData.dual_cultivation_cooldown_remaining}`);

        check('道侣关系应已建立（has_companion=true）', myData.has_companion === true);
        check('应返回 partner 字段', myData.partner !== null && myData.partner !== undefined);
        check('应返回 intimacy 字段（亲密度）', myData.intimacy !== undefined);
        check('应返回 heart_contract_level 字段（心契等级）', myData.heart_contract_level !== undefined);
        check('应返回 dual_cultivation_bonus_rate 字段（双修加成率）', myData.dual_cultivation_bonus_rate !== undefined);
    }

    // ===== 场景5：求婚列表 =====
    console.log('\n[场景5] 求婚列表');
    const proposeListRes = await api('GET', '/api/dao-companion/proposals', token);
    check('dao-companion/proposals 应返回 200', proposeListRes.status === 200);
    console.log(`  求婚列表数量: ${proposeListRes.json?.data?.length || 0}`);

    // ===== 场景6：心劫状态查询 =====
    console.log('\n[场景6] 心劫状态查询');
    const heartTribRes = await api('GET', '/api/dao-companion/heart-tribulation/status', token);
    check('heart-tribulation/status 应返回 200', heartTribRes.status === 200,
        `actual=${heartTribRes.status}, msg=${heartTribRes.json?.message || ''}`);

    // ===== 场景7：护道日志与统计 =====
    console.log('\n[场景7] 护道日志与统计');
    const logsRes = await api('GET', '/api/dao-companion/protect-logs', token);
    check('protect-logs 应返回 200', logsRes.status === 200);
    console.log(`  护道日志数量: ${logsRes.json?.data?.total || logsRes.json?.data?.length || 0}`);

    const statsRes = await api('GET', '/api/dao-companion/protect-stats', token);
    check('protect-stats 应返回 200', statsRes.status === 200);
    if (statsRes.json?.data) {
        console.log(`  护道统计: ${JSON.stringify(statsRes.json.data).slice(0, 200)}`);
    }

    // ===== 场景8：互动接口（不实际触发，只验证接口可用）=====
    // 注意：互动会修改亲密度，所以只验证接口是否存在
    console.log('\n[场景8] 互动接口可用性（不实际触发）');
    // 由于已经在冷却中或会修改数据，这里只检查接口路径存在
    check('interact 接口路径应存在于路由文件',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/interact'"));
    check('dual-cultivation 接口路径应存在',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/dual-cultivation'"));
    check('break 接口路径应存在',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/break'"));
    check('heart-imprint 接口路径应存在',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/heart-imprint'"));
    check('propose 接口路径应存在',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/propose'"));
    check('respond 接口路径应存在',
        fs.readFileSync(path.join(__dirname, '../routes/dao_companion.js'), 'utf-8')
            .includes("router.post('/respond'"));

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  道侣系统调研测试结果汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log(`  通过: ${passed} / ${total}`);
    console.log(`  失败: ${total - passed} / ${total}`);
    console.log(`  成功率: ${(passed / total * 100).toFixed(1)}%\n`);

    const failed = results.filter(r => !r.pass);
    if (failed.length > 0) {
        console.log('失败项明细：');
        failed.forEach(f => console.log(`  ❌ ${f.name} | ${f.detail}`));
    }

    process.exit(failed.length === 0 ? 0 : 1);
})();
