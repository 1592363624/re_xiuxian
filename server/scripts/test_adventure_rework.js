/**
 * 历练系统重构验证测试脚本
 * 测试 short/medium/long 三档时长分级与提前结束惩罚
 */
const http = require('http');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiIxNTkyMzYzNjI0IiwidiI6MTQyLCJpYXQiOjE3ODMwNTc3MzIsImV4cCI6MTc4MzY2MjUzMn0.8mibcoc7mZxaM_v8fh7jhW3wPFkPZxhlmBAD87XSaIw';

/**
 * 发送 HTTP 请求
 */
function request(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKEN
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 主测试流程
 */
async function main() {
  console.log('===== 1. 开始短时历练（short, 30秒, 0.6x奖励, 0%受伤）=====');
  let r = await request('/api/map/explore/start', 'POST', { durationType: 'short' });
  console.log('Status:', r.status);
  console.log('Body:', r.body);
  console.log('');

  if (r.status === 200) {
    console.log('===== 2. 立即结束短时历练（提前结束, 应按比例×50%结算）=====');
    r = await request('/api/map/explore/complete', 'POST', null);
    console.log('Status:', r.status);
    console.log('Body:', r.body);
    console.log('');
  }

  console.log('===== 3. 开始中时历练（medium, 90秒, 1.0x奖励, 5%受伤）=====');
  r = await request('/api/map/explore/start', 'POST', { durationType: 'medium' });
  console.log('Status:', r.status);
  console.log('Body:', r.body);
  console.log('');

  if (r.status === 200) {
    console.log('===== 4. 立即结束中时历练 =====');
    r = await request('/api/map/explore/complete', 'POST', null);
    console.log('Status:', r.status);
    console.log('Body:', r.body);
    console.log('');
  }

  console.log('===== 5. 开始长时历练（long, 300秒, 1.8x奖励, 10%受伤）=====');
  r = await request('/api/map/explore/start', 'POST', { durationType: 'long' });
  console.log('Status:', r.status);
  console.log('Body:', r.body);
  console.log('');

  if (r.status === 200) {
    console.log('===== 6. 立即结束长时历练 =====');
    r = await request('/api/map/explore/complete', 'POST', null);
    console.log('Status:', r.status);
    console.log('Body:', r.body);
    console.log('');
  }

  console.log('===== 7. 验证错误时长类型（应降级到 medium）=====');
  r = await request('/api/map/explore/start', 'POST', { durationType: 'invalid_type' });
  console.log('Status:', r.status);
  console.log('Body:', r.body);
  console.log('');

  if (r.status === 200) {
    console.log('===== 8. 结束历练 =====');
    r = await request('/api/map/explore/complete', 'POST', null);
    console.log('Status:', r.status);
    console.log('Body:', r.body);
  }

  console.log('\n===== 测试完成 =====');
}

main().catch(e => console.error('测试异常:', e));
