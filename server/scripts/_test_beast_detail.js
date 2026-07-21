/**
 * 妖兽入侵详情接口结构探查
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
    const headers = { 'Authorization': `Bearer ${token}` };

    // 获取活跃妖兽
    const aRes = await fetch(`${BASE_URL}/beast-invasion/active`, { headers });
    const aJson = await aRes.json();
    console.log('=== /active 返回 ===');
    console.log(JSON.stringify(aJson, null, 2).slice(0, 2500));

    if (aJson?.data?.id) {
        const dRes = await fetch(`${BASE_URL}/beast-invasion/${aJson.data.id}`, { headers });
        const dJson = await dRes.json();
        console.log('\n=== /:invasionId 详情返回 ===');
        console.log(JSON.stringify(dJson, null, 2).slice(0, 3000));
    }
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
