/**
 * 批次4-3 P1 修为显示一致性修复验证测试
 *
 * 验证内容：
 *   P1-2: 前端各组件 exp/spirit_stones 显示使用 formatNumber
 *         避免大数精度丢失（>2^53 时 Number 转换精度损失）
 *
 * 修复点：
 *   1. PlayerStatus.vue - 修为显示 + 进度条百分比（改用 BigInt 计算）
 *   2. CharacterModal.vue - 当前修为/灵石显示
 *   3. ExploreOverlay.vue - 历练奖励 exp/spirit_stones 显示
 *   4. SectPanel.vue - 点卯/任务奖励 exp 显示
 *   5. CompanionPanel.vue - 心契当前经验显示
 *   6. MeditationManagement.vue - 玩家修为详情显示
 *
 * 运行方式：node server/scripts/test_batch_4_3_p1_exp_display.js
 */
const fs = require('fs');
const path = require('path');

const results = { total: 0, passed: 0, failed: 0, details: [] };

function assert(condition, message, detail = '') {
    results.total++;
    if (condition) {
        results.passed++;
        results.details.push(`✅ ${message}`);
    } else {
        results.failed++;
        results.details.push(`❌ ${message}${detail ? ' | ' + detail : ''}`);
    }
}

function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return '';
    }
}

/**
 * 过滤代码行（去掉注释和空行）
 */
function filterCodeLines(content) {
    return content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .filter(line => !line.startsWith('//'))
        .filter(line => !line.startsWith('*'))
        .filter(line => !line.startsWith('/*'))
        .filter(line => !line.startsWith('*/'));
}

const CLIENT_BASE = path.join(__dirname, '..', '..', 'client', 'src');

/**
 * 场景1：PlayerStatus.vue 修为显示修复
 */
function testPlayerStatusExpDisplay() {
    console.log('\n=== 场景1：PlayerStatus.vue 修为显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'panels', 'PlayerStatus.vue');
    const content = readFile(filePath);

    // 1.1 模板中修为显示应使用 formatNumber
    assert(content.includes('{{ formatNumber(player.exp || 0) }}') || content.includes('formatNumber(player.exp'),
        'P1-2.1 PlayerStatus.vue 修为显示使用 formatNumber');

    // 1.2 模板中修为进度条应使用 expPercentage computed（BigInt 计算）
    assert(content.includes(':style="{ width: expPercentage }"'),
        'P1-2.2 PlayerStatus.vue 进度条使用 expPercentage');

    // 1.3 expPercentage 应使用 BigInt 计算（避免大数精度丢失）
    assert(content.includes('BigInt(props.player.exp'),
        'P1-2.3 expPercentage 使用 BigInt 计算');

    // 1.4 expPercentage 应有 try-catch 降级处理
    assert(content.includes('catch') && content.includes('BigInt'),
        'P1-2.4 expPercentage 有 BigInt 解析失败降级');

    // 1.5 不应再有原始的 player.exp / player.exp_next 直接除法（已改为 BigInt 计算）
    const codeLines = filterCodeLines(content);
    const hasOldDivision = codeLines.some(l =>
        l.includes('player.exp / player.exp_next') ||
        l.includes('player.exp / (props.player.exp_next')
    );
    assert(!hasOldDivision,
        'P1-2.5 不应再有原始的 player.exp/player.exp_next 直接除法');
}

/**
 * 场景2：CharacterModal.vue 修为/灵石显示修复
 */
function testCharacterModalExpDisplay() {
    console.log('\n=== 场景2：CharacterModal.vue 修为/灵石显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'modals', 'CharacterModal.vue');
    const content = readFile(filePath);

    // 2.1 应引入 formatNumber
    assert(content.includes("import { formatNumber } from '../../utils/format'"),
        'P1-2.6 CharacterModal.vue 引入 formatNumber');

    // 2.2 修为显示应使用 formatNumber
    assert(content.includes('formatNumber(player?.exp || 0)'),
        'P1-2.7 CharacterModal.vue 修为显示使用 formatNumber');

    // 2.3 灵石显示应使用 formatNumber
    assert(content.includes('formatNumber(player?.spirit_stones || 0)'),
        'P1-2.8 CharacterModal.vue 灵石显示使用 formatNumber');
}

/**
 * 场景3：ExploreOverlay.vue 历练奖励显示修复
 */
function testExploreOverlayExpDisplay() {
    console.log('\n=== 场景3：ExploreOverlay.vue 历练奖励显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'panels', 'ExploreOverlay.vue');
    const content = readFile(filePath);

    // 3.1 应引入 formatNumber
    assert(content.includes("import { formatNumber } from '../../utils/format'"),
        'P1-2.9 ExploreOverlay.vue 引入 formatNumber');

    // 3.2 修为奖励显示应使用 formatNumber
    assert(content.includes('formatNumber(rewards.exp || 0)'),
        'P1-2.10 ExploreOverlay.vue 修为奖励使用 formatNumber');

    // 3.3 灵石奖励显示应使用 formatNumber
    assert(content.includes('formatNumber(rewards.spirit_stones)'),
        'P1-2.11 ExploreOverlay.vue 灵石奖励使用 formatNumber');
}

/**
 * 场景4：SectPanel.vue 宗门奖励显示修复
 */
function testSectPanelExpDisplay() {
    console.log('\n=== 场景4：SectPanel.vue 宗门奖励显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'panels', 'SectPanel.vue');
    const content = readFile(filePath);

    // 4.1 应引入 formatNumber
    assert(content.includes("import { formatNumber } from '../../utils/format'"),
        'P1-2.12 SectPanel.vue 引入 formatNumber');

    // 4.2 点卯修为奖励应使用 formatNumber
    assert(content.includes('formatNumber(result.rewards?.exp || 0)'),
        'P1-2.13 SectPanel.vue 点卯修为奖励使用 formatNumber');

    // 4.3 应有至少 2 处 formatNumber 调用（点卯 + 任务提交）
    const matchCount = (content.match(/formatNumber\(result\.rewards\?\.exp \|\| 0\)/g) || []).length;
    assert(matchCount >= 2,
        'P1-2.14 SectPanel.vue 应有至少 2 处 formatNumber 调用（点卯+任务）',
        `实际=${matchCount}`);
}

/**
 * 场景5：CompanionPanel.vue 心契经验显示修复
 */
function testCompanionPanelExpDisplay() {
    console.log('\n=== 场景5：CompanionPanel.vue 心契经验显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'panels', 'CompanionPanel.vue');
    const content = readFile(filePath);

    // 5.1 应引入 formatNumber
    assert(content.includes("import { formatNumber } from '../../utils/format'"),
        'P1-2.15 CompanionPanel.vue 引入 formatNumber');

    // 5.2 心契当前经验显示应使用 formatNumber
    assert(content.includes('formatNumber(heartContractData.heart_contract.exp)'),
        'P1-2.16 CompanionPanel.vue 心契经验使用 formatNumber');
}

/**
 * 场景6：MeditationManagement.vue 玩家修为显示修复
 */
function testMeditationManagementExpDisplay() {
    console.log('\n=== 场景6：MeditationManagement.vue 玩家修为显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'admin', 'sub', 'MeditationManagement.vue');
    const content = readFile(filePath);

    // 6.1 应引入 formatNumber
    assert(content.includes("import { formatNumber } from '../../../utils/format'"),
        'P1-2.17 MeditationManagement.vue 引入 formatNumber');

    // 6.2 玩家修为显示应使用 formatNumber
    assert(content.includes('formatNumber(detailPlayer.exp)'),
        'P1-2.18 MeditationManagement.vue 玩家修为使用 formatNumber');
}

/**
 * 场景7：验证 formatNumber 工具函数存在
 */
function testFormatNumberUtilExists() {
    console.log('\n=== 场景7：验证 formatNumber 工具函数存在 ===');
    const filePath = path.join(CLIENT_BASE, 'utils', 'format.js');
    const content = readFile(filePath);

    // 7.1 format.js 应存在并导出 formatNumber
    assert(content.includes('export') && content.includes('formatNumber'),
        'P1-2.19 utils/format.js 导出 formatNumber 函数');

    // 7.2 formatNumber 应处理字符串/数字/BigInt
    assert(content.includes('BigInt') || content.includes('string'),
        'P1-2.20 formatNumber 支持 BigInt 字符串处理');
}

/**
 * 主测试入口
 */
function main() {
    console.log('=========================================');
    console.log('批次4-3 P1 修为显示一致性修复验证测试');
    console.log('=========================================');

    testPlayerStatusExpDisplay();
    testCharacterModalExpDisplay();
    testExploreOverlayExpDisplay();
    testSectPanelExpDisplay();
    testCompanionPanelExpDisplay();
    testMeditationManagementExpDisplay();
    testFormatNumberUtilExists();

    console.log('\n=========================================');
    console.log('测试结果汇总');
    console.log('=========================================');
    console.log(`总计：${results.total}`);
    console.log(`通过：${results.passed}`);
    console.log(`失败：${results.failed}`);
    console.log('\n详细结果：');
    results.details.forEach(d => console.log(`  ${d}`));

    if (results.failed > 0) {
        console.log('\n❌ 测试未通过');
        process.exit(1);
    } else {
        console.log('\n✅ 全部测试通过');
        process.exit(0);
    }
}

main();
