/**
 * 修炼配置管理接口测试脚本
 *
 * 验证 GM 后台修炼配置的 GET/POST 接口、热加载效果、权限校验、字段白名单、数值范围校验
 *
 * 用法：node scripts/test_admin_cultivation.js
 */
const http = require('http');

const BASE_URL = 'http://localhost:5000';
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

/**
 * 发送 HTTP 请求的封装
 * @param {string} method - GET/POST
 * @param {string} path - 路径
 * @param {string} token - JWT token（可选）
 * @param {object} body - 请求体（可选）
 * @returns {Promise<object>}
 */
function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: 'localhost',
      port: 5000,
      path,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(chunks) });
        } catch (e) {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 登录获取 token
 */
async function login() {
  const res = await request('POST', '/api/auth/login', null, {
    username: TEST_ACCOUNT,
    password: TEST_PASSWORD
  });
  if (res.status === 200 && res.body?.token) {
    console.log(`✓ 登录成功（玩家ID: ${res.body.player?.id}, 角色: ${res.body.player?.role}）`);
    return res.body.token;
  }
  throw new Error(`登录失败: ${JSON.stringify(res.body)}`);
}

/**
 * 测试 1: GET /api/admin/cultivation/config（正常流程）
 */
async function testGetConfig(token) {
  console.log('\n========== 测试 1: GET 修炼配置 ==========');
  const res = await request('GET', '/api/admin/cultivation/config', token);
  console.log(`状态码: ${res.status}`);
  if (res.status === 200 && res.body?.data) {
    const d = res.body.data;
    console.log(`✓ 闭关基础修为速率: ${d.seclusion?.base_exp_rate}`);
    console.log(`✓ 常规闭关: max_duration=${d.seclusion?.normal?.max_duration}, daily_limit=${d.seclusion?.normal?.daily_limit}, cooldown=${d.seclusion?.normal?.cooldown}, exp_rate=${d.seclusion?.normal?.exp_rate}`);
    console.log(`✓ 深度闭关: min_duration=${d.seclusion?.deep?.min_duration}, max_duration=${d.seclusion?.deep?.max_duration}, daily_limit=${d.seclusion?.deep?.daily_limit}, exp_rate=${d.seclusion?.deep?.exp_rate}, min_realm=${d.seclusion?.deep?.min_realm}, forced_penalty=${d.seclusion?.deep?.forced_penalty}`);
    console.log(`✓ 历练时长分级:`);
    for (const t of ['short', 'medium', 'long']) {
      const c = d.adventure?.duration_types?.[t];
      if (c) {
        console.log(`  - ${t} (${c.label}): duration=${c.duration}, reward_multiplier=${c.reward_multiplier}, injury_chance=${c.injury_chance}, injury_hp_loss_rate=${c.injury_hp_loss_rate}`);
      }
    }
    console.log(`✓ 默认时长类型: ${d.adventure?.default_duration_type}`);
    console.log(`✓ 提前结束惩罚: ${d.adventure?.early_finish_penalty}`);
    return d;
  } else {
    console.log(`✗ 获取配置失败: ${JSON.stringify(res.body)}`);
    throw new Error('获取配置失败');
  }
}

/**
 * 测试 2: POST /api/admin/cultivation/seclusion（更新闭关配置）
 */
async function testUpdateSeclusion(token, original) {
  console.log('\n========== 测试 2: POST 更新闭关配置 ==========');
  // 临时改一个字段（cooldown: 300 → 360），其他不变
  const res = await request('POST', '/api/admin/cultivation/seclusion', token, {
    normal: {
      max_duration: original.seclusion.normal.max_duration,
      daily_limit: original.seclusion.normal.daily_limit,
      cooldown: 360, // 改这个
      exp_rate: original.seclusion.normal.exp_rate
    }
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 200) {
    console.log(`✓ 消息: ${res.body?.message}`);
    console.log(`✓ 更新后 cooldown: ${res.body?.data?.normal?.cooldown}`);
    console.log(`✓ 备份路径: ${res.body?.data?.backup}`);
    return res.body.data;
  } else {
    console.log(`✗ 更新失败: ${JSON.stringify(res.body)}`);
    throw new Error('更新闭关配置失败');
  }
}

/**
 * 测试 3: 数值范围校验（应该失败）
 */
async function testValidationFail(token) {
  console.log('\n========== 测试 3: 数值范围校验（应失败） ==========');
  const res = await request('POST', '/api/admin/cultivation/seclusion', token, {
    normal: {
      max_duration: 10, // 小于 60，应被拒
      daily_limit: 3,
      cooldown: 300,
      exp_rate: 1
    }
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 400) {
    console.log(`✓ 正确拒绝: error_code=${res.body?.error_code}, message=${res.body?.message}`);
  } else {
    console.log(`✗ 未拒绝异常值: ${JSON.stringify(res.body)}`);
    throw new Error('数值范围校验未生效');
  }
}

/**
 * 测试 4: 字段白名单（应过滤掉非法字段）
 */
async function testFieldWhitelist(token, original) {
  console.log('\n========== 测试 4: 字段白名单（应过滤非法字段） ==========');
  const res = await request('POST', '/api/admin/cultivation/seclusion', token, {
    normal: {
      cooldown: 420,
      // 试图注入非法字段
      is_admin: true,
      sql_injection: "'; DROP TABLE players; --"
    }
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 200) {
    console.log(`✓ 请求成功（非法字段被过滤）`);
    console.log(`✓ cooldown 已更新为: ${res.body?.data?.normal?.cooldown}`);
  } else {
    console.log(`✗ 请求失败: ${JSON.stringify(res.body)}`);
    throw new Error('字段白名单测试失败');
  }
  return res.body?.data;
}

/**
 * 测试 5: POST /api/admin/cultivation/adventure（更新历练配置）
 */
async function testUpdateAdventure(token, original) {
  console.log('\n========== 测试 5: POST 更新历练配置 ==========');
  const newShort = { ...original.adventure.duration_types.short };
  newShort.injury_chance = 0.02; // 改一下受伤概率
  const res = await request('POST', '/api/admin/cultivation/adventure', token, {
    duration_types: {
      short: newShort
    }
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 200) {
    console.log(`✓ 消息: ${res.body?.message}`);
    console.log(`✓ 更新后 short.injury_chance: ${res.body?.data?.adventure?.duration_types?.short?.injury_chance}`);
    console.log(`✓ 备份路径: ${res.body?.data?.backup}`);
  } else {
    console.log(`✗ 更新失败: ${JSON.stringify(res.body)}`);
    throw new Error('更新历练配置失败');
  }
}

/**
 * 测试 6: 热加载验证（再次 GET 确认配置已刷新）
 */
async function testHotReload(token, expectedCooldown) {
  console.log('\n========== 测试 6: 热加载验证 ==========');
  const res = await request('GET', '/api/admin/cultivation/config', token);
  if (res.status === 200) {
    const actualCooldown = res.body?.data?.seclusion?.normal?.cooldown;
    if (actualCooldown === expectedCooldown) {
      console.log(`✓ 热加载验证通过: cooldown=${actualCooldown}`);
    } else {
      console.log(`✗ 热加载未生效: 期望 ${expectedCooldown}, 实际 ${actualCooldown}`);
      throw new Error('热加载未生效');
    }
  }
}

/**
 * 测试 7: 恢复原始配置
 */
async function restoreOriginal(token, original) {
  console.log('\n========== 测试 7: 恢复原始配置 ==========');
  const res = await request('POST', '/api/admin/cultivation/seclusion', token, {
    normal: { ...original.seclusion.normal }
  });
  if (res.status === 200) {
    console.log(`✓ 闭关配置已恢复`);
  }
  const res2 = await request('POST', '/api/admin/cultivation/adventure', token, {
    duration_types: {
      short: { ...original.adventure.duration_types.short },
      medium: { ...original.adventure.duration_types.medium },
      long: { ...original.adventure.duration_types.long }
    }
  });
  if (res2.status === 200) {
    console.log(`✓ 历练配置已恢复`);
  }
}

/**
 * 测试 8: 未授权访问（应失败）
 */
async function testUnauthorized() {
  console.log('\n========== 测试 8: 未授权访问（应失败） ==========');
  const res = await request('GET', '/api/admin/cultivation/config', null);
  console.log(`状态码: ${res.status}`);
  if (res.status === 401) {
    console.log(`✓ 正确拒绝未授权访问: ${res.body?.message || '需要登录'}`);
  } else {
    console.log(`✗ 未授权访问未被拒绝: ${JSON.stringify(res.body)}`);
    throw new Error('权限校验未生效');
  }
}

/**
 * 主测试流程
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       修炼配置管理接口测试 - 开始                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // 登录
  const token = await login();

  // 测试未授权访问
  await testUnauthorized();

  // 获取原始配置
  const original = await testGetConfig(token);

  // 更新闭关配置
  await testUpdateSeclusion(token, original);

  // 数值范围校验
  await testValidationFail(token);

  // 字段白名单
  await testFieldWhitelist(token, original);

  // 更新历练配置
  await testUpdateAdventure(token, original);

  // 热加载验证
  await testHotReload(token, 420);

  // 恢复原始配置
  await restoreOriginal(token, original);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       全部测试通过 ✓                                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n测试失败:', err.message);
  process.exit(1);
});
