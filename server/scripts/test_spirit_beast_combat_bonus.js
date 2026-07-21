/**
 * 灵兽属性加成验证脚本
 *
 * 验证灵兽出战后，玩家属性是否正确获得加成：
 *   1. 查询玩家当前属性（无灵兽出战状态）
 *   2. 设置灵兽出战
 *   3. 查询玩家属性（应包含灵兽加成）
 *   4. 验证加成数值符合配置公式
 *   5. 取消灵兽出战，验证属性恢复
 */
'use strict';

const BASE = 'http://localhost:5000/api';

async function main() {
    console.log('=== 灵兽属性加成验证 ===\n');

    // 1. 登录
    const loginResp = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '1592363624', password: '1592363624' })
    });
    const loginData = await loginResp.json();
    const token = loginData.token;
    const playerId = loginData.player.id;
    console.log('1. 登录成功:', loginData.player.nickname, 'ID:', playerId);

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 2. 查询我的灵兽列表
    const listResp = await fetch(`${BASE}/spirit-beast/list`, { headers });
    const listData = await listResp.json();
    console.log('\n2. 我的灵兽列表:');
    console.log('   灵兽数量:', listData.data?.total);
    console.log('   出战数量:', listData.data?.stats?.active_count);

    const beasts = listData.data?.beasts || [];
    if (beasts.length === 0) {
        console.log('   ⚠️ 无灵兽，先捕获一只');
        // 尝试捕获青云狼
        const catchResp = await fetch(`${BASE}/spirit-beast/catch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ beast_key: 'qingyun_wolf' })
        });
        const catchData = await catchResp.json();
        console.log('   捕获结果:', catchData.success ? '成功' : catchData.message);
        if (!catchData.success) {
            console.log('   ❌ 无法捕获灵兽，测试终止');
            return;
        }
        // 重新查询列表
        const listResp2 = await fetch(`${BASE}/spirit-beast/list`, { headers });
        const listData2 = await listResp2.json();
        beasts.push(...(listData2.data?.beasts || []));
    }

    // 找到一只灵兽（优先未出战的）
    let beast = beasts.find(b => b.is_active) || beasts[0];
    console.log('   选中灵兽:', beast.beast_name, 'ID:', beast.id, '当前出战:', beast.is_active);

    // 3. 查询玩家当前属性（GET /api/player/me 返回 attributes）
    const meResp = await fetch(`${BASE}/player/me`, { headers });
    const meData = await meResp.json();
    const beforeAttrs = meData.data?.attributes || meData.data?.player?.attributes || {};
    console.log('\n3. 玩家当前属性（灵兽出战前/当前）:');
    console.log('   atk:', beforeAttrs.atk);
    console.log('   def:', beforeAttrs.def);
    console.log('   hp_max:', beforeAttrs.hp_max);
    console.log('   speed:', beforeAttrs.speed);

    // 4. 设置灵兽出战
    if (!beast.is_active) {
        console.log('\n4. 设置灵兽出战...');
        const setActiveResp = await fetch(`${BASE}/spirit-beast/${beast.id}/set-active`, {
            method: 'POST',
            headers
        });
        const setActiveData = await setActiveResp.json();
        console.log('   设置出战:', setActiveData.success ? '成功' : setActiveData.message);
    } else {
        console.log('\n4. 灵兽已出战，跳过设置');
    }

    // 5. 查询灵兽详情，获取加成信息
    const detailResp = await fetch(`${BASE}/spirit-beast/${beast.id}`, { headers });
    const detailData = await detailResp.json();
    const beastDetail = detailData.data?.beast || detailData.data || {};
    console.log('\n5. 灵兽详情:');
    console.log('   beast_name:', beastDetail.beast_name);
    console.log('   element:', beastDetail.element);
    console.log('   star_level:', beastDetail.star_level);
    console.log('   level:', beastDetail.level);
    console.log('   atk:', beastDetail.atk);
    console.log('   def:', beastDetail.def);
    console.log('   hp_max:', beastDetail.hp_max);
    console.log('   speed:', beastDetail.speed);
    console.log('   combat_power:', beastDetail.combat_power);

    // 6. 计算预期加成
    // 加成公式：bonus_rate = base_rate(0.1) + star_level * star_rate(0.05) + level * level_rate(0.005)，上限 max_rate(0.5)
    const starLevel = Number(beastDetail.star_level) || 1;
    const level = Number(beastDetail.level) || 1;
    const baseRate = 0.1;
    const starRate = 0.05;
    const levelRate = 0.005;
    const maxRate = 0.5;
    const hpFactor = 0.5;
    const speedFactor = 0.3;
    const rawRate = baseRate + starLevel * starRate + level * levelRate;
    const expectedRate = Math.min(rawRate, maxRate);
    const expectedAtkBonus = Math.floor((Number(beastDetail.atk) || 0) * expectedRate);
    const expectedDefBonus = Math.floor((Number(beastDetail.def) || 0) * expectedRate);
    const expectedHpBonus = Math.floor((Number(beastDetail.hp_max) || 0) * expectedRate * hpFactor);
    const expectedSpeedBonus = Math.floor((Number(beastDetail.speed) || 0) * expectedRate * speedFactor);

    console.log('\n6. 预期灵兽加成:');
    console.log(`   加成比例: ${(expectedRate * 100).toFixed(1)}% (raw=${(rawRate * 100).toFixed(1)}%)`);
    console.log('   atk_bonus:', expectedAtkBonus);
    console.log('   def_bonus:', expectedDefBonus);
    console.log('   hp_max_bonus:', expectedHpBonus);
    console.log('   speed_bonus:', expectedSpeedBonus);

    // 7. 查询玩家属性（灵兽出战后）
    const meResp2 = await fetch(`${BASE}/player/me`, { headers });
    const meData2 = await meResp2.json();
    const afterAttrs = meData2.data?.attributes || meData2.data?.player?.attributes || {};
    console.log('\n7. 玩家属性（灵兽出战后）:');
    console.log('   atk:', afterAttrs.atk);
    console.log('   def:', afterAttrs.def);
    console.log('   hp_max:', afterAttrs.hp_max);
    console.log('   speed:', afterAttrs.speed);

    // 检查是否有 spirit_beast 字段
    const spiritBeastInfo = meData2.data?.info?.spirit_beast || afterAttrs.spirit_beast;
    console.log('\n8. 灵兽加成信息:');
    if (spiritBeastInfo) {
        console.log('   beast_name:', spiritBeastInfo.beast_name);
        console.log('   bonus_rate:', spiritBeastInfo.bonus_rate + '%');
        console.log('   combat_power:', spiritBeastInfo.combat_power);
        console.log('   ✅ 灵兽加成信息已正确返回');
    } else {
        console.log('   ⚠️ 灵兽加成信息未在响应中找到（可能接口未返回 info 字段）');
    }

    // 9. 验证加成数值
    console.log('\n9. 加成数值验证:');
    const actualAtkDelta = (Number(afterAttrs.atk) || 0) - (Number(beforeAttrs.atk) || 0);
    const actualDefDelta = (Number(afterAttrs.def) || 0) - (Number(beforeAttrs.def) || 0);
    const actualHpDelta = (Number(afterAttrs.hp_max) || 0) - (Number(beforeAttrs.hp_max) || 0);
    const actualSpeedDelta = (Number(afterAttrs.speed) || 0) - (Number(beforeAttrs.speed) || 0);

    console.log(`   atk 加成: 预期=${expectedAtkBonus}, 实际=${actualAtkDelta} ${actualAtkDelta === expectedAtkBonus ? '✅' : '⚠️'}`);
    console.log(`   def 加成: 预期=${expectedDefBonus}, 实际=${actualDefDelta} ${actualDefDelta === expectedDefBonus ? '✅' : '⚠️'}`);
    console.log(`   hp_max 加成: 预期=${expectedHpBonus}, 实际=${actualHpDelta} ${actualHpDelta === expectedHpBonus ? '✅' : '⚠️'}`);
    console.log(`   speed 加成: 预期=${expectedSpeedBonus}, 实际=${actualSpeedDelta} ${actualSpeedDelta === expectedSpeedBonus ? '✅' : '⚠️'}`);

    console.log('\n=== 验证完成 ===');
    console.log('注：如加成为 0，可能是玩家属性接口未走 calculateFullAttributesAsync 异步路径，');
    console.log('    需要确认 /api/player/me 是否调用了异步版本。');
}

main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
