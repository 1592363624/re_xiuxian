/**
 * 修炼配置管理接口测试脚本 V2（含历史版本与回滚）
 *
 * 在 V1 基础上追加：
 *   - 测试 GET /api/admin/cultivation/backups（列表查询 + 类型筛选）
 *   - 测试 POST /api/admin/cultivation/rollback（回滚 + 回滚链验证）
 *   - 测试路径穿越攻击防护（应被拒绝）
 *
 * 用法：node scripts/test_admin_cultivation_v2.js
 */
const http = require('http');

const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

/**
 * 发送 HTTP 请求
 */
function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: 'localhost',
      port: 5000,
      path,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch (e) { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 登录
 */
async function login() {
  const res = await request('POST', '/api/auth/login', null, {
    username: TEST_ACCOUNT, password: TEST_PASSWORD
  });
  if (res.status === 200 && res.body?.token) {
    console.log(`✓ 登录成功（玩家ID: ${res.body.player?.id}, 角色: ${res.body.player?.role}）`);
    return res.body.token;
  }
  throw new Error(`登录失败: ${JSON.stringify(res.body)}`);
}

/**
 * 测试 1: 获取全部历史版本
 */
async function testGetAllBackups(token) {
  console.log('\n========== 测试 1: GET 全部历史版本 ==========');
  const res = await request('GET', '/api/admin/cultivation/backups', token);
  console.log(`状态码: ${res.status}`);
  if (res.status === 200 && Array.isArray(res.body?.data)) {
    console.log(`✓ 返回 ${res.body.data.length} 个备份`);
    res.body.data.slice(0, 3).forEach((b, i) => {
      console.log(`  ${i + 1}. [${b.configLabel}] ${b.filename} (${b.sizeText}, ${new Date(b.mtime).toLocaleString('zh-CN')})`);
    });
    return res.body.data;
  }
  throw new Error('获取历史版本失败');
}

/**
 * 测试 2: 按类型筛选历史版本
 */
async function testFilterBackups(token, type) {
  console.log(`\n========== 测试 2: GET 按类型筛选 ${type} ==========`);
  const res = await request('GET', `/api/admin/cultivation/backups?type=${type}`, token);
  if (res.status === 200 && Array.isArray(res.body?.data)) {
    const allMatchType = res.body.data.every(b => b.configType === type);
    if (allMatchType) {
      console.log(`✓ 返回 ${res.body.data.length} 个 ${type} 备份，类型筛选正确`);
    } else {
      throw new Error('类型筛选失败：返回了其他类型');
    }
    return res.body.data;
  }
  throw new Error('按类型筛选历史版本失败');
}

/**
 * 测试 3: 正常回滚流程
 */
async function testRollback(token, backups) {
  console.log('\n========== 测试 3: POST 回滚到第一个备份 ==========');
  if (backups.length === 0) {
    console.log('⚠ 无备份可测试，跳过');
    return;
  }
  const target = backups[0];
  console.log(`目标: ${target.filename} (${target.configLabel})`);
  const res = await request('POST', '/api/admin/cultivation/rollback', token, {
    filename: target.filename
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 200) {
    console.log(`✓ 消息: ${res.body?.message}`);
    console.log(`✓ 配置类型: ${res.body?.data?.configType}`);
    console.log(`✓ 回滚前备份: ${res.body?.data?.preRollbackBackup}`);
  } else {
    throw new Error(`回滚失败: ${JSON.stringify(res.body)}`);
  }
  // 验证回滚链：回滚后应该多出一个新备份
  const afterRes = await request('GET', '/api/admin/cultivation/backups', token);
  if (afterRes.status === 200) {
    const newCount = afterRes.body.data.length;
    console.log(`✓ 回滚后备份总数: ${newCount}（回滚前 ${backups.length}，应多 1）`);
    if (newCount <= backups.length) {
      throw new Error('回滚链未形成：备份数量未增加');
    }
  }
}

/**
 * 测试 4: 路径穿越攻击防护
 */
async function testPathTraversal(token) {
  console.log('\n========== 测试 4: 路径穿越攻击防护（应失败） ==========');
  const maliciousNames = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\win.ini',
    'seclusion_../../etc/passwd',
    'seclusion_../../../config/seclusion.json'
  ];
  for (const name of maliciousNames) {
    const res = await request('POST', '/api/admin/cultivation/rollback', token, { filename: name });
    if (res.status === 400) {
      console.log(`✓ 拒绝恶意文件名: ${name}`);
    } else {
      throw new Error(`路径穿越防护失败: ${name} 返回 ${res.status}`);
    }
  }
}

/**
 * 测试 5: 不存在的备份文件
 */
async function testNonExistent(token) {
  console.log('\n========== 测试 5: 不存在的备份文件（应 404） ==========');
  const res = await request('POST', '/api/admin/cultivation/rollback', token, {
    filename: 'seclusion_2099-01-01T00-00-00-000Z.json'
  });
  console.log(`状态码: ${res.status}`);
  if (res.status === 404) {
    console.log(`✓ 正确返回 404: ${res.body?.message}`);
  } else {
    throw new Error('不存在的文件未返回 404');
  }
}

/**
 * 测试 6: 未授权访问
 */
async function testUnauthorized() {
  console.log('\n========== 测试 6: 未授权访问 backups（应 401） ==========');
  const res = await request('GET', '/api/admin/cultivation/backups', null);
  if (res.status === 401) {
    console.log(`✓ 正确拒绝未授权访问`);
  } else {
    throw new Error('未授权访问未被拒绝');
  }
}

/**
 * 测试 7: status 接口返回 cooldown_remaining
 */
async function testStatusCooldownRemaining(token) {
  console.log('\n========== 测试 7: status 接口返回 cooldown_remaining ==========');
  const res = await request('GET', '/api/seclusion/status', token);
  if (res.status === 200) {
    const d = res.body?.data;
    if (d?.normal_cooldown_remaining !== undefined && d?.deep_cooldown_remaining !== undefined && d?.server_time !== undefined) {
      console.log(`✓ normal_cooldown_remaining: ${d.normal_cooldown_remaining} 秒`);
      console.log(`✓ deep_cooldown_remaining: ${d.deep_cooldown_remaining} 秒`);
      console.log(`✓ server_time: ${d.server_time}`);
    } else {
      throw new Error('status 接口未返回 cooldown_remaining 或 server_time 字段');
    }
  } else {
    throw new Error(`status 接口请求失败: ${res.status}`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   修炼配置管理接口测试 V2（含历史版本与回滚）- 开始        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  const token = await login();
  await testUnauthorized();
  const allBackups = await testGetAllBackups(token);
  await testFilterBackups(token, 'seclusion');
  await testFilterBackups(token, 'game_balance');
  await testRollback(token, allBackups);
  await testPathTraversal(token);
  await testNonExistent(token);
  await testStatusCooldownRemaining(token);
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   全部测试通过 ✓                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n测试失败:', err.message);
  process.exit(1);
});
