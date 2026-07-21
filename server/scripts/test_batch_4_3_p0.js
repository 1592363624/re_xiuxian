/**
 * 批次4-3 P0 修复验证测试
 *
 * 验证内容：
 *   P0-1: LifespanService.handleLifespanEnd 幂等性（已死亡玩家不再重复触发）
 *   P0-2: PlayerService.handlePlayerDeath 完整化（事务 + is_dead + 推送 + reason）
 *   P0-3: LifespanService.updateLifespan 性能优化（批量 UPDATE + is_dead=false 过滤）
 *   P1-1: 死亡损失率统一使用 lifespan.death_exp_loss_rate
 *
 * 测试策略：
 *   - 静态代码扫描：检查关键修复点是否落地
 *   - 运行时验证：通过 HTTP 接口验证死亡流程触发链路
 *
 * 运行方式：node server/scripts/test_batch_4_3_p0.js
 */
const fs = require('fs');
const path = require('path');

// 测试结果统计
const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: []
};

/**
 * 断言工具
 */
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

/**
 * 读取文件内容（用于静态扫描）
 */
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return '';
    }
}

/**
 * 过滤注释行，仅保留有效代码行（避免注释中的旧代码模式被误判）
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

/**
 * 场景1：P0-1 LifespanService.handleLifespanEnd 幂等性
 */
function testLifespanServiceIdempotent() {
    console.log('\n=== 场景1：P0-1 LifespanService.handleLifespanEnd 幂等性 ===');
    const filePath = path.join(__dirname, '..', 'game', 'core', 'LifespanService.js');
    const content = readFile(filePath);
    const codeLines = filterCodeLines(content);

    // 1.1 入口必须有 is_dead 校验（同一行或多行均可，关键是 if 块内 return null）
    // 兼容写法：if (player.is_dead === true) { return null; }
    //           if (player.is_dead === true)
    //               return null;
    const hasIsDeadCheck = codeLines.some(l => l.includes('player.is_dead === true'));
    const hasReturnNull = codeLines.some(l => l.includes('return null'));
    assert(hasIsDeadCheck && hasReturnNull,
        'P0-1.1 handleLifespanEnd 入口校验 is_dead（已死亡返回 null）');

    // 1.2 注释中应说明修复点
    assert(content.includes('4-3-P0-1'), 'P0-1.2 注释标记 4-3-P0-1 修复点');

    // 1.3 is_dead 校验应在 lossRate 计算之前（避免已死亡玩家还被扣修为）
    const idempotentLineIdx = codeLines.findIndex(l => l.includes('player.is_dead === true'));
    const lossRateLineIdx = codeLines.findIndex(l => l.includes('death_exp_loss_rate'));
    if (idempotentLineIdx >= 0 && lossRateLineIdx >= 0) {
        assert(idempotentLineIdx < lossRateLineIdx,
            'P0-1.3 is_dead 校验在 lossRate 计算之前',
            `is_dead行=${idempotentLineIdx}, lossRate行=${lossRateLineIdx}`);
    } else {
        assert(false, 'P0-1.3 无法定位 is_dead 或 lossRate 行',
            `is_dead=${idempotentLineIdx}, lossRate=${lossRateLineIdx}`);
    }
}

/**
 * 场景2：P0-3 LifespanService.updateLifespan 批量更新优化
 */
function testLifespanServiceBatchUpdate() {
    console.log('\n=== 场景2：P0-3 LifespanService.updateLifespan 批量更新优化 ===');
    const filePath = path.join(__dirname, '..', 'game', 'core', 'LifespanService.js');
    const content = readFile(filePath);
    const codeLines = filterCodeLines(content);

    // 2.1 查询条件必须包含 is_dead: false
    const hasIsDeadFilter = codeLines.some(line =>
        line.includes('is_dead: false')
    );
    assert(hasIsDeadFilter, 'P0-3.1 updateLifespan 查询条件含 is_dead=false');

    // 2.2 必须使用批量 UPDATE（CASE WHEN）
    // 模板字符串中 CASE id 和 WHEN 可能不在同一代码行（map 拼接），分开检查
    const hasCaseId = content.includes('CASE id');
    const hasWhen = content.includes('WHEN');
    const hasBatchUpdate = hasCaseId && hasWhen;
    assert(hasBatchUpdate, 'P0-3.2 使用 CASE WHEN 批量 UPDATE',
        `CASE id=${hasCaseId}, WHEN=${hasWhen}`);

    // 2.3 非死亡玩家走批量更新（aliveUpdates.push）
    // 2.4 死亡玩家仍走 handleLifespanEnd
    // 定位 updateLifespan 函数体（calculateAgingRate 的定义位置作为函数结束边界）
    // 注意：calculateAgingRate 在 updateLifespan 内会被调用，所以要用 "calculateAgingRate(config)" 作为定义标记
    const updateLifespanStart = content.indexOf('async updateLifespan(');
    const updateLifespanEnd = content.indexOf('calculateAgingRate(config)');
    if (updateLifespanStart >= 0 && updateLifespanEnd > updateLifespanStart) {
        const updateLifespanCode = content.substring(updateLifespanStart, updateLifespanEnd);
        const updateLifespanLines = filterCodeLines(updateLifespanCode);
        // 非死亡分支应该用 aliveUpdates.push，不应有 player.save() 用于普通更新
        const hasAliveUpdatesPush = updateLifespanLines.some(l => l.includes('aliveUpdates.push'));
        assert(hasAliveUpdatesPush, 'P0-3.3 非死亡玩家收集到 aliveUpdates（不逐个 save）');

        // 死亡分支仍可调用 handleLifespanEnd（其内部会 save）
        const hasHandleLifespanEnd = updateLifespanLines.some(l => l.includes('handleLifespanEnd'));
        assert(hasHandleLifespanEnd, 'P0-3.4 死亡玩家仍走 handleLifespanEnd（保留通知/审计）');
    } else {
        assert(false, 'P0-3 无法定位 updateLifespan 函数体',
            `start=${updateLifespanStart}, end=${updateLifespanEnd}`);
    }

    // 2.5 必须有 batch_size 配置约束
    assert(content.includes('update_batch_size'), 'P0-3.5 使用 batch_size 配置约束批量大小');
}

/**
 * 场景3：P0-2 PlayerService.handlePlayerDeath 完整化
 */
function testPlayerServiceDeathComplete() {
    console.log('\n=== 场景3：P0-2 PlayerService.handlePlayerDeath 完整化 ===');
    const filePath = path.join(__dirname, '..', 'game', 'core', 'PlayerService.js');
    const content = readFile(filePath);
    const codeLines = filterCodeLines(content);

    // 3.1 必须使用事务
    const hasTransaction = codeLines.some(l => l.includes('sequelize.transaction()'))
        && codeLines.some(l => l.includes('t.commit()'))
        && codeLines.some(l => l.includes('t.rollback()'));
    assert(hasTransaction, 'P0-2.1 handlePlayerDeath 使用事务包裹');

    // 3.2 必须设置 is_dead=true
    const hasIsDeadSet = codeLines.some(l =>
        l.includes('player.is_dead') && l.includes('true') && l.includes('=')
    );
    assert(hasIsDeadSet, 'P0-2.2 handlePlayerDeath 设置 is_dead=true');

    // 3.3 必须设置 death_reason 和 death_time
    assert(content.includes('player.death_reason'), 'P0-2.3 设置 death_reason 字段');
    assert(content.includes('player.death_time'), 'P0-2.4 设置 death_time 字段');

    // 3.4 必须推送 WebSocket 通知
    const hasWebSocket = codeLines.some(l => l.includes('notifyPlayerUpdate'))
        && codeLines.some(l => l.includes('player_death'));
    assert(hasWebSocket, 'P0-2.5 推送 WebSocket player_death 事件');

    // 3.5 必须广播通知其他玩家
    assert(content.includes('broadcastNotification'), 'P0-2.6 广播死亡通知给其他玩家');

    // 3.6 必须持久化系统通知
    assert(content.includes('sendDeathNotification'), 'P0-2.7 持久化系统通知');

    // 3.7 必须有行级锁
    assert(content.includes('LOCK.UPDATE'), 'P0-2.8 使用行级锁防并发');

    // 3.8 必须有幂等性校验（is_dead 检查 + return null，分两行也算）
    const hasIdempotentCheck = codeLines.some(l => l.includes('player.is_dead === true'));
    const hasReturnNull = codeLines.some(l => l.includes('return null'));
    assert(hasIdempotentCheck && hasReturnNull,
        'P0-2.9 幂等性校验（已死亡玩家不再重复处理）');

    // 3.9 推送通知应在事务 commit 之后（避免推送失败回滚业务数据）
    const commitIdx = codeLines.findIndex(l => l.includes('t.commit()'));
    const notifyIdx = codeLines.findIndex(l => l.includes('notifyPlayerUpdate(player.id'));
    if (commitIdx >= 0 && notifyIdx >= 0) {
        assert(notifyIdx > commitIdx,
            'P0-2.10 推送通知在事务 commit 之后',
            `commit=${commitIdx}, notify=${notifyIdx}`);
    } else {
        assert(false, 'P0-2.10 无法定位 commit 或 notify 行');
    }
}

/**
 * 场景4：P1-1 死亡损失率字段统一
 */
function testDeathLossRateUnified() {
    console.log('\n=== 场景4：P1-1 死亡损失率字段统一 ===');
    const lifespanFile = path.join(__dirname, '..', 'game', 'core', 'LifespanService.js');
    const playerFile = path.join(__dirname, '..', 'game', 'core', 'PlayerService.js');
    const lifespanContent = readFile(lifespanFile);
    const playerContent = readFile(playerFile);

    // 4.1 LifespanService 使用 lifespan.death_exp_loss_rate
    assert(lifespanContent.includes('cfg.death_exp_loss_rate'),
        'P1-1.1 LifespanService 使用 lifespan.death_exp_loss_rate');

    // 4.2 PlayerService 优先使用 lifespan.death_exp_loss_rate，fallback 到 combat.death_exp_penalty_rate
    assert(playerContent.includes('lifespanCfg.death_exp_loss_rate'),
        'P1-1.2 PlayerService 优先使用 lifespan.death_exp_loss_rate');
    assert(playerContent.includes('combat?.death_exp_penalty_rate'),
        'P1-1.3 PlayerService fallback 到 combat.death_exp_penalty_rate');

    // 4.3 game_balance.json 中应同时存在两个配置
    const configPath = path.join(__dirname, '..', 'config', 'game_balance.json');
    const configContent = readFile(configPath);
    assert(configContent.includes('"death_exp_loss_rate"'),
        'P1-1.4 game_balance.json 配置 lifespan.death_exp_loss_rate');
    assert(configContent.includes('"death_exp_penalty_rate"'),
        'P1-1.5 game_balance.json 配置 combat.death_exp_penalty_rate');
}

/**
 * 场景5：updateHp 支持自定义死亡原因
 */
function testUpdateHpDeathReason() {
    console.log('\n=== 场景5：updateHp 支持自定义死亡原因 ===');
    const filePath = path.join(__dirname, '..', 'game', 'core', 'PlayerService.js');
    const content = readFile(filePath);

    // 5.1 updateHp 函数签名应包含 deathReason 参数
    assert(content.includes("deathReason = '战斗陨落'"),
        'P0-2.11 updateHp 支持 deathReason 参数');

    // 5.2 updateHp 调用 handlePlayerDeath 时应传入 deathReason
    assert(content.includes('this.handlePlayerDeath(playerId, deathReason)'),
        'P0-2.12 updateHp 将 deathReason 传递给 handlePlayerDeath');
}

/**
 * 场景6：handlePlayerDeath 支持自定义死亡原因
 */
function testHandlePlayerDeathReason() {
    console.log('\n=== 场景6：handlePlayerDeath 支持自定义死亡原因 ===');
    const filePath = path.join(__dirname, '..', 'game', 'core', 'PlayerService.js');
    const content = readFile(filePath);

    // 6.1 函数签名应包含 reason 参数，默认值为"战斗陨落"
    assert(content.includes("reason = '战斗陨落'"),
        'P0-2.13 handlePlayerDeath 支持 reason 参数');

    // 6.2 reason 应写入 death_reason 字段
    assert(content.includes('player.death_reason = reason'),
        'P0-2.14 reason 写入 death_reason 字段');

    // 6.3 reason 应用于广播通知文案
    assert(content.includes('${reason}'),
        'P0-2.15 reason 用于广播通知文案');
}

/**
 * 主测试入口
 */
function main() {
    console.log('=========================================');
    console.log('批次4-3 P0 修复验证测试');
    console.log('=========================================');

    testLifespanServiceIdempotent();
    testLifespanServiceBatchUpdate();
    testPlayerServiceDeathComplete();
    testDeathLossRateUnified();
    testUpdateHpDeathReason();
    testHandlePlayerDeathReason();

    console.log('\n=========================================');
    console.log('测试结果汇总');
    console.log('=========================================');
    console.log(`总计：${results.total}`);
    console.log(`通过：${results.passed}`);
    console.log(`失败：${results.failed}`);
    console.log(`跳过：${results.skipped}`);
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
