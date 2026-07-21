/**
 * 妖兽入侵攻击接口返回结构探查
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function main() {
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const loginJson = await loginRes.json();
    const token = loginJson?.data?.token || loginJson?.token;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 先查询活跃妖兽
    const aRes = await fetch(`${BASE_URL}/beast-invasion/active`, { headers });
    const aJson = await aRes.json();
    const invasionId = aJson?.data?.id;
    if (!invasionId) { console.error('无活跃妖兽入侵'); process.exit(1); }

    // 攻击一次看完整返回结构
    const atkRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/attack`, {
        method: 'POST', headers,
        body: JSON.stringify({})
    });
    const atkJson = await atkRes.json();
    console.log('=== attack 接口完整返回 ===');
    console.log(JSON.stringify(atkJson, null, 2));
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
