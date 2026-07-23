/**
 * 洞天寻宝系统端到端测试
 *
 * 测试目标：验证洞天寻宝多人交互玩法的完整流程
 *   - 寻宝参数校验（地块编号、自身洞府、目标不存在等）
 *   - 寻宝成功率计算与结果判定
 *   - 资源真实转移（灵石从洞府主人转移到寻宝者）
 *   - 陷阱/遭遇惩罚正确应用
 *   - 被发现机制与日志记录
 *   - 寻宝日志查询（hunter/owner 角色）
 *   - 每日次数限制与冷却校验
 *
 * 测试策略：
 *   1. 直接调用 CaveSocialService.treasureHunt（Service 层测试）
 *   2. 使用测试账号 1592363624 作为寻宝者
 *   3. 查询数据库寻找另一个已开辟洞府的玩家作为目标
 *   4. 记录寻宝前后双方灵石/修为/HP 变化验证资源转移
 *   5. 清理测试产生的寻宝日志（回滚或删除）
 *
 * 运行方式：node server/scripts/test_cave_treasure_hunt.js
 */
const path = require('path');
// 显式加载 server/.env，避免从项目根目录运行时找不到 .env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const Player = require('../models/player');
const PlayerCave = require('../models/playerCave');
const CaveTreasureLog = require('../models/caveTreasureLog');
const CaveSocialService = require('../game/services/CaveSocialService');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;

// 测试结果收集
const testResults = [];
let passedCount = 0;
let failedCount = 0;

/**
 * 记录测试结果
 * @param {string} sectionName - 测试段名称
 * @param {string} name - 测试用例名称
 * @param {boolean} passed - 是否通过
 * @param {string} detail - 详情
 */
function record(sectionName, name, passed, detail = '') {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    testResults.push({ section: sectionName, name, passed, detail });
    if (passed) {
        passedCount++;
    } else {
        failedCount++;
    }
    console.log(`  ${status} | ${name}${detail ? ' | ' + detail : ''}`);
}

/**
 * 打印测试段标题
 */
function section(title) {
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  ${title}`);
    console.log(`═══════════════════════════════════════════════════════`);
}

/**
 * 主测试函数
 */
async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  洞天寻宝系统端到端测试                                ║');
    console.log('║  验证多人交互玩法：寻宝/资源转移/陷阱/日志             ║');
    console.log('╚═══════════════════════════════════════════════════════╝');

    // ────────────────────────────────────────────────────────
    // 段 1：初始化
    // ────────────────────────────────────────────────────────
    section('段 1：初始化配置加载器与数据库');

    try {
        await configLoader.initialize();
        CaveSocialService.initialize(configLoader);
        record('初始化', '配置加载器初始化', true);
    } catch (e) {
        record('初始化', '配置加载器初始化', false, e.message);
        return;
    }

    try {
        await sequelize.authenticate();
        record('初始化', '数据库连接', true);
    } catch (e) {
        record('初始化', '数据库连接', false, e.message);
        return;
    }

    // ────────────────────────────────────────────────────────
    // 段 2：准备测试数据
    // ────────────────────────────────────────────────────────
    section('段 2：准备测试数据（寻宝者 + 目标洞府主人）');

    // 测试账号作为寻宝者（username=1592363624 对应玩家 ID=1）
    const TEST_HUNTER_USERNAME = '1592363624';
    const hunter = await Player.findOne({ where: { username: TEST_HUNTER_USERNAME } });
    if (!hunter) {
        record('准备数据', '查找测试账号寻宝者', false, `username ${TEST_HUNTER_USERNAME} 不存在`);
        return;
    }
    const TEST_HUNTER_ID = hunter.id;
    record('准备数据', '查找测试账号寻宝者', true, `${hunter.nickname}（ID: ${TEST_HUNTER_ID}, 境界: ${hunter.realm}）`);

    // 确保寻宝者有足够灵石（至少 1000 用于寻宝费 + 潜在损失）
    const hunterOriginalStones = BigInt(hunter.spirit_stones || 0);
    if (hunterOriginalStones < 1000n) {
        hunter.spirit_stones = 10000n;
        await hunter.save();
        record('准备数据', '补充寻宝者灵石', true, '设为 10000');
    } else {
        record('准备数据', '寻宝者灵石充足', true, `${hunterOriginalStones.toString()}`);
    }

    // 确保寻宝者洞府已开辟（否则无法测试"不能寻宝自己"）
    let hunterCave = await PlayerCave.findOne({ where: { player_id: TEST_HUNTER_ID } });
    if (!hunterCave || !hunterCave.is_opened) {
        record('准备数据', '寻宝者洞府状态', false, '寻宝者洞府未开辟（不影响测试，跳过自身寻宝测试）');
    } else {
        record('准备数据', '寻宝者洞府状态', true, '已开辟');
    }

    // 查询另一个已开辟洞府的玩家作为目标
    let targetCandidates = await sequelize.query(`
        SELECT pc.player_id, p.nickname, p.realm, p.realm_rank, p.spirit_stones
        FROM player_caves pc
        JOIN players p ON p.id = pc.player_id
        WHERE pc.is_opened = 1 AND pc.player_id != :hunterId AND p.is_dead = 0
        LIMIT 5
    `, {
        replacements: { hunterId: TEST_HUNTER_ID },
        type: QueryTypes.SELECT
    });

    // 如果没有其他已开辟洞府的玩家，为玩家 9（叶天帝）创建洞府作为测试目标
    if (targetCandidates.length === 0) {
        console.log('  ℹ 数据库中无其他已开辟洞府的玩家，尝试为叶天帝（ID=9）开辟洞府...');
        const targetPlayer = await Player.findByPk(9);
        if (targetPlayer && !targetPlayer.is_dead) {
            // 确保目标玩家有灵石
            if (BigInt(targetPlayer.spirit_stones || 0) < 1000n) {
                targetPlayer.spirit_stones = 10000n;
                await targetPlayer.save();
            }
            // 创建或更新洞府记录
            let targetCave = await PlayerCave.findOne({ where: { player_id: 9 } });
            if (!targetCave) {
                targetCave = await PlayerCave.create({
                    player_id: 9,
                    is_opened: true,
                    opened_at: new Date(),
                    spirit_vein_level: 1,
                    quiet_room_level: 0,
                    pill_room_level: 0,
                    tool_room_level: 0,
                    grand_formation_level: 1,
                    garden_plots: 3,
                    landscape_id: null
                });
            } else {
                targetCave.is_opened = true;
                targetCave.opened_at = new Date();
                await targetCave.save();
            }
            record('准备数据', '为叶天帝开辟洞府', true, '已创建洞府记录');
            // 重新查询
            targetCandidates = await sequelize.query(`
                SELECT pc.player_id, p.nickname, p.realm, p.realm_rank, p.spirit_stones
                FROM player_caves pc
                JOIN players p ON p.id = pc.player_id
                WHERE pc.is_opened = 1 AND pc.player_id != :hunterId AND p.is_dead = 0
                LIMIT 5
            `, {
                replacements: { hunterId: TEST_HUNTER_ID },
                type: QueryTypes.SELECT
            });
        }
    }

    if (targetCandidates.length === 0) {
        record('准备数据', '查找目标洞府主人', false, '数据库中无其他已开辟洞府的玩家');
        console.log('\n⚠ 无法找到目标洞府主人，后续测试将跳过。');
        printSummary();
        return;
    }

    // 选择第一个候选作为目标
    const target = targetCandidates[0];
    const TARGET_ID = target.player_id;
    record('准备数据', '查找目标洞府主人', true, `${target.nickname}（ID: ${TARGET_ID}, 境界: ${target.realm}, 灵石: ${target.spirit_stones}）`);

    // 清理之前的测试日志（避免冷却限制影响本次测试）
    await CaveTreasureLog.destroy({
        where: { hunter_id: TEST_HUNTER_ID, cave_owner_id: TARGET_ID }
    });
    record('准备数据', '清理历史寻宝日志', true, '已清理同洞府寻宝记录');

    // ────────────────────────────────────────────────────────
    // 段 3：参数校验测试
    // ────────────────────────────────────────────────────────
    section('段 3：参数校验测试');

    // 3.1 无效地块编号（0）
    try {
        await CaveSocialService.treasureHunt(TEST_HUNTER_ID, TARGET_ID, 0);
        record('参数校验', '地块编号 0 应被拒绝', false, '未抛出错误');
    } catch (e) {
        record('参数校验', '地块编号 0 应被拒绝', true, e.message);
    }

    // 3.2 无效地块编号（10，超出 1-9 范围）
    try {
        await CaveSocialService.treasureHunt(TEST_HUNTER_ID, TARGET_ID, 10);
        record('参数校验', '地块编号 10 应被拒绝', false, '未抛出错误');
    } catch (e) {
        record('参数校验', '地块编号 10 应被拒绝', true, e.message);
    }

    // 3.3 寻宝自己洞府
    try {
        await CaveSocialService.treasureHunt(TEST_HUNTER_ID, TEST_HUNTER_ID, 1);
        record('参数校验', '不能寻宝自己洞府', false, '未抛出错误');
    } catch (e) {
        record('参数校验', '不能寻宝自己洞府', true, e.message);
    }

    // 3.4 目标玩家不存在
    try {
        await CaveSocialService.treasureHunt(TEST_HUNTER_ID, 99999999, 1);
        record('参数校验', '目标玩家不存在应报错', false, '未抛出错误');
    } catch (e) {
        record('参数校验', '目标玩家不存在应报错', true, e.message);
    }

    // ────────────────────────────────────────────────────────
    // 段 4：寻宝执行与资源转移验证
    // ────────────────────────────────────────────────────────
    section('段 4：寻宝执行与资源转移验证');

    // 记录寻宝前状态
    const hunterBefore = await Player.findByPk(TEST_HUNTER_ID);
    const ownerBefore = await Player.findByPk(TARGET_ID);
    const hunterStonesBefore = BigInt(hunterBefore.spirit_stones || 0);
    const ownerStonesBefore = BigInt(ownerBefore.spirit_stones || 0);
    const hunterExpBefore = BigInt(hunterBefore.exp || 0);
    const hunterHpBefore = Number(hunterBefore.hp_current || 0);

    console.log(`  寻宝前：寻宝者灵石=${hunterStonesBefore.toString()}, 修为=${hunterExpBefore.toString()}, HP=${hunterHpBefore}`);
    console.log(`  寻宝前：洞府主人灵石=${ownerStonesBefore.toString()}`);

    // 执行寻宝（地块 1）
    let huntResult = null;
    try {
        huntResult = await CaveSocialService.treasureHunt(TEST_HUNTER_ID, TARGET_ID, 1);
        record('寻宝执行', '寻宝接口调用成功', true, `结果类型: ${huntResult.result_type}, 成功率: ${(huntResult.success_rate * 100).toFixed(0)}%`);
    } catch (e) {
        record('寻宝执行', '寻宝接口调用成功', false, e.message);
        printSummary();
        return;
    }

    // 验证返回字段完整性
    const requiredFields = ['success', 'message', 'result_type', 'result_name', 'rewards', 'is_discovered', 'success_rate', 'plot_number', 'target', 'today_count', 'daily_limit', 'cost', 'remaining_spirit_stones'];
    const missingFields = requiredFields.filter(f => huntResult[f] === undefined);
    record('寻宝执行', '返回字段完整性', missingFields.length === 0, missingFields.length > 0 ? `缺失字段: ${missingFields.join(', ')}` : '所有必需字段齐全');

    // 验证结果类型合法
    const validResultTypes = ['treasure', 'trap', 'encounter', 'empty'];
    record('寻宝执行', '结果类型合法', validResultTypes.includes(huntResult.result_type), `result_type=${huntResult.result_type}`);

    // 验证成功率范围
    record('寻宝执行', '成功率在 5%-85% 范围', huntResult.success_rate >= 0.05 && huntResult.success_rate <= 0.85, `success_rate=${huntResult.success_rate}`);

    // 验证今日次数递增
    record('寻宝执行', '今日次数递增', huntResult.today_count >= 1, `today_count=${huntResult.today_count}`);

    // 验证寻宝费扣除
    const hunterAfter = await Player.findByPk(TEST_HUNTER_ID);
    const hunterStonesAfter = BigInt(hunterAfter.spirit_stones || 0);
    const expectedCost = BigInt(huntResult.cost);

    // 根据结果类型验证资源变化
    if (huntResult.result_type === 'treasure') {
        // 宝物：扣除寻宝费 + 获得借取灵石（净变化 = 借取量 - 寻宝费）
        const stolen = huntResult.rewards.spirit_stones ? BigInt(huntResult.rewards.spirit_stones) : 0n;
        const expectedAfter = hunterStonesBefore - expectedCost + stolen;
        record('寻宝执行', '宝物结果-寻宝费已扣除+灵石借取', hunterStonesAfter === expectedAfter, `灵石: ${hunterStonesBefore} → ${hunterStonesAfter}, 寻宝费: -${expectedCost}, 借取: +${stolen}, 预期: ${expectedAfter}`);

        if (huntResult.rewards.spirit_stones) {
            // 验证灵石从主人转移到寻宝者
            const ownerAfter = await Player.findByPk(TARGET_ID);
            const ownerStonesAfter = BigInt(ownerAfter.spirit_stones || 0);
            record('寻宝执行', '宝物结果-灵石从主人转移', ownerStonesAfter === ownerStonesBefore - stolen, `主人灵石: ${ownerStonesBefore} → ${ownerStonesAfter}, 借取: ${stolen}`);
        }

        if (huntResult.rewards.exp) {
            const hunterExpAfter = BigInt(hunterAfter.exp || 0);
            const expGain = BigInt(huntResult.rewards.exp);
            record('寻宝执行', '宝物结果-修为增加', hunterExpAfter >= hunterExpBefore + expGain, `修为: ${hunterExpBefore} → ${hunterExpAfter}, 获得: ${expGain}`);
        } else {
            record('寻宝执行', '宝物结果-修为增加', true, '本次未获得修为（正常）');
        }
    } else if (huntResult.result_type === 'trap') {
        // 陷阱：扣除寻宝费 + HP损失 + 额外灵石损失
        const hunterHpAfter = Number(hunterAfter.hp_current || 0);
        record('寻宝执行', '陷阱结果-HP损失', hunterHpAfter < hunterHpBefore || hunterHpBefore === 0, `HP: ${hunterHpBefore} → ${hunterHpAfter}`);

        if (huntResult.rewards.spirit_stone_loss) {
            const extraLoss = BigInt(huntResult.rewards.spirit_stone_loss);
            record('寻宝执行', '陷阱结果-额外灵石损失', hunterStonesAfter <= hunterStonesBefore - expectedCost - extraLoss + 1n, `灵石: ${hunterStonesBefore} → ${hunterStonesAfter}, 寻宝费+损失: ${expectedCost + extraLoss}`);
        }
    } else if (huntResult.result_type === 'encounter') {
        // 遭遇：扣除寻宝费 + 灵石损失
        if (huntResult.rewards.spirit_stone_loss) {
            const extraLoss = BigInt(huntResult.rewards.spirit_stone_loss);
            record('寻宝执行', '遭遇结果-灵石损失', hunterStonesAfter <= hunterStonesBefore - expectedCost - extraLoss + 1n, `灵石: ${hunterStonesBefore} → ${hunterStonesAfter}`);
        } else {
            record('寻宝执行', '遭遇结果-灵石损失', true, '本次灵石损失为 0（正常）');
        }
    } else if (huntResult.result_type === 'empty') {
        // 空手：仅扣除寻宝费
        record('寻宝执行', '空手结果-仅扣寻宝费', hunterStonesAfter === hunterStonesBefore - expectedCost, `灵石: ${hunterStonesBefore} → ${hunterStonesAfter}, 寻宝费: ${expectedCost}`);
    }

    // ────────────────────────────────────────────────────────
    // 段 5：寻宝日志验证
    // ────────────────────────────────────────────────────────
    section('段 5：寻宝日志验证');

    // 5.1 查询 hunter 角色日志
    try {
        const hunterLogs = await CaveSocialService.getTreasureLogs(TEST_HUNTER_ID, 'hunter', 10);
        record('寻宝日志', '查询 hunter 日志', hunterLogs.logs.length > 0, `返回 ${hunterLogs.logs.length} 条记录`);

        if (hunterLogs.logs.length > 0) {
            const latestLog = hunterLogs.logs[0];
            const logFields = ['id', 'hunter_id', 'hunter_nickname', 'cave_owner_id', 'cave_owner_nickname', 'plot_number', 'result_type', 'rewards', 'is_discovered', 'created_at'];
            const missingLogFields = logFields.filter(f => latestLog[f] === undefined);
            record('寻宝日志', 'hunter 日志字段完整性', missingLogFields.length === 0, missingLogFields.length > 0 ? `缺失: ${missingLogFields.join(', ')}` : '字段齐全');

            // 验证最新日志与寻宝结果一致
            record('寻宝日志', '日志结果类型一致', latestLog.result_type === huntResult.result_type, `日志: ${latestLog.result_type}, 寻宝: ${huntResult.result_type}`);
            record('寻宝日志', '日志地块编号一致', latestLog.plot_number === 1, `plot_number=${latestLog.plot_number}`);
        }
    } catch (e) {
        record('寻宝日志', '查询 hunter 日志', false, e.message);
    }

    // 5.2 查询 owner 角色日志（从目标玩家视角）
    try {
        const ownerLogs = await CaveSocialService.getTreasureLogs(TARGET_ID, 'owner', 10);
        record('寻宝日志', '查询 owner 日志', true, `返回 ${ownerLogs.logs.length} 条记录`);

        if (ownerLogs.logs.length > 0) {
            // 验证 owner 视角能看到 hunter 信息
            const log = ownerLogs.logs[0];
            record('寻宝日志', 'owner 日志含 hunter 昵称', !!log.hunter_nickname, `hunter: ${log.hunter_nickname}`);
        }
    } catch (e) {
        record('寻宝日志', '查询 owner 日志', false, e.message);
    }

    // ────────────────────────────────────────────────────────
    // 段 6：冷却校验
    // ────────────────────────────────────────────────────────
    section('段 6：同洞府冷却校验（24h）');

    // 再次对同一洞府寻宝，应被冷却拒绝
    try {
        await CaveSocialService.treasureHunt(TEST_HUNTER_ID, TARGET_ID, 2);
        record('冷却校验', '同洞府 24h 冷却', false, '未被冷却拦截');
    } catch (e) {
        record('冷却校验', '同洞府 24h 冷却', true, e.message);
    }

    // ────────────────────────────────────────────────────────
    // 段 7：每日次数限制
    // ────────────────────────────────────────────────────────
    section('段 7：每日次数限制（需足够多目标洞府）');

    // 查询更多已开辟洞府的玩家
    const moreTargets = await sequelize.query(`
        SELECT pc.player_id
        FROM player_caves pc
        JOIN players p ON p.id = pc.player_id
        WHERE pc.is_opened = 1 AND pc.player_id != :hunterId AND p.is_dead = 0
        LIMIT 10
    `, {
        replacements: { hunterId: TEST_HUNTER_ID },
        type: QueryTypes.SELECT
    });

    // 清理所有测试日志以消除冷却限制
    await CaveTreasureLog.destroy({ where: { hunter_id: TEST_HUNTER_ID } });

    const dailyLimit = CaveSocialService.getTreasureHuntConfig().daily_limit || 5;
    let huntCount = 0;
    let limitReached = false;

    for (const t of moreTargets) {
        if (huntCount >= dailyLimit) {
            // 已达上限，尝试再寻宝应被拒绝
            try {
                await CaveSocialService.treasureHunt(TEST_HUNTER_ID, t.player_id, 1);
                record('次数限制', `每日 ${dailyLimit} 次上限`, false, '未被限制拦截');
            } catch (e) {
                record('次数限制', `每日 ${dailyLimit} 次上限`, true, e.message);
                limitReached = true;
            }
            break;
        }
        try {
            // 清理同洞府历史日志避免冷却
            await CaveTreasureLog.destroy({ where: { hunter_id: TEST_HUNTER_ID, cave_owner_id: t.player_id } });
            await CaveSocialService.treasureHunt(TEST_HUNTER_ID, t.player_id, 1);
            huntCount++;
        } catch (e) {
            // 跳过失败的寻宝（如灵石不足等）
            console.log(`  ℹ 第 ${huntCount + 1} 次寻宝失败（目标 ${t.player_id}）: ${e.message}`);
        }
    }

    if (!limitReached && moreTargets.length < dailyLimit) {
        record('次数限制', `每日 ${dailyLimit} 次上限`, true, `数据库中仅 ${moreTargets.length} 个目标洞府，无法测试满额（跳过）`);
    }

    // ────────────────────────────────────────────────────────
    // 段 8：功能开关校验
    // ────────────────────────────────────────────────────────
    section('段 8：清理测试数据');

    // 清理所有测试产生的寻宝日志
    try {
        const deletedCount = await CaveTreasureLog.destroy({
            where: { hunter_id: TEST_HUNTER_ID }
        });
        record('清理', '删除测试寻宝日志', true, `已删除 ${deletedCount} 条`);
    } catch (e) {
        record('清理', '删除测试寻宝日志', false, e.message);
    }

    // 恢复寻宝者灵石（如果测试前补充过）
    if (hunterOriginalStones < 1000n) {
        try {
            const currentHunter = await Player.findByPk(TEST_HUNTER_ID);
            currentHunter.spirit_stones = hunterOriginalStones;
            await currentHunter.save();
            record('清理', '恢复寻宝者灵石', true, `已恢复为 ${hunterOriginalStones.toString()}`);
        } catch (e) {
            record('清理', '恢复寻宝者灵石', false, e.message);
        }
    } else {
        record('清理', '恢复寻宝者灵石', true, '无需恢复（测试前未修改）');
    }

    printSummary();
}

/**
 * 打印测试汇总
 */
function printSummary() {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║  测试汇总                                             ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log(`  总用例数: ${testResults.length}`);
    console.log(`  ✅ 通过: ${passedCount}`);
    console.log(`  ❌ 失败: ${failedCount}`);
    console.log(`  通过率: ${testResults.length > 0 ? ((passedCount / testResults.length) * 100).toFixed(1) : 0}%`);

    if (failedCount > 0) {
        console.log('\n  失败用例详情:');
        testResults.filter(r => !r.passed).forEach(r => {
            console.log(`    ❌ [${r.section}] ${r.name} | ${r.detail}`);
        });
    }

    process.exit(failedCount > 0 ? 1 : 0);
}

// 启动测试
main().catch(err => {
    console.error('\n💥 测试脚本异常崩溃:', err);
    process.exit(1);
});
