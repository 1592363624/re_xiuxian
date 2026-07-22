/**
 * 切磋木人端到端测试
 *
 * 目的：验证切磋木人（sparring_woodman）5档次战力测试玩法的配置完整性、
 *      服务方法存在性、模型字段同步性、接口可用性、战斗模拟逻辑、评分计算、
 *      奖励结算、排行榜查询、境界校验、每日次数限制、冷却机制。
 *
 * 测试范围：
 *   1. 静态代码扫描：SparringService 包含 7 个核心方法（getInfo/getStatus/startSparring/
 *      _simulateBattle/_calculateScore/getHistory/getRanking）
 *   2. 配置完整性：5 个档次木人 + 全局参数 + 评分参数 + 排行榜奖励
 *   3. 模型字段：playerSparring 模型与迁移脚本字段一致性
 *   4. 接口路由：/api/sparring 5个接口（info/status/start/history/ranking）
 *   5. 只读接口：info 返回 5 个木人配置；status 返回每日次数/冷却
 *   6. 战斗接口：start 接口尝试切磋，预期成功或被境界/次数/冷却拦截
 *   7. 排行榜接口：ranking 三种类型（daily/all_time/tier）查询
 *   8. 历史接口：history 分页查询
 *   9. 边界场景：无效 woodman_key、未鉴权、参数越界
 *
 * 玩法文档对照：xiuxian_game_guide.md 第17节·战力与阵法
 *   `.切磋木人 [境界]` 用于检查战斗准备，是战力测试功能
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
    console.log('  切磋木人端到端测试 (sparring_woodman)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - SparringService 核心方法 =====
    console.log('[场景1] 静态代码扫描 - SparringService 核心方法');

    const servicePath = path.join(__dirname, '../game/services/SparringService.js');
    const serviceCode = fs.existsSync(servicePath)
        ? fs.readFileSync(servicePath, 'utf-8')
        : '';

    // 1.1 核心方法存在性
    check('SparringService.js 文件存在', fs.existsSync(servicePath), '');
    check('SparringService 包含 getInfo 静态方法',
        /static\s+getInfo\s*\(/.test(serviceCode), '');
    check('SparringService 包含 getStatus 静态方法',
        /static\s+async\s+getStatus\s*\(/.test(serviceCode), '');
    check('SparringService 包含 startSparring 静态方法',
        /static\s+async\s+startSparring\s*\(/.test(serviceCode), '');
    check('SparringService 包含 _simulateBattle 私有方法',
        /static\s+_simulateBattle\s*\(/.test(serviceCode), '');
    check('SparringService 包含 _calculateScore 私有方法',
        /static\s+_calculateScore\s*\(/.test(serviceCode), '');
    check('SparringService 包含 getHistory 静态方法',
        /static\s+async\s+getHistory\s*\(/.test(serviceCode), '');
    check('SparringService 包含 getRanking 静态方法',
        /static\s+async\s+getRanking\s*\(/.test(serviceCode), '');

    // 1.2 关键业务逻辑校验
    check('startSparring 校验境界要求 (min_realm_rank)',
        serviceCode.includes('min_realm_rank') && serviceCode.includes('playerRank'), '');
    check('startSparring 校验每日次数 (daily_limit)',
        serviceCode.includes('daily_limit') && serviceCode.includes('todayCount'), '');
    check('startSparring 校验冷却 (cooldown_sec)',
        serviceCode.includes('cooldown_sec') && serviceCode.includes('cooldownEnd'), '');
    check('startSparring 行级锁玩家 (LOCK.UPDATE)',
        serviceCode.includes('lock: t.LOCK.UPDATE'), '');
    check('startSparring 使用事务 (transaction)',
        serviceCode.includes('await sequelize.transaction()'), '');
    check('_simulateBattle 使用 BigInt 防止溢出',
        serviceCode.includes('BigInt(') && serviceCode.includes('BigInt(0)'), '');
    check('_simulateBattle 速度决定先手',
        serviceCode.includes('playerFirst') && serviceCode.includes('speed'), '');
    check('_simulateBattle 技能攻击 (skill)',
        serviceCode.includes("'skill'") && serviceCode.includes('skillMpCost'), '');
    check('_simulateBattle MP 不足降级普攻',
        serviceCode.includes("action = 'attack'"), '');
    check('_calculateScore 评分公式 (基础分+效率分+HP保留分+完美分)',
        serviceCode.includes('baseScore') &&
        serviceCode.includes('efficiencyScore') &&
        serviceCode.includes('hpScore') &&
        serviceCode.includes('flawlessScore'), '');
    check('SparringService 使用 AttributeService 计算完整属性（含灵兽/装备加成）',
        serviceCode.includes('AttributeService') &&
        serviceCode.includes('calculateFullAttributesAsync'), '');

    // ===== 场景2：配置文件完整性 =====
    console.log('\n[场景2] 配置文件完整性校验');

    const configPath = path.join(__dirname, '../config/sparring_woodman.json');
    check('sparring_woodman.json 配置文件存在', fs.existsSync(configPath), '');

    let config = null;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        console.log('  ❌ 配置文件解析失败:', e.message);
    }

    check('配置包含 global 节点', !!config?.global, '');
    check('配置包含 woodmen 数组', Array.isArray(config?.woodmen), '');
    check('woodmen 应有 5 个档次木人', config?.woodmen?.length === 5,
        `actual=${config?.woodmen?.length}`);

    // 全局参数校验
    if (config?.global) {
        const g = config.global;
        check('global.daily_limit 存在且 > 0', typeof g.daily_limit === 'number' && g.daily_limit > 0, `actual=${g.daily_limit}`);
        check('global.cooldown_sec 存在且 >= 0', typeof g.cooldown_sec === 'number' && g.cooldown_sec >= 0, `actual=${g.cooldown_sec}`);
        check('global.min_realm_rank 存在且 > 0', typeof g.min_realm_rank === 'number' && g.min_realm_rank > 0, `actual=${g.min_realm_rank}`);
        check('global.max_rounds 存在且 > 0', typeof g.max_rounds === 'number' && g.max_rounds > 0, `actual=${g.max_rounds}`);
        check('global.skill_mp_cost 存在且 > 0', typeof g.skill_mp_cost === 'number' && g.skill_mp_cost > 0, `actual=${g.skill_mp_cost}`);
        check('global.skill_damage_multiplier 存在且 > 1', typeof g.skill_damage_multiplier === 'number' && g.skill_damage_multiplier > 1, `actual=${g.skill_damage_multiplier}`);
        check('global.score_base_per_tier 存在且 > 0', typeof g.score_base_per_tier === 'number' && g.score_base_per_tier > 0, `actual=${g.score_base_per_tier}`);
        check('global.score_efficiency_per_round_saved 存在且 > 0', typeof g.score_efficiency_per_round_saved === 'number' && g.score_efficiency_per_round_saved > 0, `actual=${g.score_efficiency_per_round_saved}`);
        check('global.score_hp_ratio_bonus 存在且 > 0', typeof g.score_hp_ratio_bonus === 'number' && g.score_hp_ratio_bonus > 0, `actual=${g.score_hp_ratio_bonus}`);
        check('global.score_flawless_bonus 存在且 > 0', typeof g.score_flawless_bonus === 'number' && g.score_flawless_bonus > 0, `actual=${g.score_flawless_bonus}`);
        check('global.ranking_top_n 存在且 > 0', typeof g.ranking_top_n === 'number' && g.ranking_top_n > 0, `actual=${g.ranking_top_n}`);
        check('global.ranking_daily_reward 存在', !!g.ranking_daily_reward, '');
        check('global.ranking_daily_reward 包含 1/2/3 名奖励',
            !!g.ranking_daily_reward?.['1'] &&
            !!g.ranking_daily_reward?.['2'] &&
            !!g.ranking_daily_reward?.['3'], '');
        check('global.ranking_daily_reward 包含 default 默认奖励',
            !!g.ranking_daily_reward?.default, '');
    }

    // 5 个木人档次校验
    const expectedKeys = ['qi_refining', 'foundation', 'core_formation', 'nascent_soul', 'spirit_severing'];
    const expectedNames = ['炼气木人', '筑基木人', '结丹木人', '元婴木人', '化神木人'];
    if (config?.woodmen?.length === 5) {
        config.woodmen.forEach((w, idx) => {
            check(`woodman[${idx}].tier 等于 ${idx + 1}`, w.tier === idx + 1, `actual=${w.tier}`);
            check(`woodman[${idx}].key 等于 ${expectedKeys[idx]}`, w.key === expectedKeys[idx], `actual=${w.key}`);
            check(`woodman[${idx}].name 等于 ${expectedNames[idx]}`, w.name === expectedNames[idx], `actual=${w.name}`);
            check(`woodman[${idx}].stats.max_hp > 0`, w.stats?.max_hp > 0, `actual=${w.stats?.max_hp}`);
            check(`woodman[${idx}].stats.atk > 0`, w.stats?.atk > 0, `actual=${w.stats?.atk}`);
            check(`woodman[${idx}].stats.def >= 0`, w.stats?.def >= 0, `actual=${w.stats?.def}`);
            check(`woodman[${idx}].stats.speed > 0`, w.stats?.speed > 0, `actual=${w.stats?.speed}`);
            check(`woodman[${idx}].rewards.exp_win > 0`, w.rewards?.exp_win > 0, `actual=${w.rewards?.exp_win}`);
            check(`woodman[${idx}].rewards.spirit_stones_win > 0`, w.rewards?.spirit_stones_win > 0, `actual=${w.rewards?.spirit_stones_win}`);
            check(`woodman[${idx}].first_clear_bonus 存在`, !!w.first_clear_bonus, '');
            check(`woodman[${idx}].first_clear_bonus.exp > 0`, (w.first_clear_bonus?.exp || 0) > 0, `actual=${w.first_clear_bonus?.exp}`);
            check(`woodman[${idx}].first_clear_bonus.spirit_stones > 0`, (w.first_clear_bonus?.spirit_stones || 0) > 0, `actual=${w.first_clear_bonus?.spirit_stones}`);
            check(`woodman[${idx}].ai_strategy 存在`, !!w.ai_strategy, `actual=${w.ai_strategy}`);
            check(`woodman[${idx}].description 存在`, !!w.description, '');
        });

        // 梯度递增校验
        const tiers = config.woodmen;
        check('木人 max_hp 梯度递增',
            tiers[0].stats.max_hp < tiers[1].stats.max_hp &&
            tiers[1].stats.max_hp < tiers[2].stats.max_hp &&
            tiers[2].stats.max_hp < tiers[3].stats.max_hp &&
            tiers[3].stats.max_hp < tiers[4].stats.max_hp, '');
        check('木人 atk 梯度递增',
            tiers[0].stats.atk < tiers[1].stats.atk &&
            tiers[1].stats.atk < tiers[2].stats.atk &&
            tiers[2].stats.atk < tiers[3].stats.atk &&
            tiers[3].stats.atk < tiers[4].stats.atk, '');
        check('木人奖励 exp_win 梯度递增',
            tiers[0].rewards.exp_win < tiers[1].rewards.exp_win &&
            tiers[1].rewards.exp_win < tiers[2].rewards.exp_win &&
            tiers[2].rewards.exp_win < tiers[3].rewards.exp_win &&
            tiers[3].rewards.exp_win < tiers[4].rewards.exp_win, '');

        // 化神木人首通奖励含称号
        const spiritSevering = tiers[4];
        check('化神木人首通奖励含称号 (title)',
            !!spiritSevering.first_clear_bonus?.title,
            `actual=${spiritSevering.first_clear_bonus?.title}`);
    }

    // ===== 场景3：模型字段一致性 =====
    console.log('\n[场景3] 模型字段一致性校验');

    const modelPath = path.join(__dirname, '../models/playerSparring.js');
    const modelCode = fs.existsSync(modelPath)
        ? fs.readFileSync(modelPath, 'utf-8')
        : '';

    check('playerSparring.js 模型文件存在', fs.existsSync(modelPath), '');
    check('模型对应表名 player_sparring', modelCode.includes("tableName: 'player_sparring'"), '');
    check('模型包含 player_id 字段', modelCode.includes('player_id'), '');
    check('模型包含 player_nickname 字段', modelCode.includes('player_nickname'), '');
    check('模型包含 player_realm_rank 字段', modelCode.includes('player_realm_rank'), '');
    check('模型包含 player_realm_name 字段', modelCode.includes('player_realm_name'), '');
    check('模型包含 woodman_tier 字段', modelCode.includes('woodman_tier'), '');
    check('模型包含 woodman_key 字段', modelCode.includes('woodman_key'), '');
    check('模型包含 woodman_name 字段', modelCode.includes('woodman_name'), '');
    check('模型包含 rounds_used 字段', modelCode.includes('rounds_used'), '');
    check('模型包含 max_rounds 字段', modelCode.includes('max_rounds'), '');
    check('模型包含 player_hp_remaining 字段', modelCode.includes('player_hp_remaining'), '');
    check('模型包含 player_hp_max 字段', modelCode.includes('player_hp_max'), '');
    check('模型包含 player_mp_used 字段', modelCode.includes('player_mp_used'), '');
    check('模型包含 total_damage_dealt 字段', modelCode.includes('total_damage_dealt'), '');
    check('模型包含 total_damage_taken 字段', modelCode.includes('total_damage_taken'), '');
    check('模型包含 result 字段', modelCode.includes('result'), '');
    check('模型包含 score 字段', modelCode.includes('score'), '');
    check('模型包含 is_first_clear 字段', modelCode.includes('is_first_clear'), '');
    check('模型包含 exp_gained 字段', modelCode.includes('exp_gained'), '');
    check('模型包含 spirit_stones_gained 字段', modelCode.includes('spirit_stones_gained'), '');
    check('模型包含 title_awarded 字段', modelCode.includes('title_awarded'), '');
    check('模型包含 battle_log 字段', modelCode.includes('battle_log'), '');
    check('模型包含 settled_at 字段', modelCode.includes('settled_at'), '');
    check('模型包含 5 个索引', (modelCode.match(/idx_ps_/g) || []).length === 5, '');

    // ===== 场景4：迁移脚本存在性 =====
    console.log('\n[场景4] 迁移脚本存在性校验');

    const migrationPath = path.join(__dirname, '../scripts/migration_0061_sparring_records.js');
    check('migration_0061_sparring_records.js 文件存在', fs.existsSync(migrationPath), '');

    const migrationCode = fs.existsSync(migrationPath)
        ? fs.readFileSync(migrationPath, 'utf-8')
        : '';

    check('迁移脚本名称 0061_sparring_records',
        migrationCode.includes("name: '0061_sparring_records'"), '');
    check('迁移脚本包含 CREATE TABLE player_sparring',
        migrationCode.includes('CREATE TABLE player_sparring'), '');
    check('迁移脚本幂等性检查 (tableExists)',
        migrationCode.includes('tableExists'), '');
    check('迁移脚本包含 5 个索引',
        (migrationCode.match(/INDEX idx_ps_/g) || []).length === 5, '');
    check('迁移脚本包含 down 回滚方法',
        /down:\s*async\s*\(/.test(migrationCode), '');

    // ===== 场景5：路由文件存在性 =====
    console.log('\n[场景5] 路由文件存在性校验');

    const routePath = path.join(__dirname, '../routes/sparring.js');
    const routeCode = fs.existsSync(routePath)
        ? fs.readFileSync(routePath, 'utf-8')
        : '';

    check('routes/sparring.js 文件存在', fs.existsSync(routePath), '');
    check('路由包含 GET /info', routeCode.includes("router.get('/info'"), '');
    check('路由包含 GET /status', routeCode.includes("router.get('/status'"), '');
    check('路由包含 POST /start', routeCode.includes("router.post('/start'"), '');
    check('路由包含 GET /history', routeCode.includes("router.get('/history'"), '');
    check('路由包含 GET /ranking', routeCode.includes("router.get('/ranking'"), '');
    check('/start 接口使用 auth 中间件',
        routeCode.includes("router.post('/start', auth"), '');
    check('/status 接口使用 auth 中间件',
        routeCode.includes("router.get('/status', auth"), '');
    check('/history 接口使用 auth 中间件',
        routeCode.includes("router.get('/history', auth"), '');
    check('/ranking 接口使用 auth 中间件',
        routeCode.includes("router.get('/ranking', auth"), '');

    // ===== 场景6：index.js 路由挂载 =====
    console.log('\n[场景6] index.js 路由挂载校验');

    const indexPath = path.join(__dirname, '../index.js');
    const indexCode = fs.existsSync(indexPath)
        ? fs.readFileSync(indexPath, 'utf-8')
        : '';

    check("index.js 挂载 /api/sparring 路由",
        indexCode.includes("app.use('/api/sparring', require('./routes/sparring'))"), '');
    check('index.js 加载 playerSparring 模型',
        indexCode.includes("require('./models/playerSparring')"), '');
    // 路由挂载位置在通配符 404 之前
    const sparringMountIdx = indexCode.indexOf("app.use('/api/sparring'");
    const wildcardIdx = indexCode.indexOf("app.use('/api/*'");
    check('路由挂载在通配符 404 之前',
        sparringMountIdx > 0 && wildcardIdx > 0 && sparringMountIdx < wildcardIdx, '');

    // ===== 场景7：登录 =====
    console.log('\n[场景7] 登录测试账号');

    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200, `actual=${loginRes.status}`);
    const token = loginRes.json?.token;
    check('应返回 token', !!token, '');
    if (!token) {
        console.log('❌ 无法获取 token，终止接口测试');
        printSummary();
        process.exit(1);
    }

    // ===== 场景8：GET /api/sparring/info =====
    console.log('\n[场景8] GET /api/sparring/info 配置接口');

    const infoRes = await api('GET', '/api/sparring/info', null);
    check('/api/sparring/info 应返回 200', infoRes.status === 200,
        `actual=${infoRes.status}, msg=${infoRes.json?.message || ''}`);
    check('/api/sparring/info 应返回 code=200', infoRes.json?.code === 200, '');
    const infoData = infoRes.json?.data;
    check('info 应返回 global 配置', !!infoData?.global, '');
    check('info 应返回 woodmen 数组', Array.isArray(infoData?.woodmen), '');
    check('info 应返回 5 个木人', infoData?.woodmen?.length === 5,
        `actual=${infoData?.woodmen?.length}`);

    if (infoData?.woodmen?.length === 5) {
        infoData.woodmen.forEach((w, idx) => {
            check(`info woodman[${idx}] 含 tier/key/name/stats/rewards`,
                !!w.tier && !!w.key && !!w.name && !!w.stats && !!w.rewards, '');
        });
    }

    // ===== 场景9：GET /api/sparring/status =====
    console.log('\n[场景9] GET /api/sparring/status 状态接口');

    const statusRes = await api('GET', '/api/sparring/status', token);
    check('/api/sparring/status 应返回 200', statusRes.status === 200,
        `actual=${statusRes.status}, msg=${statusRes.json?.message || ''}`);
    check('/api/sparring/status 应返回 code=200', statusRes.json?.code === 200, '');
    const statusData = statusRes.json?.data;
    check('status 应返回 daily_limit', typeof statusData?.daily_limit === 'number', '');
    check('status 应返回 daily_used', typeof statusData?.daily_used === 'number', '');
    check('status 应返回 daily_remaining', typeof statusData?.daily_remaining === 'number', '');
    check('status 应返回 cooldown_remaining_sec', typeof statusData?.cooldown_remaining_sec === 'number', '');
    check('status 应返回 can_sparring (布尔)', typeof statusData?.can_sparring === 'boolean', '');
    check('status 应返回 first_clears 数组', Array.isArray(statusData?.first_clears), '');
    check('status 应返回 best_score', statusData?.best_score !== undefined, '');
    check('status 应返回 today_records 数组', Array.isArray(statusData?.today_records), '');

    console.log(`  玩家状态：daily_used=${statusData?.daily_used}/${statusData?.daily_limit}, cooldown=${statusData?.cooldown_remaining_sec}s, can=${statusData?.can_sparring}`);

    // ===== 场景10：POST /api/sparring/start 边界场景 =====
    console.log('\n[场景10] POST /api/sparring/start 边界场景');

    // 10.1 未鉴权访问
    const noAuthRes = await api('POST', '/api/sparring/start', null, { woodman_key: 'qi_refining' });
    check('未鉴权访问 /start 应返回 401', noAuthRes.status === 401, `actual=${noAuthRes.status}`);

    // 10.2 缺少 woodman_key 参数
    const noKeyRes = await api('POST', '/api/sparring/start', token, {});
    check('缺少 woodman_key 应返回 400', noKeyRes.status === 400, `actual=${noKeyRes.status}`);
    check('错误码应为 VALIDATION_ERROR', noKeyRes.json?.error_code === 'VALIDATION_ERROR',
        `actual=${noKeyRes.json?.error_code}`);

    // 10.3 无效 woodman_key
    const invalidKeyRes = await api('POST', '/api/sparring/start', token, { woodman_key: 'invalid_key' });
    check('无效 woodman_key 应返回 400', invalidKeyRes.status === 400, `actual=${invalidKeyRes.status}`);
    check('错误信息包含可选值提示', (invalidKeyRes.json?.message || '').includes('qi_refining'), '');

    // ===== 场景11：尝试实际切磋 =====
    console.log('\n[场景11] 尝试实际切磋（化神初期 rank=23 应能挑战全部档次）');

    // 选择炼气木人（tier 1，最弱的）作为测试目标，避免直接挑战化神木人失败
    const startRes = await api('POST', '/api/sparring/start', token, { woodman_key: 'qi_refining' });

    if (startRes.status === 200) {
        check('切磋请求应返回 200', startRes.status === 200, '');
        check('切磋应返回 code=200', startRes.json?.code === 200, '');
        const startData = startRes.json?.data;
        check('应返回 record_id', !!startData?.record_id, '');
        check('应返回 woodman 信息', !!startData?.woodman, '');
        check('应返回 battle 信息', !!startData?.battle, '');
        check('应返回 score 评分', startData?.score !== undefined, '');
        check('应返回 rewards 奖励', !!startData?.rewards, '');
        check('应返回 daily_remaining', startData?.daily_remaining !== undefined, '');

        const battle = startData?.battle;
        if (battle) {
            check('battle.result 应为 win/lose/timeout',
                ['win', 'lose', 'timeout'].includes(battle.result),
                `actual=${battle.result}`);
            check('battle.rounds 应为正整数',
                Number.isInteger(battle.rounds) && battle.rounds > 0,
                `actual=${battle.rounds}`);
            check('battle 应包含 player_hp_remaining',
                battle.player_hp_remaining !== undefined, '');
            check('battle 应包含 woodman_hp_remaining',
                battle.woodman_hp_remaining !== undefined, '');
            check('battle 应包含 total_damage_dealt',
                battle.total_damage_dealt !== undefined, '');
            check('battle 应包含 total_damage_taken',
                battle.total_damage_taken !== undefined, '');
            check('battle 应包含 is_flawless 布尔值',
                typeof battle.is_flawless === 'boolean', '');
            check('battle 应包含 log 数组',
                Array.isArray(battle.log), '');

            console.log(`  战斗结果：${battle.result}, 回合数=${battle.rounds}, 评分=${startData.score}`);
            console.log(`  玩家HP：${battle.player_hp_remaining}/${battle.player_hp_max}, 木人HP：${battle.woodman_hp_remaining}/${battle.woodman_hp_max}`);
            console.log(`  奖励：修为=${startData.rewards.exp}, 灵石=${startData.rewards.spirit_stones}, 首通=${startData.rewards.is_first_clear}`);

            // 如果胜利，验证评分计算
            if (battle.result === 'win') {
                check('胜利时 score 应 > 0', startData.score > 0, `actual=${startData.score}`);
                // 基础分至少 1000（炼气木人 tier=1）
                check('胜利时 score 应 >= 1000 (基础分)',
                    startData.score >= 1000, `actual=${startData.score}`);
            } else {
                check('失败/超时时 score 应 = 0', startData.score === 0, `actual=${startData.score}`);
            }
        }
    } else {
        // 可能因为冷却或次数限制被拒
        check(`切磋被拒（预期：冷却/次数限制） status=${startRes.status}`,
            startRes.status === 400,
            `msg=${startRes.json?.message || ''}`);
        console.log(`  ℹ️ 切磋被拒：${startRes.json?.message || '未知原因'}`);
        console.log('  ℹ️ 如需重新测试，请等待冷却结束或调整测试账号状态');
    }

    // ===== 场景12：再次切磋应触发冷却 =====
    console.log('\n[场景12] 验证冷却机制');

    const cooldownRes = await api('POST', '/api/sparring/start', token, { woodman_key: 'foundation' });
    // 如果刚刚切磋成功，本次应被冷却拦截
    if (startRes.status === 200) {
        check('冷却期内再次切磋应返回 400', cooldownRes.status === 400, `actual=${cooldownRes.status}`);
        check('冷却拦截错误信息应包含"冷却"', (cooldownRes.json?.message || '').includes('冷却'), '');
    } else {
        console.log(`  ℹ️ 跳过冷却验证（首次切磋未成功）`);
    }

    // ===== 场景13：GET /api/sparring/history =====
    console.log('\n[场景13] GET /api/sparring/history 历史接口');

    const historyRes = await api('GET', '/api/sparring/history?limit=5&offset=0', token);
    check('/api/sparring/history 应返回 200', historyRes.status === 200,
        `actual=${historyRes.status}, msg=${historyRes.json?.message || ''}`);
    check('/api/sparring/history 应返回 code=200', historyRes.json?.code === 200, '');
    const historyData = historyRes.json?.data;
    check('history 应返回 total', historyData?.total !== undefined, '');
    check('history 应返回 limit', historyData?.limit !== undefined, '');
    check('history 应返回 offset', historyData?.offset !== undefined, '');
    check('history 应返回 records 数组', Array.isArray(historyData?.records), '');

    if (historyData?.records?.length > 0) {
        const r = historyData.records[0];
        check('history record 含 id', !!r.id, '');
        check('history record 含 woodman_name', !!r.woodman_name, '');
        check('history record 含 result', !!r.result, '');
        check('history record 含 score', r.score !== undefined, '');
        check('history record 含 rounds_used', r.rounds_used !== undefined, '');
        check('history record 含 created_at', !!r.created_at, '');
    }

    // ===== 场景14：GET /api/sparring/ranking =====
    console.log('\n[场景14] GET /api/sparring/ranking 排行榜接口');

    // 14.1 daily 排行榜
    const dailyRankRes = await api('GET', '/api/sparring/ranking?type=daily&limit=10', token);
    check('daily 排行榜应返回 200', dailyRankRes.status === 200,
        `actual=${dailyRankRes.status}, msg=${dailyRankRes.json?.message || ''}`);
    check('daily 排行榜应返回 code=200', dailyRankRes.json?.code === 200, '');
    check('daily 排行榜应返回 type=daily', dailyRankRes.json?.data?.type === 'daily', '');
    check('daily 排行榜应返回 ranking 数组', Array.isArray(dailyRankRes.json?.data?.ranking), '');

    // 14.2 all_time 排行榜
    const allTimeRankRes = await api('GET', '/api/sparring/ranking?type=all_time&limit=20', token);
    check('all_time 排行榜应返回 200', allTimeRankRes.status === 200,
        `actual=${allTimeRankRes.status}`);
    check('all_time 排行榜应返回 type=all_time', allTimeRankRes.json?.data?.type === 'all_time', '');

    // 14.3 tier 排行榜
    const tierRankRes = await api('GET', '/api/sparring/ranking?type=tier&tier=1&limit=10', token);
    check('tier 排行榜应返回 200', tierRankRes.status === 200,
        `actual=${tierRankRes.status}`);
    check('tier 排行榜应返回 type=tier', tierRankRes.json?.data?.type === 'tier', '');

    // 14.4 无效 type 默认为 daily
    const invalidTypeRes = await api('GET', '/api/sparring/ranking?type=invalid', token);
    check('无效 type 应默认为 daily', invalidTypeRes.json?.data?.type === 'daily', '');

    // ===== 场景15：参数边界校验 =====
    console.log('\n[场景15] 参数边界校验');

    // 15.1 history limit 越界（>100 应被截断为 100）
    const bigLimitRes = await api('GET', '/api/sparring/history?limit=999', token);
    check('history limit > 100 应被截断为 100',
        bigLimitRes.json?.data?.limit === 100, `actual=${bigLimitRes.json?.data?.limit}`);

    // 15.2 ranking limit 越界（>50 应被截断为 50）
    const bigRankLimitRes = await api('GET', '/api/sparring/ranking?limit=999', token);
    check('ranking limit > 50 应被截断为 50',
        bigRankLimitRes.json?.data?.ranking?.length <= 50, '');

    // 15.3 tier 越界（tier=99 应被忽略）
    const invalidTierRes = await api('GET', '/api/sparring/ranking?type=tier&tier=99', token);
    check('tier=99 应返回 200（tier 被忽略）',
        invalidTierRes.status === 200, `actual=${invalidTierRes.status}`);

    // ===== 场景16：openapi.json 同步性 =====
    console.log('\n[场景16] openapi.json 同步性校验');

    const openapiPath = path.join(__dirname, '../../docs/openapi.json');
    let openapiCode = '';
    try {
        openapiCode = fs.readFileSync(openapiPath, 'utf-8');
    } catch (e) {
        console.log('  ℹ️ openapi.json 读取失败（可能尚未同步）');
    }

    if (openapiCode) {
        check('openapi.json 包含 /api/sparring/info 路径',
            openapiCode.includes('/api/sparring/info'), '');
        check('openapi.json 包含 /api/sparring/status 路径',
            openapiCode.includes('/api/sparring/status'), '');
        check('openapi.json 包含 /api/sparring/start 路径',
            openapiCode.includes('/api/sparring/start'), '');
        check('openapi.json 包含 /api/sparring/history 路径',
            openapiCode.includes('/api/sparring/history'), '');
        check('openapi.json 包含 /api/sparring/ranking 路径',
            openapiCode.includes('/api/sparring/ranking'), '');
    } else {
        check('openapi.json 同步（跳过：文件读取失败）', false, '需后续同步');
    }

    // ===== 输出汇总 =====
    printSummary();

    function printSummary() {
        console.log('\n========================================');
        console.log('  测试结果汇总');
        console.log('========================================');
        const passed = results.filter(r => r.pass).length;
        const failed = results.filter(r => !r.pass).length;
        const total = results.length;
        console.log(`  通过: ${passed}/${total}`);
        console.log(`  失败: ${failed}/${total}`);
        console.log(`  通过率: ${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%`);
        console.log('========================================');

        if (failed > 0) {
            console.log('\n失败项明细：');
            results.filter(r => !r.pass).forEach(r => {
                console.log(`  ❌ ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
            });
        }

        process.exit(failed > 0 ? 1 : 0);
    }
})();
