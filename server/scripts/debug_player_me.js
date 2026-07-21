/**
 * 临时调试脚本：查看 /api/player/me 完整响应结构
 */
'use strict';

const BASE_URL = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

async function main() {
    // 登录
    const loginResp = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD })
    });
    const loginData = await loginResp.json();
    console.log('登录响应:', JSON.stringify(loginData, null, 2).substring(0, 500));

    const token = loginData.token;

    // 调用 /api/player/me
    const meResp = await fetch(`${BASE_URL}/api/player/me`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const meData = await meResp.json();
    console.log('\n/api/player/me 完整响应:');
    console.log(JSON.stringify(meData, null, 2));

    // 检查 is_dead 字段位置
    console.log('\n字段检查:');
    console.log('  顶层 is_dead:', meData.is_dead);
    console.log('  data.is_dead:', meData.data?.is_dead);
    console.log('  player.is_dead:', meData.player?.is_dead);
    console.log('  顶层 death_reason:', meData.death_reason);
    console.log('  data.death_reason:', meData.data?.death_reason);
}

main().catch(console.error);
