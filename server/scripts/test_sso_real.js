const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '../.env' });

// 模拟配置
const API_URL = 'http://localhost:3000/api';
const USERNAME = 'test_sso_user_' + Date.now();
const PASSWORD = 'password123';

async function testSSO() {
  try {
    console.log('--- 开始 SSO 互踢测试 ---');

    // 1. 注册测试用户
    console.log('1. 注册用户...');
    try {
        await axios.post(`${API_URL}/auth/register`, {
            username: USERNAME,
            password: PASSWORD,
            nickname: 'SSO测试员'
        });
    } catch (e) {
        // 如果已存在则忽略
    }

    // 2. 第一次登录 (模拟设备 A)
    console.log('2. 设备 A 登录...');
    const loginA = await axios.post(`${API_URL}/auth/login`, { username: USERNAME, password: PASSWORD });
    const tokenA = loginA.data.token;
    const decodedA = jwt.decode(tokenA);
    console.log(`   设备 A Token Version: ${decodedA.v}`);

    // 验证设备 A Token 可用
    console.log('   验证设备 A Token 有效性...');
    await axios.get(`${API_URL}/player/me`, { headers: { Authorization: `Bearer ${tokenA}` } });
    console.log('   设备 A 访问成功 (预期内)');

    // 3. 第二次登录 (模拟设备 B)
    console.log('3. 设备 B 登录 (同一账号)...');
    const loginB = await axios.post(`${API_URL}/auth/login`, { username: USERNAME, password: PASSWORD });
    const tokenB = loginB.data.token;
    const decodedB = jwt.decode(tokenB);
    console.log(`   设备 B Token Version: ${decodedB.v}`);

    if (decodedB.v <= decodedA.v) {
        console.error('ERROR: 版本号未增加！数据库更新失败？');
        process.exit(1);
    }

    // 4. 再次使用设备 A 的 Token 访问 (预期应该失败)
    console.log('4. 设备 A 尝试再次访问 (预期应被踢)...');
    try {
        await axios.get(`${API_URL}/player/me`, { headers: { Authorization: `Bearer ${tokenA}` } });
        console.error('FAIL: 设备 A 仍然可以访问！互踢失效！');
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.log('SUCCESS: 设备 A 访问被拒绝 (401)，互踢生效。');
            console.log('错误信息:', error.response.data);
        } else {
            console.error('FAIL: 收到非 401 错误:', error.message);
        }
    }

    // 5. 验证设备 B Token 可用
    console.log('5. 验证设备 B Token 有效性...');
    await axios.get(`${API_URL}/player/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
    console.log('   设备 B 访问成功 (预期内)');

    console.log('--- 测试结束 ---');
  } catch (error) {
    console.error('测试过程发生异常:', error.message);
    if (error.response) console.error('Response:', error.response.data);
  }
}

testSSO();
