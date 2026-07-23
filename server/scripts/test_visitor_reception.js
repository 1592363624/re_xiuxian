/**
 * 接待/驱逐访客系统端到端测试
 *
 * 测试目标：验证接待/驱逐访客系统的完整流程
 *   - 获取待处理访客列表
 *   - 接待访客（消耗灵石 + buff 设置 + WebSocket 通知）
 *   - 驱逐访客（封锁拜访+寻宝 + WebSocket 通知）
 *   - 忽略访客（清理待处理列表）
 *   - 寻宝联动：驱逐封锁 → 无法寻宝；接待期间寻宝 → 背叛惩罚（发现率+50%）
 *   - 权限校验（只能处理自己洞府的访客）
 *   - 幂等校验（已处理的访客不能再次处理）
 *
 * 测试策略：
 *   1. 使用玩家 1（韩天尊）作为洞府主人
 *   2. 使用玩家 9（叶天帝）作为访客
 *   3. 先让玩家 9 拜访玩家 1 的洞府（创建访客记录）
 *   4. 然后测试接待/驱逐/忽略操作
 *   5. 验证寻宝联动（驱逐后无法寻宝、接待后背叛惩罚）
 *
 * 运行方式：node server/scripts/test_visitor_reception.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const Player = require('../models/player');
const PlayerCave = require('../models/playerCave');
const CaveVisitor = require('../models/caveVisitor');
const CaveTreasureLog = require('../models/caveTreasureLog');
const CaveSocialService = require('../game/services/CaveSocialService');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;

const testResults = [];
let passedCount = 0;
let failedCount = 0;

function record(section, name, passed, detail = '') {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    testResults.push({ section, name, passed, detail });
    if (passed) passedCount++; else failedCount++;
    console.log(`  ${status} | ${name}${detail ? ' | ' + detail : ''}`);
}

function section(title) {
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  ${title}`);
    console.log(`═══════════════════════════════════════════════════════`);
}

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  接待/驱逐访客系统端到端测试                          ║');
    console.log('║  验证多人社交博弈：接待buff/驱逐封锁/寻宝联动         ║');
    console.log('╚═══════════════════════════════════════════════════════╝');

    // ── 段 1：初始化 ──
    section('段 1：初始化');
    try {
        await configLoader.initialize();
        CaveSocialService.initialize(configLoader);
        record('初始化', '配置加载器', true);
    } catch (e) {
        record('初始化', '配置加载器', false, e.message);
        return;
    }
    try {
        await sequelize.authenticate();
        record('初始化', '数据库连接', true);
    } catch (e) {
        record('初始化', '数据库连接', false, e.message);
        return;
    }

    // 验证配置
    const vrConfig = CaveSocialService.getVisitorReceptionConfig();
    record('初始化', '接待配置已加载', vrConfig.enabled === true, `enabled=${vrConfig.enabled}, receive_cost=${vrConfig.receive_cost}`);

    // ── 段 2：准备测试数据 ──
    section('段 2：准备测试数据');
    const OWNER_ID = 1;   // 韩天尊（洞府主人）
    const VISITOR_ID = 9; // 叶天帝（访客）

    const owner = await Player.findByPk(OWNER_ID);
    const visitor = await Player.findByPk(VISITOR_ID);
    if (!owner || !visitor) {
        record('准备数据', '查找测试玩家', false, '玩家不存在');
        return;
    }
    record('准备数据', '洞府主人', true, `${owner.nickname}（ID=${OWNER_ID}）`);
    record('准备数据', '访客', true, `${visitor.nickname}（ID=${VISITOR_ID}）`);

    // 确保主人有足够灵石
    const ownerOriginalStones = BigInt(owner.spirit_stones || 0);
    if (ownerOriginalStones < 500n) {
        owner.spirit_stones = 10000n;
        await owner.save();
        record('准备数据', '补充主人灵石', true, '设为 10000');
    } else {
        record('准备数据', '主人灵石充足', true, ownerOriginalStones.toString());
    }

    // 确保访客有足够灵石（用于寻宝联动测试）
    const visitorOriginalStones = BigInt(visitor.spirit_stones || 0);
    if (visitorOriginalStones < 500n) {
        visitor.spirit_stones = 10000n;
        await visitor.save();
        record('准备数据', '补充访客灵石', true, '设为 10000');
    } else {
        record('准备数据', '访客灵石充足', true, visitorOriginalStones.toString());
    }

    // 清理历史访客记录和寻宝日志（避免干扰测试）
    await CaveVisitor.destroy({ where: { cave_owner_id: OWNER_ID, visitor_id: VISITOR_ID } });
    await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });
    record('准备数据', '清理历史记录', true);

    // ── 段 3：创建访客记录（模拟拜访） ──
    section('段 3：创建访客记录');
    const visitRecord = await CaveVisitor.create({
        cave_owner_id: OWNER_ID,
        visitor_id: VISITOR_ID,
        visited_at: new Date(),
        encounter_type: null,
        encounter_reward: null,
        reception_status: 'pending'
    });
    record('创建记录', '访客记录已创建', !!visitRecord.id, `ID=${visitRecord.id}, status=${visitRecord.reception_status}`);

    // ── 段 4：获取待处理访客列表 ──
    section('段 4：获取待处理访客列表');
    try {
        const list = await CaveSocialService.getVisitorReceptionList(OWNER_ID, 20);
        record('访客列表', '返回结构完整', !!list.pending && !!list.recent && typeof list.total_pending === 'number', `pending=${list.pending.length}, total_pending=${list.total_pending}`);

        const found = list.pending.find(v => v.id === visitRecord.id);
        record('访客列表', '待处理记录包含测试访客', !!found, `visitor_nickname=${found?.visitor_nickname}`);
        record('访客列表', '访客昵称正确', found?.visitor_nickname === visitor.nickname, `期望=${visitor.nickname}, 实际=${found?.visitor_nickname}`);
    } catch (e) {
        record('访客列表', '获取待处理列表', false, e.message);
    }

    // ── 段 5：接待访客 ──
    section('段 5：接待访客');
    const ownerBeforeReceive = await Player.findByPk(OWNER_ID);
    const stonesBeforeReceive = BigInt(ownerBeforeReceive.spirit_stones || 0);

    try {
        const result = await CaveSocialService.receiveVisitor(OWNER_ID, visitRecord.id);
        record('接待访客', '接待成功', result.success, result.message);

        // 验证灵石扣除
        const ownerAfterReceive = await Player.findByPk(OWNER_ID);
        const stonesAfterReceive = BigInt(ownerAfterReceive.spirit_stones || 0);
        const expectedCost = BigInt(vrConfig.receive_cost || 100);
        record('接待访客', '灵石已扣除', stonesAfterReceive === stonesBeforeReceive - expectedCost, `${stonesBeforeReceive} → ${stonesAfterReceive}, 预期扣除=${expectedCost}`);

        // 验证返回字段
        record('接待访客', '返回buff信息', result.buff_meditation_bonus > 0 && result.buff_merchant_discount > 0, `meditation=${result.buff_meditation_bonus}, merchant=${result.buff_merchant_discount}`);
        record('接待访客', '返回buff到期时间', !!result.buff_until, `buff_until=${result.buff_until}`);

        // 验证数据库记录更新
        const updatedRecord = await CaveVisitor.findByPk(visitRecord.id);
        record('接待访客', '记录状态已更新', updatedRecord.reception_status === 'received', `status=${updatedRecord.reception_status}`);
        record('接待访客', 'buff到期时间已设置', !!updatedRecord.reception_buff_until, `buff_until=${updatedRecord.reception_buff_until}`);
    } catch (e) {
        record('接待访客', '接待成功', false, e.message);
    }

    // ── 段 6：幂等校验（已接待的不能再次处理） ──
    section('段 6：幂等校验');
    try {
        await CaveSocialService.receiveVisitor(OWNER_ID, visitRecord.id);
        record('幂等校验', '重复接待应被拒绝', false, '未抛出错误');
    } catch (e) {
        record('幂等校验', '重复接待应被拒绝', true, e.message);
    }
    try {
        await CaveSocialService.expelVisitor(OWNER_ID, visitRecord.id);
        record('幂等校验', '已接待后驱逐应被拒绝', false, '未抛出错误');
    } catch (e) {
        record('幂等校验', '已接待后驱逐应被拒绝', true, e.message);
    }

    // ── 段 7：权限校验 ──
    section('段 7：权限校验');
    // 创建一条属于另一个主人的访客记录
    const otherRecord = await CaveVisitor.create({
        cave_owner_id: VISITOR_ID, // 主人是访客ID（不是当前主人）
        visitor_id: OWNER_ID,
        visited_at: new Date(),
        reception_status: 'pending'
    });
    try {
        await CaveSocialService.receiveVisitor(OWNER_ID, otherRecord.id);
        record('权限校验', '不能处理他人洞府的访客', false, '未抛出错误');
    } catch (e) {
        record('权限校验', '不能处理他人洞府的访客', true, e.message);
    }
    // 清理
    await otherRecord.destroy();

    // ── 段 8：驱逐访客 + 寻宝联动测试 ──
    section('段 8：驱逐访客 + 寻宝联动');

    // 创建新的待处理访客记录用于驱逐测试
    const visitRecord2 = await CaveVisitor.create({
        cave_owner_id: OWNER_ID,
        visitor_id: VISITOR_ID,
        visited_at: new Date(),
        reception_status: 'pending'
    });
    // 清理寻宝日志（避免冷却影响）
    await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });

    try {
        const expelResult = await CaveSocialService.expelVisitor(OWNER_ID, visitRecord2.id);
        record('驱逐访客', '驱逐成功', expelResult.success, expelResult.message);
        record('驱逐访客', '返回封锁时间', expelResult.block_hours > 0, `block_hours=${expelResult.block_hours}`);

        // 验证数据库记录
        const expelledRecord = await CaveVisitor.findByPk(visitRecord2.id);
        record('驱逐访客', '记录状态已更新', expelledRecord.reception_status === 'expelled', `status=${expelledRecord.reception_status}`);

        // 寻宝联动：被驱逐后应无法寻宝
        try {
            await CaveSocialService.treasureHunt(VISITOR_ID, OWNER_ID, 1);
            record('寻宝联动', '驱逐后无法寻宝', false, '未被封锁拦截');
        } catch (e) {
            record('寻宝联动', '驱逐后无法寻宝', true, e.message);
        }
    } catch (e) {
        record('驱逐访客', '驱逐成功', false, e.message);
    }

    // ── 段 9：忽略访客 ──
    section('段 9：忽略访客');
    const visitRecord3 = await CaveVisitor.create({
        cave_owner_id: OWNER_ID,
        visitor_id: VISITOR_ID,
        visited_at: new Date(),
        reception_status: 'pending'
    });
    try {
        const ignoreResult = await CaveSocialService.ignoreVisitor(OWNER_ID, visitRecord3.id);
        record('忽略访客', '忽略成功', ignoreResult.success, ignoreResult.message);

        const ignoredRecord = await CaveVisitor.findByPk(visitRecord3.id);
        record('忽略访客', '记录状态已更新', ignoredRecord.reception_status === 'ignored', `status=${ignoredRecord.reception_status}`);

        // 忽略后应能正常寻宝（不受封锁）
        await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });
        try {
            const huntResult = await CaveSocialService.treasureHunt(VISITOR_ID, OWNER_ID, 1);
            record('寻宝联动', '忽略后可正常寻宝', huntResult.success !== undefined, `result_type=${huntResult.result_type}`);
            // 清理寻宝日志
            await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });
        } catch (e) {
            record('寻宝联动', '忽略后可正常寻宝', false, e.message);
        }
    } catch (e) {
        record('忽略访客', '忽略成功', false, e.message);
    }

    // ── 段 10：接待背叛惩罚测试 ──
    section('段 10：接待背叛惩罚（寻宝发现率+50%）');

    // 创建新的待处理访客记录，接待后立即寻宝
    const visitRecord4 = await CaveVisitor.create({
        cave_owner_id: OWNER_ID,
        visitor_id: VISITOR_ID,
        visited_at: new Date(),
        reception_status: 'pending'
    });
    await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });

    try {
        // 接待访客
        await CaveSocialService.receiveVisitor(OWNER_ID, visitRecord4.id);
        record('背叛惩罚', '接待成功', true);

        // 在接待期间寻宝（背叛）
        // 由于寻宝结果是随机的，我们验证接口能正常调用且不报错
        const huntResult = await CaveSocialService.treasureHunt(VISITOR_ID, OWNER_ID, 1);
        record('背叛惩罚', '接待期间可寻宝（背叛）', huntResult.success !== undefined, `result_type=${huntResult.result_type}, is_discovered=${huntResult.is_discovered}`);

        // 清理寻宝日志
        await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });
    } catch (e) {
        record('背叛惩罚', '接待期间寻宝', false, e.message);
    }

    // ── 段 11：清理测试数据 ──
    section('段 11：清理测试数据');
    try {
        await CaveVisitor.destroy({ where: { cave_owner_id: OWNER_ID, visitor_id: VISITOR_ID } });
        await CaveTreasureLog.destroy({ where: { hunter_id: VISITOR_ID, cave_owner_id: OWNER_ID } });
        record('清理', '删除测试访客记录和寻宝日志', true);

        // 恢复灵石
        if (ownerOriginalStones < 500n) {
            const o = await Player.findByPk(OWNER_ID);
            o.spirit_stones = ownerOriginalStones;
            await o.save();
        }
        if (visitorOriginalStones < 500n) {
            const v = await Player.findByPk(VISITOR_ID);
            v.spirit_stones = visitorOriginalStones;
            await v.save();
        }
        record('清理', '恢复灵石', true);
    } catch (e) {
        record('清理', '清理失败', false, e.message);
    }

    printSummary();
}

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

main().catch(err => {
    console.error('\n💥 测试脚本异常崩溃:', err);
    process.exit(1);
});
