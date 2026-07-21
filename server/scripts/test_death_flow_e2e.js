/**
 * 端到端死亡流程测试脚本
 *
 * 验证目标：
 *   1. 寿元耗尽死亡（LifespanService.handleLifespanEnd）字段完整性
 *   2. 战斗死亡（PlayerService.handlePlayerDeath）字段完整性
 *   3. 幂等性校验（已死亡玩家重复调用返回 null，不重复扣修为）
 *   4. 修为损失率正确（默认 10%）
 *   5. HP 归零
 *   6. is_dead / death_reason / death_time 字段正确落库
 *   7. /api/player/me 接口返回 is_dead=true（前端 DeathOverlay 据此渲染）
 *   8. 数据还原（避免污染测试账号）
 *
 * 运行方式：node scripts/test_death_flow_e2e.js
 */
'use strict';

const path = require('path');
const axios = require('axios');

// 配置
const API_BASE = process.env.API_BASE || 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

// 颜色辅助
const C = {
    green: s => `\x1b[32m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    cyan: s => `\x1b[36m${s}\x1b[0m`,
    gray: s => `\x1b[90m${s}\x1b[0m`
};

// 测试统计
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log(C.green('  ✓ ') + msg);
    } else {
        failed++;
        failures.push(msg);
        console.log(C.red('  ✗ ') + msg);
    }
}

async function main() {
    console.log(C.cyan('═══════════════════════════════════════════════════════════'));
    console.log(C.cyan('  端到端死亡流程测试 - LifespanService + PlayerService'));
    console.log(C.cyan('═══════════════════════════════════════════════════════════\n'));

    // 引入服务（必须在 modules 初始化之后）
    const rootDir = path.resolve(__dirname, '..');
    process.chdir(rootDir);
    require('dotenv').config();

    const { infrastructure } = require('../modules');
    const configLoader = infrastructure.ConfigLoader;
    await configLoader.loadAllConfigs();

    const Player = require('../models/player');
    const sequelize = require('../config/database');
    const LifespanService = require('../game/core/LifespanService');
    const PlayerService = require('../game/core/PlayerService');

    // ========== 登录获取 token ==========
    console.log(C.yellow('▶ 步骤 0: 登录获取 token'));
    let token = null;
    try {
        const r = await axios.post(`${API_BASE}/api/auth/login`, {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        token = r.data.token;
        assert(!!token, '登录成功，获取 token');
    } catch (e) {
        console.log(C.red('登录失败: ' + e.message));
        process.exit(1);
    }
    const authHeaders = { Authorization: `Bearer ${token}` };

    // ========== 备份玩家完整状态 ==========
    console.log(C.yellow('\n▶ 步骤 1: 备份玩家完整状态（避免污染测试账号）'));
    const player = await Player.findByPk(1);
    if (!player) {
        console.log(C.red('玩家 ID=1 不存在'));
        process.exit(1);
    }

    // 完整字段备份（包含 B46 教训：必须备份所有可能被改动的字段）
    const backup = {
        exp: player.exp,
        hp_current: player.hp_current,
        mp_current: player.mp_current,
        lifespan_current: player.lifespan_current,
        lifespan_max: player.lifespan_max,
        is_dead: player.is_dead,
        death_reason: player.death_reason,
        death_time: player.death_time,
        realm: player.realm,
        realm_rank: player.realm_rank,
        role: player.role,
        attributes: player.attributes,
        is_secluded: player.is_secluded,
        is_meditating: player.is_meditating,
        bottleneck_state: player.bottleneck_state,
        bottleneck_insight: player.bottleneck_insight,
        weakness_end_time: player.weakness_end_time,
        seclusion_end_time: player.seclusion_end_time,
        last_seclusion_time: player.last_seclusion_time
    };
    console.log(C.gray(`  备份：exp=${backup.exp}, lifespan=${backup.lifespan_current}/${backup.lifespan_max}, is_dead=${backup.is_dead}, realm=${backup.realm}(rank=${backup.realm_rank})`));
    assert(true, '玩家完整状态已备份');

    // 读取死亡损失率配置
    const gameBalanceConfig = configLoader.getConfig('game_balance');
    const expectedLossRate = gameBalanceConfig?.lifespan?.death_exp_loss_rate ?? 0.1;
    console.log(C.gray(`  配置：death_exp_loss_rate=${expectedLossRate}`));

    try {
        // ========== 场景1：寿元耗尽死亡 ==========
        console.log(C.yellow('\n▶ 步骤 2: 寿元耗尽死亡（LifespanService.handleLifespanEnd）'));

        // 先清除可能存在的死亡状态
        if (player.is_dead) {
            player.is_dead = false;
            player.death_reason = null;
            player.death_time = null;
            await player.save();
            console.log(C.gray('  已清除原有死亡状态'));
        }

        // 模拟寿元耗尽：lifespan_current = lifespan_max
        player.lifespan_current = player.lifespan_max;
        await player.save();

        const expBeforeDeath1 = BigInt(player.exp);
        console.log(C.gray(`  死亡前：exp=${expBeforeDeath1.toString()}, lifespan=${player.lifespan_current}/${player.lifespan_max}`));

        // 调用 handleLifespanEnd
        const deathInfo1 = await LifespanService.handleLifespanEnd(player);
        assert(deathInfo1 !== null, '寿元耗尽死亡触发，返回非 null');
        assert(deathInfo1.playerId === 1, '死亡信息 playerId=1');
        assert(deathInfo1.reason === undefined || typeof deathInfo1.message === 'string', '死亡信息包含 message');

        // 重新查询验证字段
        const deadPlayer1 = await Player.findByPk(1);
        assert(deadPlayer1.is_dead === true, 'is_dead=true 已落库');
        assert(deadPlayer1.death_reason === '寿元耗尽', `death_reason='寿元耗尽'（实际: ${deadPlayer1.death_reason}）`);
        assert(deadPlayer1.death_time !== null, 'death_time 已记录');
        assert(deadPlayer1.lifespan_current === deadPlayer1.lifespan_max, 'lifespan_current 定格在 max');

        // 修为损失验证
        const expAfterDeath1 = BigInt(deadPlayer1.exp);
        const expectedLoss1 = expBeforeDeath1 * BigInt(Math.round(expectedLossRate * 100)) / 100n;
        const expectedExp1 = expBeforeDeath1 - expectedLoss1;
        assert(expAfterDeath1 === expectedExp1, `修为损失 ${(expectedLossRate * 100).toFixed(0)}%（${expBeforeDeath1.toString()} → ${expAfterDeath1.toString()}，预期 ${expectedExp1.toString()}）`);

        // HP 归零
        assert(Number(deadPlayer1.hp_current) === 0, `HP 归零（实际: ${deadPlayer1.hp_current}）`);

        console.log(C.gray(`  死亡后：exp=${expAfterDeath1.toString()}, is_dead=${deadPlayer1.is_dead}, reason=${deadPlayer1.death_reason}`));

        // ========== 幂等性测试 ==========
        console.log(C.yellow('\n▶ 步骤 3: 幂等性测试（已死亡玩家重复调用应返回 null）'));
        const deathInfo1Repeat = await LifespanService.handleLifespanEnd(deadPlayer1);
        assert(deathInfo1Repeat === null, '已死亡玩家再次调用 handleLifespanEnd 返回 null');

        // 验证修为没有再次扣减
        const deadPlayer1AfterRepeat = await Player.findByPk(1);
        const expAfterRepeat = BigInt(deadPlayer1AfterRepeat.exp);
        assert(expAfterRepeat === expAfterDeath1, '重复调用未再次扣减修为');

        // ========== /api/player/me 验证 ==========
        console.log(C.yellow('\n▶ 步骤 4: 验证 /api/player/me 返回 is_dead=true（前端 DeathOverlay 据此渲染）'));
        const meResp1 = await axios.get(`${API_BASE}/api/player/me`, { headers: authHeaders });
        assert(meResp1.data?.code === 200, '/api/player/me 响应 code=200');
        assert(meResp1.data?.data?.is_dead === true, '接口返回 is_dead=true');
        assert(meResp1.data?.data?.death_reason === '寿元耗尽', `接口返回 death_reason='寿元耗尽'（实际: ${meResp1.data?.data?.death_reason}）`);
        assert(meResp1.data?.data?.death_time !== null, '接口返回 death_time 非 null');
        assert(meResp1.data?.data?.lifespan_current === meResp1.data?.data?.lifespan_max, '接口返回 lifespan_current=lifespan_max');
        console.log(C.gray(`  接口返回：is_dead=${meResp1.data?.data?.is_dead}, death_reason=${meResp1.data?.data?.death_reason}`));

        // ========== 场景2：战斗死亡 ==========
        console.log(C.yellow('\n▶ 步骤 5: 战斗死亡场景（PlayerService.handlePlayerDeath）'));

        // 先重置玩家状态（清除寿元死亡标记，准备战斗死亡测试）
        // 直接通过数据库重置，因为我们需要模拟"活着但被战斗打死"的场景
        await sequelize.query(
            `UPDATE players SET is_dead=false, death_reason=NULL, death_time=NULL, lifespan_current=:lsCurr WHERE id=1`,
            { replacements: { lsCurr: backup.lifespan_current }, type: sequelize.QueryTypes.UPDATE }
        );

        const player2 = await Player.findByPk(1);
        const expBeforeDeath2 = BigInt(player2.exp);
        console.log(C.gray(`  战斗前：exp=${expBeforeDeath2.toString()}, is_dead=${player2.is_dead}`));

        // 调用 handlePlayerDeath
        const deathInfo2 = await PlayerService.handlePlayerDeath(1, '战斗陨落');
        assert(deathInfo2 !== null, '战斗死亡触发，返回非 null');
        assert(deathInfo2.reason === '战斗陨落', `reason='战斗陨落'（实际: ${deathInfo2.reason}）`);
        assert(typeof deathInfo2.expLoss === 'string', 'expLoss 为字符串（BIGINT）');

        // 重新查询验证字段
        const deadPlayer2 = await Player.findByPk(1);
        assert(deadPlayer2.is_dead === true, '战斗死亡 is_dead=true');
        assert(deadPlayer2.death_reason === '战斗陨落', `death_reason='战斗陨落'（实际: ${deadPlayer2.death_reason}）`);
        assert(deadPlayer2.death_time !== null, 'death_time 已记录');

        // 修为损失
        const expAfterDeath2 = BigInt(deadPlayer2.exp);
        const expectedLoss2 = expBeforeDeath2 * BigInt(Math.round(expectedLossRate * 100)) / 100n;
        const expectedExp2 = expBeforeDeath2 - expectedLoss2;
        assert(expAfterDeath2 === expectedExp2, `战斗死亡修为损失 ${(expectedLossRate * 100).toFixed(0)}%（${expBeforeDeath2.toString()} → ${expAfterDeath2.toString()}）`);

        // HP 归零
        assert(Number(deadPlayer2.hp_current) === 0, `战斗死亡 HP 归零（实际: ${deadPlayer2.hp_current}）`);

        // 战斗死亡增加寿元消耗
        const ageIncrease = gameBalanceConfig?.death?.age_increase ?? 10;
        const expectedAge2 = Number(backup.lifespan_current) + ageIncrease;
        assert(Math.abs(Number(deadPlayer2.lifespan_current) - expectedAge2) < 0.001, `战斗死亡寿元增加 ${ageIncrease}（${backup.lifespan_current} → ${deadPlayer2.lifespan_current}）`);

        console.log(C.gray(`  战斗死亡后：exp=${expAfterDeath2.toString()}, lifespan=${deadPlayer2.lifespan_current}/${deadPlayer2.lifespan_max}`));

        // ========== 幂等性测试（战斗死亡）==========
        console.log(C.yellow('\n▶ 步骤 6: 战斗死亡幂等性测试'));
        const deathInfo2Repeat = await PlayerService.handlePlayerDeath(1, '战斗陨落');
        assert(deathInfo2Repeat === null, '已死亡玩家再次调用 handlePlayerDeath 返回 null');

        // ========== /api/player/me 战斗死亡验证 ==========
        console.log(C.yellow('\n▶ 步骤 7: 验证 /api/player/me 返回战斗死亡状态'));
        const meResp2 = await axios.get(`${API_BASE}/api/player/me`, { headers: authHeaders });
        assert(meResp2.data?.data?.is_dead === true, '接口返回 is_dead=true');
        assert(meResp2.data?.data?.death_reason === '战斗陨落', `接口返回 death_reason='战斗陨落'（实际: ${meResp2.data?.data?.death_reason}）`);

        // ========== 轮回重生接口测试 ==========
        console.log(C.yellow('\n▶ 步骤 8: 轮回重生接口测试（/api/player/reincarnate）'));
        const reincarnateResp = await axios.post(`${API_BASE}/api/player/reincarnate`, {}, { headers: authHeaders });
        assert(reincarnateResp.data?.code === 200, '轮回重生接口返回 code=200');

        const player3 = await Player.findByPk(1);
        assert(player3.is_dead === false, '轮回后 is_dead=false');
        assert(player3.death_reason === null, '轮回后 death_reason=null');
        assert(player3.death_time === null, '轮回后 death_time=null');
        assert(player3.realm === '凡人' || player3.realm_rank === 0, `轮回后境界重置（realm=${player3.realm}, rank=${player3.realm_rank}）`);
        console.log(C.gray(`  轮回后：realm=${player3.realm}, rank=${player3.realm_rank}, is_dead=${player3.is_dead}`));

        // 轮回后 /api/player/me 不应触发 DeathOverlay
        const meResp3 = await axios.get(`${API_BASE}/api/player/me`, { headers: authHeaders });
        assert(meResp3.data?.data?.is_dead === false, '轮回后 /api/player/me is_dead=false');

    } catch (err) {
        console.log(C.red('\n测试过程异常: ' + err.message));
        console.error(err);
    } finally {
        // ========== 还原玩家完整状态 ==========
        console.log(C.yellow('\n▶ 步骤 9: 还原玩家完整状态'));
        try {
            // 使用直接 SQL 还原所有备份字段（避免 Sequelize 钩子或类型转换问题）
            await sequelize.query(
                `UPDATE players SET
                    exp=:exp,
                    hp_current=:hpCurrent,
                    mp_current=:mpCurrent,
                    lifespan_current=:lsCurr,
                    lifespan_max=:lsMax,
                    is_dead=:isDead,
                    death_reason=:deathReason,
                    death_time=:deathTime,
                    realm=:realm,
                    realm_rank=:realmRank,
                    role=:role,
                    attributes=:attrs,
                    is_secluded=:isSecluded,
                    is_meditating=:isMeditating,
                    bottleneck_state=:bottleneckState,
                    bottleneck_insight=:bottleneckInsight,
                    weakness_end_time=:weaknessEndTime,
                    seclusion_end_time=:seclusionEndTime,
                    last_seclusion_time=:lastSeclusionTime
                 WHERE id=1`,
                {
                    replacements: {
                        exp: backup.exp.toString(),
                        hpCurrent: backup.hp_current.toString(),
                        mpCurrent: backup.mp_current.toString(),
                        lsCurr: backup.lifespan_current,
                        lsMax: backup.lifespan_max,
                        isDead: backup.is_dead ? 1 : 0,
                        deathReason: backup.death_reason,
                        deathTime: backup.death_time,
                        realm: backup.realm,
                        realmRank: backup.realm_rank,
                        role: backup.role,
                        attrs: typeof backup.attributes === 'object' ? JSON.stringify(backup.attributes) : backup.attributes,
                        isSecluded: backup.is_secluded ? 1 : 0,
                        isMeditating: backup.is_meditating ? 1 : 0,
                        bottleneckState: backup.bottleneck_state,
                        bottleneckInsight: backup.bottleneck_insight,
                        weaknessEndTime: backup.weakness_end_time,
                        seclusionEndTime: backup.seclusion_end_time,
                        lastSeclusionTime: backup.last_seclusion_time
                    },
                    type: sequelize.QueryTypes.UPDATE
                }
            );

            const restored = await Player.findByPk(1);
            assert(restored.exp === backup.exp, `exp 已还原（${restored.exp}）`);
            assert(restored.lifespan_current === backup.lifespan_current, `lifespan_current 已还原（${restored.lifespan_current}）`);
            assert(restored.is_dead === false, 'is_dead 已还原为 false');
            assert(restored.death_reason === null, 'death_reason 已还原为 null');
            assert(restored.realm === backup.realm, `realm 已还原（${restored.realm}）`);
            assert(restored.realm_rank === backup.realm_rank, `realm_rank 已还原（${restored.realm_rank}）`);
            console.log(C.gray(`  还原后：realm=${restored.realm}, rank=${restored.realm_rank}, exp=${restored.exp}, is_dead=${restored.is_dead}`));
        } catch (e) {
            console.log(C.red('还原失败: ' + e.message));
            console.error(e);
        }

        // ========== 输出测试结果 ==========
        console.log(C.cyan('\n═══════════════════════════════════════════════════════════'));
        console.log(C.cyan('  测试结果汇总'));
        console.log(C.cyan('═══════════════════════════════════════════════════════════'));
        console.log(C.green(`  通过: ${passed}`) + C.red(`  失败: ${failed}`));
        if (failures.length > 0) {
            console.log(C.red('\n  失败项:'));
            failures.forEach((f, i) => console.log(C.red(`    ${i + 1}. ${f}`)));
        }
        console.log();
        process.exit(failed > 0 ? 1 : 0);
    }
}

main().catch(err => {
    console.error(C.red('脚本异常:'), err);
    process.exit(1);
});
