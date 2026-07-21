/**
 * 五行相克单元测试：直接调用 WorldBossService._calculateElementalCounter 验证所有元素组合
 *
 * 验证目标：
 *   1. 金克木、木克土、土克水、水克火、火克金 → 1.5x (advantage)
 *   2. 反方向 → 0.75x (disadvantage)
 *   3. 同元素、null元素 → 1.0x (neutral)
 *   4. 非五行元素（如 'light'/'dark'）→ 1.0x (neutral)
 */
'use strict';

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const WorldBossService = require('../game/services/WorldBossService');

// 测试用配置（与 game_balance.json 一致）
const testCfg = {
    elemental_counter: {
        advantage_multiplier: 1.5,
        disadvantage_multiplier: 0.75,
        neutral_multiplier: 1.0,
        counter_matrix: {
            metal: 'wood',
            wood: 'earth',
            earth: 'water',
            water: 'fire',
            fire: 'metal'
        }
    }
};

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        console.log(`     预期: ${JSON.stringify(expected)}`);
        console.log(`     实际: ${JSON.stringify(actual)}`);
        failed++;
    }
}

console.log('=== 五行相克单元测试 ===\n');

// 1. 五行相克正向（金克木、木克土、土克水、水克火、火克金）
console.log('1. 五行相克正向（应得 advantage / 1.5x）:');
const advantages = [
    ['metal', 'wood', '金克木'],
    ['wood', 'earth', '木克土'],
    ['earth', 'water', '土克水'],
    ['water', 'fire', '水克火'],
    ['fire', 'metal', '火克金']
];
for (const [atk, def, name] of advantages) {
    const result = WorldBossService._calculateElementalCounter(atk, def, testCfg);
    assert(`${name}(${atk}→${def})`, { factor: result.factor, tag: result.tag },
        { factor: 1.5, tag: 'advantage' });
}

// 2. 五行相克反向（应得 disadvantage / 0.75x）
console.log('\n2. 五行相克反向（应得 disadvantage / 0.75x）:');
const disadvantages = [
    ['wood', 'metal', '木被金克'],
    ['earth', 'wood', '土被木克'],
    ['water', 'earth', '水被土克'],
    ['fire', 'water', '火被水克'],
    ['metal', 'fire', '金被火克']
];
for (const [atk, def, name] of disadvantages) {
    const result = WorldBossService._calculateElementalCounter(atk, def, testCfg);
    assert(`${name}(${atk}→${def})`, { factor: result.factor, tag: result.tag },
        { factor: 0.75, tag: 'disadvantage' });
}

// 3. 同元素（应得 neutral / 1.0x）
console.log('\n3. 同元素（应得 neutral / 1.0x）:');
for (const el of ['metal', 'wood', 'earth', 'water', 'fire']) {
    const result = WorldBossService._calculateElementalCounter(el, el, testCfg);
    assert(`同元素 ${el}→${el}`, { factor: result.factor, tag: result.tag },
        { factor: 1.0, tag: 'neutral' });
}

// 4. 无灵兽（null）元素
console.log('\n4. 灵兽无元素（attacker=null 或 defender=null，应得 neutral / 1.0x）:');
const nullCases = [
    [null, 'metal', '玩家无灵兽 vs 金属BOSS'],
    ['metal', null, '金属灵兽 vs BOSS无元素'],
    [null, null, '双方均无元素']
];
for (const [atk, def, name] of nullCases) {
    const result = WorldBossService._calculateElementalCounter(atk, def, testCfg);
    assert(name, { factor: result.factor, tag: result.tag },
        { factor: 1.0, tag: 'neutral' });
}

// 5. 非五行元素（light/dark/void）
console.log('\n5. 非五行元素（light/dark，应得 neutral / 1.0x）:');
const exoticCases = [
    ['light', 'metal', '光灵兽 vs 金属BOSS'],
    ['dark', 'fire', '暗灵兽 vs 火BOSS'],
    ['metal', 'light', '金属灵兽 vs 光BOSS']
];
for (const [atk, def, name] of exoticCases) {
    const result = WorldBossService._calculateElementalCounter(atk, def, testCfg);
    assert(name, { factor: result.factor, tag: result.tag },
        { factor: 1.0, tag: 'neutral' });
}

// 6. 描述字段验证（中文展示）
console.log('\n6. 中文描述字段验证:');
const descTests = [
    ['metal', 'wood', '金克木（伤害+50%）'],
    ['wood', 'metal', '金克木（伤害-25%）'],
    ['metal', 'metal', '同元素（中性）'],
    [null, 'metal', '无相克（中性）']
];
for (const [atk, def, expectedDesc] of descTests) {
    const result = WorldBossService._calculateElementalCounter(atk, def, testCfg);
    assert(`描述: ${atk}→${def} 应为 "${expectedDesc}"`,
        result.description, expectedDesc);
}

console.log(`\n=== 测试结果 ===`);
console.log(`通过: ${passed}, 失败: ${failed}, 总计: ${passed + failed}`);
if (failed === 0) {
    console.log('✅ 全部通过');
    process.exit(0);
} else {
    console.log('❌ 有失败用例');
    process.exit(1);
}
