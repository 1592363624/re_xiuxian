/**
 * PVP 结算字段一致性测试
 *
 * 目标：
 *   验证后端 PvpService._settleBattle 返回的 settle 字段
 *   是否与前端 PvpPanel.vue 的 buildPvpSettleLog 读取的字段一致。
 *
 * 测试策略：
 *   1. 读取后端 PvpService._settleBattle 源代码，确认返回字段
 *   2. 模拟 settle 对象（包含所有字段）
 *   3. 复制前端 buildPvpSettleLog 逻辑，验证字段读取是否正确
 *   4. 覆盖胜方/败方/平局三种场景
 *
 * 修复的 bug：
 *   - B4-Reward-1: handleAction 读取 data?.is_finished（应为 battle_ended），导致战斗结束后不刷新排行榜
 *   - B4-Reward-2: handleAction 不展示结算奖励
 *   - B4-Reward-3: confirmFlee 不展示逃跑结算（败方保底）
 *   - B4-Reward-4: buildPvpSettleLog 字段读取逻辑不严谨
 */
const fs = require('fs');
const path = require('path');

// 测试统计
let passCount = 0;
let failCount = 0;
const failures = [];

/**
 * 断言函数
 * @param {boolean} condition - 条件
 * @param {string} message - 失败消息
 */
function assert(condition, message) {
    if (condition) {
        passCount++;
        console.log(`  ✅ ${message}`);
    } else {
        failCount++;
        failures.push(message);
        console.log(`  ❌ ${message}`);
    }
}

/**
 * 复制前端 buildPvpSettleLog 逻辑（与 PvpPanel.vue 保持一致）
 * 用于验证字段读取正确性
 */
function buildPvpSettleLog(settle, myPlayerId) {
    if (!settle) return '斗法结束';
    const isDraw = settle.is_draw === true;
    const isWinner = !isDraw && settle.winner_id === myPlayerId;
    const isLoser = !isDraw && settle.loser_id === myPlayerId;

    const myHonor = isLoser ? 0
        : (Number(settle.attacker_honor_gain) || Number(settle.defender_honor_gain) || 0);
    const myExp = isLoser
        ? (Number(settle.loser_consolation_exp) || 0)
        : (Number(settle.attacker_exp_gain) || Number(settle.defender_exp_gain) || 0);
    const myStones = isWinner
        ? (Number(settle.spirit_stone_reward) || 0)
        : (isLoser ? (Number(settle.loser_consolation_stone) || 0) : 0);
    const dropKey = settle.drop_item_key;
    const dropQty = Number(settle.drop_item_quantity) || 0;

    let resultText;
    if (isDraw) {
        resultText = '斗法平局';
    } else if (isWinner) {
        resultText = '斗法胜利';
    } else {
        resultText = '斗法落败';
    }

    const parts = [resultText];
    if (myHonor > 0) parts.push(`荣誉 +${myHonor}`);
    if (myExp > 0) parts.push(`修为 +${myExp}`);
    if (myStones > 0) parts.push(`灵石 +${myStones}`);
    if (isWinner && dropKey) {
        parts.push(`掉落 ${dropKey}${dropQty > 1 ? `×${dropQty}` : ''}`);
    }
    const karmaChange = Number(settle.karma_change) || 0;
    if (karmaChange !== 0) {
        parts.push(`因果 ${karmaChange > 0 ? '+' : ''}${karmaChange}`);
    }
    return parts.join('，');
}

/**
 * 读取后端 PvpService.js 源代码，验证 _settleBattle 返回字段
 */
function verifyBackendSettleFields() {
    console.log('\n[场景1] 验证后端 _settleBattle 返回字段');
    const pvpServicePath = path.join(__dirname, '..', 'game', 'services', 'PvpService.js');
    const content = fs.readFileSync(pvpServicePath, 'utf-8');

    // 验证 _settleBattle 返回的关键字段
    const expectedFields = [
        'winner_id',
        'is_draw',
        'attacker_honor_gain',
        'defender_honor_gain',
        'attacker_exp_gain',
        'defender_exp_gain',
        'spirit_stone_reward',
        'loser_consolation_stone',
        'loser_consolation_exp',
        'loser_id',
        'drop_item_key',
        'drop_item_quantity',
        'karma_change'
    ];

    for (const field of expectedFields) {
        assert(content.includes(field), `后端 _settleBattle 应包含字段: ${field}`);
    }
}

/**
 * 验证 executeAction 返回结构包含 battle_ended 和 settle
 */
function verifyExecuteActionReturnStructure() {
    console.log('\n[场景2] 验证 executeAction 返回结构');
    const pvpServicePath = path.join(__dirname, '..', 'game', 'services', 'PvpService.js');
    const content = fs.readFileSync(pvpServicePath, 'utf-8');

    // 验证 executeAction 返回的关键字段
    assert(content.includes('battle_ended: true'), 'executeAction 战斗结束时应返回 battle_ended: true');
    assert(content.includes('battle_ended: false'), 'executeAction 战斗未结束时应返回 battle_ended: false');
    assert(content.includes('settle: settleResult'), 'executeAction 战斗结束时应返回 settle 字段');

    // 验证 flee 也返回 settle
    assert(content.includes('fled: true'), 'flee 应返回 fled: true');
    // flee 的返回结构中包含 settle
    const fleeReturnMatch = content.match(/fled:\s*true,[\s\S]*?settle:\s*settleResult/);
    assert(fleeReturnMatch !== null, 'flee 应返回 settle 字段');
}

/**
 * 场景3：胜方视角的 settle 字段读取
 */
function testWinnerPerspective() {
    console.log('\n[场景3] 胜方视角结算');
    // 模拟后端返回：玩家1是攻击方且胜方
    const settle = {
        battle_id: 1,
        winner_id: 1,
        is_draw: false,
        attacker_score_change: 10,
        defender_score_change: -10,
        attacker_honor_gain: 50,
        defender_honor_gain: 0,
        attacker_exp_gain: 200,
        defender_exp_gain: 0,
        spirit_stone_reward: 500,
        loser_consolation_stone: 50,
        loser_consolation_exp: 20,
        loser_id: 2,
        drop_item_key: 'spirit_grass',
        drop_item_quantity: 2,
        karma_change: -5,
        finished_at: new Date().toISOString()
    };

    const log = buildPvpSettleLog(settle, 1);
    console.log(`  日志: ${log}`);
    assert(log.includes('斗法胜利'), '胜方视角应显示"斗法胜利"');
    assert(log.includes('荣誉 +50'), '胜方视角应显示荣誉 +50');
    assert(log.includes('修为 +200'), '胜方视角应显示修为 +200');
    assert(log.includes('灵石 +500'), '胜方视角应显示灵石 +500');
    assert(log.includes('掉落 spirit_grass×2'), '胜方视角应显示掉落物品');
    assert(log.includes('因果 -5'), '胜方视角应显示因果值变化');
    // 胜方不应显示败方保底
    assert(!log.includes('参与奖'), '胜方视角不应显示参与奖');
}

/**
 * 场景4：败方视角的 settle 字段读取
 */
function testLoserPerspective() {
    console.log('\n[场景4] 败方视角结算');
    // 玩家2是败方
    const settle = {
        battle_id: 1,
        winner_id: 1,
        is_draw: false,
        attacker_score_change: 10,
        defender_score_change: -10,
        attacker_honor_gain: 50,
        defender_honor_gain: 0,
        attacker_exp_gain: 200,
        defender_exp_gain: 0,
        spirit_stone_reward: 500,
        loser_consolation_stone: 50,
        loser_consolation_exp: 20,
        loser_id: 2,
        drop_item_key: 'spirit_grass',
        drop_item_quantity: 2,
        karma_change: -5,
        finished_at: new Date().toISOString()
    };

    const log = buildPvpSettleLog(settle, 2);
    console.log(`  日志: ${log}`);
    assert(log.includes('斗法落败'), '败方视角应显示"斗法落败"');
    // 败方不获得荣誉
    assert(!log.includes('荣誉'), '败方视角不应显示荣誉');
    // 败方获得保底修为
    assert(log.includes('修为 +20'), '败方视角应显示保底修为 +20');
    // 败方获得保底灵石
    assert(log.includes('灵石 +50'), '败方视角应显示保底灵石 +50');
    // 败方不应显示掉落物品（掉落是胜方视角）
    assert(!log.includes('掉落'), '败方视角不应显示掉落物品');
}

/**
 * 场景5：平局视角的 settle 字段读取
 */
function testDrawPerspective() {
    console.log('\n[场景5] 平局视角结算');
    const settle = {
        battle_id: 1,
        winner_id: null,
        is_draw: true,
        attacker_score_change: 0,
        defender_score_change: 0,
        attacker_honor_gain: 10,
        defender_honor_gain: 10,
        attacker_exp_gain: 50,
        defender_exp_gain: 50,
        spirit_stone_reward: 0,
        loser_consolation_stone: 0,
        loser_consolation_exp: 0,
        loser_id: null,
        drop_item_key: null,
        drop_item_quantity: 0,
        karma_change: 0,
        finished_at: new Date().toISOString()
    };

    // 平局时双方都获得荣誉，任一玩家视角都应显示
    const log = buildPvpSettleLog(settle, 1);
    console.log(`  日志: ${log}`);
    assert(log.includes('斗法平局'), '平局视角应显示"斗法平局"');
    assert(log.includes('荣誉 +10'), '平局视角应显示荣誉 +10');
    assert(log.includes('修为 +50'), '平局视角应显示修为 +50');
    // 平局无灵石
    assert(!log.includes('灵石'), '平局视角不应显示灵石');
    // 平局无掉落
    assert(!log.includes('掉落'), '平局视角不应显示掉落');
}

/**
 * 场景6：逃跑结算（败方保底）
 */
function testFleeSettle() {
    console.log('\n[场景6] 逃跑结算');
    // 逃跑时 fleer_id 是逃跑方，胜方是对手
    const settle = {
        battle_id: 1,
        winner_id: 2,
        is_draw: false,
        attacker_score_change: -10,
        defender_score_change: 10,
        attacker_honor_gain: 0,
        defender_honor_gain: 30,
        attacker_exp_gain: 0,
        defender_exp_gain: 100,
        spirit_stone_reward: 300,
        loser_consolation_stone: 30,
        loser_consolation_exp: 15,
        loser_id: 1,  // 逃跑方是败方
        drop_item_key: null,
        drop_item_quantity: 0,
        karma_change: -3,
        finished_at: new Date().toISOString()
    };

    // 逃跑方视角（玩家1）
    const log = buildPvpSettleLog(settle, 1);
    console.log(`  日志: ${log}`);
    assert(log.includes('斗法落败'), '逃跑方视角应显示"斗法落败"');
    assert(!log.includes('荣誉'), '逃跑方视角不应显示荣誉');
    assert(log.includes('修为 +15'), '逃跑方视角应显示保底修为 +15');
    assert(log.includes('灵石 +30'), '逃跑方视角应显示保底灵石 +30');
    assert(log.includes('因果 -3'), '逃跑方视角应显示因果变化');
}

/**
 * 场景7：边界场景 - settle 为 null/undefined
 */
function testNullSettle() {
    console.log('\n[场景7] 边界场景 - settle 为空');
    assert(buildPvpSettleLog(null, 1) === '斗法结束', 'settle 为 null 应返回默认文案');
    assert(buildPvpSettleLog(undefined, 1) === '斗法结束', 'settle 为 undefined 应返回默认文案');
    assert(buildPvpSettleLog({}, 1) === '斗法落败', '空 settle 应返回默认败方文案');
}

/**
 * 场景8：验证前端 PvpPanel.vue 已应用修复
 */
function verifyFrontendFixes() {
    console.log('\n[场景8] 验证前端 PvpPanel.vue 已应用修复');
    const pvpPanelPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'PvpPanel.vue');
    const content = fs.readFileSync(pvpPanelPath, 'utf-8');

    // 验证字段名修复（is_finished → battle_ended）
    assert(content.includes('data?.battle_ended'), '应使用 data?.battle_ended（而非 is_finished）');

    // 验证引入 playerStore
    assert(content.includes('usePlayerStore'), '应引入 usePlayerStore');
    assert(content.includes('playerStore.player?.id'), '应通过 playerStore.player?.id 获取当前玩家ID');

    // 验证 buildPvpSettleLog 函数存在
    assert(content.includes('buildPvpSettleLog'), '应定义 buildPvpSettleLog 函数');

    // 验证不应再使用旧的 is_finished 字段
    assert(!content.includes('data?.is_finished'), '不应再使用 data?.is_finished');

    // 验证 confirmFlee 也展示结算信息
    assert(content.includes('主动逃离战斗'), 'confirmFlee 应展示"主动逃离战斗"日志');
}

/**
 * 场景9：验证 SeclusionOverlay.vue 已应用 HP/MP 恢复值展示修复
 */
function verifySeclusionOverlayFixes() {
    console.log('\n[场景9] 验证 SeclusionOverlay.vue 已应用 HP/MP 恢复值展示修复');
    const overlayPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'SeclusionOverlay.vue');
    const content = fs.readFileSync(overlayPath, 'utf-8');

    // 验证 buildSeclusionSettleLog 函数存在
    assert(content.includes('buildSeclusionSettleLog'), '应定义 buildSeclusionSettleLog 函数');

    // 验证读取 hp_restored 和 mp_restored 字段
    assert(content.includes('hp_restored'), '应读取 hp_restored 字段');
    assert(content.includes('mp_restored'), '应读取 mp_restored 字段');

    // 验证使用 ?? 而非 || （避免 0 被误判为 falsy）
    assert(content.includes('Number(res?.data?.exp_gain ?? 0)'), '应使用 ?? 0 处理 exp_gain（避免 fallback 到 player.exp）');

    // 验证 handleForceEnd 也使用 buildSeclusionSettleLog
    const forceEndSection = content.match(/handleForceEnd[\s\S]*?buildSeclusionSettleLog/);
    assert(forceEndSection !== null, 'handleForceEnd 应使用 buildSeclusionSettleLog');

    // 验证不再有 fallback 到 player.exp 的旧逻辑（仅在非注释代码行中检查）
    // 注释中提及旧逻辑是允许的，但代码中不应再有该逻辑
    const codeLines = content.split('\n').filter(line => {
        // 去除单行注释（// 开头的行）
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    const codeContent = codeLines.join('\n');
    assert(!codeContent.includes("res?.data?.exp_gain || res?.data?.player?.exp"), '不应再有 fallback 到 player.exp 的旧逻辑（代码行）');
}

/**
 * 场景10：验证 ExplorePanel.vue 物品奖励数量展示修复
 */
function verifyExplorePanelFixes() {
    console.log('\n[场景10] 验证 ExplorePanel.vue 物品奖励数量展示修复');
    const explorePath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'ExplorePanel.vue');
    const content = fs.readFileSync(explorePath, 'utf-8');

    // 验证显示物品数量
    assert(content.includes('i.quantity'), '应显示物品数量 quantity');
    assert(content.includes('item_name'), '应优先使用 item_name（回退到 item_key）');

    // 验证使用 formatNumber 处理大数
    assert(content.includes('formatNumber(rewards.exp'), '应使用 formatNumber 处理修为数值');
    assert(content.includes('formatNumber(rewards.spirit_stones'), '应使用 formatNumber 处理灵石数值');
}

/**
 * 场景11：验证 DungeonPanel.vue BigInt 字符串 formatNumber 修复
 */
function verifyDungeonPanelFixes() {
    console.log('\n[场景11] 验证 DungeonPanel.vue BigInt 字符串 formatNumber 修复');
    const dungeonPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'DungeonPanel.vue');
    const content = fs.readFileSync(dungeonPath, 'utf-8');

    // 验证中断副本日志使用 formatNumber
    assert(content.includes('formatNumber(rewardExp || 0)'), '中断副本日志应使用 formatNumber 格式化修为');

    // 验证扫荡副本日志使用 formatNumber
    assert(content.includes('formatNumber(rewardStones || 0)'), '扫荡副本日志应使用 formatNumber 格式化灵石');
}

// 主测试流程
async function main() {
    console.log('========================================');
    console.log('  PVP 结算字段一致性测试');
    console.log('========================================');

    verifyBackendSettleFields();
    verifyExecuteActionReturnStructure();
    testWinnerPerspective();
    testLoserPerspective();
    testDrawPerspective();
    testFleeSettle();
    testNullSettle();
    verifyFrontendFixes();
    verifySeclusionOverlayFixes();
    verifyExplorePanelFixes();
    verifyDungeonPanelFixes();

    console.log('\n========================================');
    console.log(`  测试结果: ${passCount}/${passCount + failCount} 通过, ${failCount} 失败`);
    if (failCount > 0) {
        console.log('  失败项:');
        failures.forEach(f => console.log(`    - ${f}`));
    }
    console.log('========================================');

    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
