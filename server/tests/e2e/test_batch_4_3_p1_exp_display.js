/**
 * 批次4-3 P1 修为显示一致性修复验证测试
 *
 * 验证内容：
 *   P1-2: 前端各组件 exp/spirit_stones 显示使用 formatNumber
 *         避免大数精度丢失（>2^53 时 Number 转换精度损失）
 *   P1-2.21~23: 超过 1 万的数值改用 formatCompact 的万/亿单位
 *         避免长数字撑破 w-72 左侧状态栏等窄容器
 *
 * 修复点：
 *   1. PlayerStatus.vue - 修为显示 + 进度条百分比（改用 BigInt 计算）
 *   2. CharacterModal.vue - 当前修为/灵石显示
 *   3. ExploreOverlay.vue - 历练奖励 exp/spirit_stones 显示
 *   4. SectPanel.vue - 点卯/任务奖励 exp 显示
 *   5. CompanionPanel.vue - 心契当前经验显示
 *   6. MeditationManagement.vue - 玩家修为详情显示
 *
 * 运行方式：node server/tests/e2e/test_batch_4_3_p1_exp_display.js
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
 * 判断组件是否从 utils/format 引入了 BigInt 安全的数值格式化函数
 * formatNumber（千分位）与 formatCompact（万/亿简写）都满足"不裸显大数"的要求
 */
function importsFormatter(content) {
    return /import\s*\{[^}]*\bformat(?:Number|Compact)\b[^}]*\}\s*from\s*'\.\.\/\.\.\/utils\/format'/.test(content)
        || /import\s*\{[^}]*\bformat(?:Number|Compact)\b[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/utils\/format'/.test(content);
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

const CLIENT_BASE = path.join(__dirname, '..', '..', '..', 'client', 'src');

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

    // 1.2 进度条宽度走统一的 expBarWidth（内部读 calcExpProgress / 后端 exp_progress）
    assert(content.includes(':style="{ width: expBarWidth }"'),
        'P1-2.2 PlayerStatus.vue 进度条使用 expBarWidth（统一进度算法）');

    // 1.3 境界进度必须走共享 calcExpProgress（与数据统计/后端同口径，BigInt 安全）
    assert(content.includes('calcExpProgress'),
        'P1-2.3 PlayerStatus.vue 使用共享 calcExpProgress');

    // 1.4 上屏百分比走 formatExpProgress，禁止自己截断成 0%
    assert(content.includes('formatExpProgress'),
        'P1-2.4 PlayerStatus.vue 使用 formatExpProgress 上屏');

    // 1.5 不应再有原始的 player.exp / player.exp_next 直接除法（统一走 calcExpProgress）
    const codeLines = filterCodeLines(content);
    const hasOldDivision = codeLines.some(l =>
        l.includes('player.exp / player.exp_next') ||
        l.includes('player.exp / (props.player.exp_next') ||
        /BigInt\(props\.player\.exp\s*\|\|\s*0\)\s*\n?\s*const expNext = BigInt\(props\.player\.exp_next/.test(l)
    );
    assert(!hasOldDivision,
        'P1-2.5 不应再有原始的 player.exp/player.exp_next 直接除法');

    // 1.6 禁止旧的整除百分比（会把 0.02% 截成 0%）
    assert(!content.includes('(exp * 100n) / expNext'),
        'P1-2.5b 禁止 BigInt 整除截断百分比（会把 0.02% 显示成 0%）');
}

/**
 * 场景2：CharacterModal.vue 修为/灵石显示修复
 */
function testCharacterModalExpDisplay() {
    console.log('\n=== 场景2：CharacterModal.vue 修为/灵石显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'modals', 'CharacterModal.vue');
    const content = readFile(filePath);

    // 2.1 应引入 BigInt 安全的格式化函数
    assert(importsFormatter(content),
        'P1-2.6 CharacterModal.vue 引入 formatNumber/formatCompact');

    // 2.2 修为显示应使用 formatNumber（精确值挂 title；上屏可 formatCompact）
    assert(content.includes('formatNumber(expCurrent)'),
        'P1-2.7 CharacterModal.vue 修为显示使用 formatNumber(expCurrent)');

    // 2.2b 境界进度必须与左栏共用 calcExpProgress / formatExpProgress
    assert(content.includes('calcExpProgress') && content.includes('formatExpProgress'),
        'P1-2.7b CharacterModal.vue 与左栏共用进度算法');

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

    // 4.1 应引入 BigInt 安全的格式化函数
    assert(importsFormatter(content),
        'P1-2.12 SectPanel.vue 引入 formatNumber/formatCompact');

    // 4.2 点卯修为奖励应使用 formatNumber
    assert(content.includes('formatNumber(result.rewards?.exp || 0)'),
        'P1-2.13 SectPanel.vue 点卯修为奖励使用 formatNumber');

    // 4.3 修为奖励展示走 BigInt 安全格式化（formatNumber 或 formatCompact 均可）
    assert(content.includes('formatNumber(result.rewards?.exp || 0)')
        || content.includes('formatCompact(result.rewards?.exp'),
        'P1-2.14 SectPanel.vue 修为奖励使用 BigInt 安全格式化');
}

/**
 * 场景5：CompanionPanel.vue 心契经验显示修复
 */
function testCompanionPanelExpDisplay() {
    console.log('\n=== 场景5：CompanionPanel.vue 心契经验显示修复 ===');
    const filePath = path.join(CLIENT_BASE, 'components', 'panels', 'CompanionPanel.vue');
    const content = readFile(filePath);

    // 5.1 应引入 BigInt 安全格式化（formatNumber 或 formatCompact）
    assert(content.includes("from '../../utils/format'")
        && (content.includes('formatNumber') || content.includes('formatCompact')),
        'P1-2.15 CompanionPanel.vue 引入 BigInt 安全格式化');

    // 5.2 心契进度用 formatCompact（BigInt 级双修次数）；旧断言钉死的 heart_contract.exp 字段后端已无
    assert(content.includes('formatCompact(heartContractData'),
        'P1-2.16 CompanionPanel.vue 心契进度使用 formatCompact');
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

    // 7.3 应导出 formatCompact：超过 1 万的数值改用万/亿单位，避免长数字撑破窄容器
    assert(content.includes('export function formatCompact'),
        'P1-2.21 utils/format.js 导出 formatCompact 函数');

    // 7.4 formatCompact 应覆盖 万/亿/兆 四位一档的单位表
    assert(content.includes('万') && content.includes('亿') && content.includes('兆'),
        'P1-2.22 formatCompact 使用中文四位一档单位表');

    // 7.5 左侧状态栏（固定 w-72）应改用 formatCompact 显示大数
    // 六维已由 useStatSchema.gridCell 统一 formatCompact，这里校验灵石资源格 + 导入
    const statusContent = readFile(path.join(CLIENT_BASE, 'components', 'panels', 'PlayerStatus.vue'));
    assert(statusContent.includes('formatCompact(player.spirit_stones')
        && statusContent.includes('formatCompact'),
        'P1-2.23 PlayerStatus.vue 灵石/六维使用 formatCompact');

    // 7.6 共享进度算法必须存在（左栏与数据统计的唯一口径）
    assert(content.includes('export function calcExpProgress')
        && content.includes('export function formatExpProgress'),
        'P1-2.24 utils/format.js 导出 calcExpProgress / formatExpProgress');
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
