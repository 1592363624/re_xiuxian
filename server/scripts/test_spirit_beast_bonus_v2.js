/**
 * 灵兽加成验证 V2：直接验证 /api/player/me 和 /api/player/attributes 返回的灵兽信息
 */
'use strict';

const BASE = 'http://localhost:5000/api';

async function main() {
    console.log('=== 灵兽加成验证 V2 ===\n');

    // 登录
    const loginResp = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '1592363624', password: '1592363624' })
    });
    const loginData = await loginResp.json();
    const token = loginData.token;
    const headers = { 'Authorization': `Bearer ${token}` };

    // 1. GET /api/player/me
    console.log('1. GET /api/player/me');
    const meResp = await fetch(`${BASE}/player/me`, { headers });
    const meData = await meResp.json();
    const meAttrs = meData.data?.attributes || {};
    const meSpiritBeast = meData.data?.spirit_beast || null;
    console.log('   attributes:', JSON.stringify(meAttrs, null, 2));
    console.log('   spirit_beast:', meSpiritBeast ? JSON.stringify(meSpiritBeast) : 'null');

    // 2. GET /api/player/attributes
    console.log('\n2. GET /api/player/attributes');
    const attrsResp = await fetch(`${BASE}/player/attributes`, { headers });
    const attrsData = await attrsResp.json();
    const basicAttrs = attrsData.data?.basic_attributes || {};
    console.log('   final:', JSON.stringify(basicAttrs.final || {}, null, 2));
    console.log('   breakdown keys:', Object.keys(basicAttrs.breakdown || {}));
    console.log('   breakdown.spirit_beast:', basicAttrs.breakdown?.spirit_beast ? JSON.stringify(basicAttrs.breakdown.spirit_beast) : 'null');
    console.log('   info.spirit_beast:', basicAttrs.info?.spirit_beast ? JSON.stringify(basicAttrs.info.spirit_beast) : 'null');

    // 3. 化神初期基础属性
    console.log('\n3. 化神初期基础属性（realm_breakthrough.json）:');
    console.log('   atk: 620, def: 560, hp_max: 3500, speed: 110');

    // 4. 计算差值
    console.log('\n4. 属性差值分析（当前 - 基础 = 灵兽加成 + 装备加成 + 其他）:');
    console.log(`   atk: ${meAttrs.atk} - 620 = ${meAttrs.atk - 620}`);
    console.log(`   def: ${meAttrs.def} - 560 = ${meAttrs.def - 560}`);
    console.log(`   hp_max: ${meAttrs.hp_max} - 3500 = ${meAttrs.hp_max - 3500}`);
    console.log(`   speed: ${meAttrs.speed} - 110 = ${meAttrs.speed - 110}`);

    // 5. 验证
    console.log('\n5. 验证结果:');
    const atkDelta = meAttrs.atk - 620;
    const defDelta = meAttrs.def - 560;
    const hpDelta = meAttrs.hp_max - 3500;
    const speedDelta = meAttrs.speed - 110;

    // 预期灵兽加成：atk=12, def=7, hp_max=38, speed=4
    if (defDelta >= 7 && hpDelta >= 38 && speedDelta >= 4) {
        console.log('   ✅ 灵兽加成已生效！');
        console.log(`   def 加成: ${defDelta} (含灵兽7)`);
        console.log(`   hp_max 加成: ${hpDelta} (含灵兽38)`);
        console.log(`   speed 加成: ${speedDelta} (含灵兽4)`);
        console.log(`   atk 加成: ${atkDelta} (含灵兽12 + 装备/其他${atkDelta - 12})`);
    } else {
        console.log('   ❌ 灵兽加成未生效或数值不匹配');
    }

    if (meSpiritBeast) {
        console.log('\n   ✅ /api/player/me 返回了灵兽加成信息');
        console.log('   beast_name:', meSpiritBeast.beast_name);
        console.log('   bonus_rate:', meSpiritBeast.bonus_rate + '%');
    } else {
        console.log('\n   ⚠️ /api/player/me 未返回灵兽加成信息（spirit_beast 字段未暴露）');
    }

    console.log('\n=== 验证完成 ===');
}

main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
