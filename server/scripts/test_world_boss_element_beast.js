/**
 * 世界BOSS 灵兽助战 + 五行相克 验证脚本
 *
 * 验证目标：
 *   1. 灵兽助战：玩家攻击BOSS时，灵兽ATK加成提升伤害，并有独立 beast_assist_damage
 *   2. 五行相克：灵兽元素 vs BOSS元素影响伤害系数（1.5x/0.75x/1.0x）
 *   3. BOSS反击相克：BOSS元素 vs 灵兽元素影响反击伤害
 *
 * 前置条件：
 *   - 服务运行在 http://localhost:5000
 *   - 测试账号 1592363624 / 1592363624
 *   - 玩家已有出战灵兽（青云狼, element=metal, star=1, level=1）
 *   - 通过 GM 接口手动生成 BOSS（boss_key=qingyuanzi, element=metal）
 *
 * 元素相克预期（玩家灵兽=metal(金) vs BOSS=metal(金)）：
 *   - 玩家→BOSS: 同元素 → 1.0x（中性）
 *   - BOSS→玩家: 同元素 → 1.0x（中性）
 *
 * 后续可手动测试不同元素：
 *   - 改为 fire 灵兽 vs metal BOSS → 玩家→BOSS: 1.5x（火克金），BOSS→玩家: 0.75x
 *   - 改为 wood 灵兽 vs metal BOSS → 玩家→BOSS: 0.75x（金克木），BOSS→玩家: 1.5x
 */
'use strict';

const BASE = 'http://localhost:5000/api';

async function main() {
    console.log('=== 世界BOSS 灵兽助战 + 五行相克 验证 ===\n');

    // 1. 登录
    const loginResp = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '1592363624', password: '1592363624' })
    });
    const loginData = await loginResp.json();
    const token = loginData.token;
    const headers = { 'Authorization': `Bearer ${token}` };
    console.log('1. 登录成功, 玩家:', loginData.player?.nickname || '韩天尊');

    // 2. 查询当前玩家灵兽出战状态
    console.log('\n2. 查询灵兽出战状态 (GET /api/spirit-beast/list)');
    const beastListResp = await fetch(`${BASE}/spirit-beast/list`, { headers });
    const beastListData = await beastListResp.json();
    const beasts = beastListData.data?.beasts || [];
    const activeBeast = beasts.find(b => b.is_active);
    if (activeBeast) {
        console.log('   ✅ 出战灵兽:', activeBeast.beast_name || activeBeast.beast_key,
            '| element:', activeBeast.element,
            '| star:', activeBeast.star_level,
            '| level:', activeBeast.level);
    } else {
        console.log('   ⚠️ 无出战灵兽，将仅验证中性相克场景');
    }

    // 3. 查询当前可用BOSS列表
    console.log('\n3. 查询BOSS列表 (GET /api/world-boss/bosses)');
    const bossListResp = await fetch(`${BASE}/world-boss/bosses`, { headers });
    const bossListData = await bossListResp.json();
    const bosses = bossListData.data?.bosses || [];
    console.log('   可用BOSS数量:', bosses.length);
    let activeBoss = bosses.find(b => b.status === 'active' || b.status === 'pending');
    if (activeBoss) {
        console.log('   ✅ 找到 active/pending 状态的BOSS:', activeBoss.boss_name, 'id:', activeBoss.id);
    } else {
        console.log('   ⚠️ 无 active/pending BOSS，需要GM手动生成');
        console.log('   尝试调用 GM 接口生成 BOSS...');
        const spawnResp = await fetch(`${BASE}/admin/world-boss/spawn`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ boss_key: 'qingyuanzi', custom_hp: 1000000 })
        });
        const spawnData = await spawnResp.json();
        if (spawnData.code === 200) {
            activeBoss = spawnData.data;
            console.log('   ✅ GM生成BOSS成功:', activeBoss.boss_name, 'id:', activeBoss.boss_id || activeBoss.id);
        } else {
            console.log('   ❌ GM生成BOSS失败:', spawnData.message);
            console.log('   提示：测试账号需要 admin 权限');
            return;
        }
    }
    const bossId = activeBoss.id || activeBoss.boss_id;

    // 4. 攻击BOSS（验证灵兽助战和五行相克）
    console.log('\n4. 攻击BOSS (POST /api/world-boss/:bossId/attack)');
    const attackResp = await fetch(`${BASE}/world-boss/${bossId}/attack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: 'basic' })
    });
    const attackData = await attackResp.json();

    if (attackData.code !== 200) {
        console.log('   ❌ 攻击失败:', attackData.message);
        console.log('   完整响应:', JSON.stringify(attackData, null, 2));
        return;
    }

    const atk = attackData.data?.attack;
    const counter = attackData.data?.counter;
    const elemental = attackData.data?.elemental_counter;
    const spiritBeast = attackData.data?.spirit_beast;

    console.log('   攻击伤害 atk.damage:', atk?.damage);
    console.log('   灵兽助战伤害 beast_assist_damage:', atk?.damage_breakdown?.beast_assist_damage);
    console.log('   灵兽ATK加成 beast_atk_bonus:', atk?.damage_breakdown?.beast_atk_bonus);
    console.log('   BOSS反击伤害 counter.damage:', counter?.damage);
    console.log('   BOSS→玩家相克系数 counter.elemental_factor:', counter?.elemental_factor);

    console.log('\n   五行相克信息:');
    console.log('   玩家灵兽元素:', elemental?.player_beast_element);
    console.log('   BOSS元素:', elemental?.boss_element);
    console.log('   玩家→BOSS:', elemental?.player_to_boss?.description, '系数:', elemental?.player_to_boss?.factor);
    console.log('   BOSS→玩家:', elemental?.boss_to_player?.description, '系数:', elemental?.boss_to_player?.factor);

    console.log('\n   灵兽信息:', spiritBeast ? JSON.stringify(spiritBeast) : 'null');

    // 5. 验证
    console.log('\n5. 验证结果:');
    let allPass = true;

    if (atk?.damage_breakdown?.beast_assist_damage !== undefined) {
        console.log('   ✅ 返回字段包含 beast_assist_damage');
    } else {
        console.log('   ❌ 返回字段缺失 beast_assist_damage');
        allPass = false;
    }

    if (elemental?.player_to_boss?.factor !== undefined) {
        console.log('   ✅ 返回字段包含 elemental_counter.player_to_boss.factor');
    } else {
        console.log('   ❌ 返回字段缺失 elemental_counter.player_to_boss.factor');
        allPass = false;
    }

    if (spiritBeast) {
        console.log('   ✅ 返回字段包含 spirit_beast 助战信息');
    } else {
        console.log('   ⚠️ 无灵兽助战信息（可能未出战灵兽）');
    }

    // 验证元素相克方向
    if (activeBeast && elemental?.boss_element) {
        const playerEl = activeBeast.element;
        const bossEl = elemental.boss_element;
        const counterMatrix = { metal: 'wood', wood: 'earth', earth: 'water', water: 'fire', fire: 'metal' };
        let expectedFactor = 1.0;
        let expectedTag = 'neutral';
        if (playerEl === bossEl) {
            expectedFactor = 1.0;
            expectedTag = 'neutral';
        } else if (counterMatrix[playerEl] === bossEl) {
            expectedFactor = 1.5;
            expectedTag = 'advantage';
        } else if (counterMatrix[bossEl] === playerEl) {
            expectedFactor = 0.75;
            expectedTag = 'disadvantage';
        }
        const actualFactor = elemental.player_to_boss.factor;
        const actualTag = elemental.player_to_boss.tag;
        if (Math.abs(actualFactor - expectedFactor) < 0.001 && actualTag === expectedTag) {
            console.log(`   ✅ 五行相克方向正确：玩家(${playerEl}) vs BOSS(${bossEl}) → ${expectedTag}(${expectedFactor}x)`);
        } else {
            console.log(`   ❌ 五行相克方向错误：预期 ${expectedTag}(${expectedFactor}x)，实际 ${actualTag}(${actualFactor}x)`);
            allPass = false;
        }
    }

    if (allPass) {
        console.log('\n=== ✅ 全部验证通过 ===');
    } else {
        console.log('\n=== ⚠️ 部分验证失败，请检查上述日志 ===');
    }
}

main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
