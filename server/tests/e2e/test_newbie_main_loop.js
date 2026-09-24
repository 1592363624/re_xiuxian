/**
 * 主循环新手线 e2e（隔离库 re_xiuxian_test）
 *
 * 走：注册 → 面板 → 静思结算 → 用物品 → PVE → 移动 → 突破 → 指归
 * 对照 docs/compose/spec/newbie-main-loop.md S2.1。
 * 运行：cd server && node tests/e2e/test_newbie_main_loop.js
 * 要求：.env 指向 re_xiuxian_test；后端已在 :5000（或改 BASE_URL）。
 * 备份字段按 tests/README.md 约定；本脚本用独立新号，结束即删。
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
const stamp = Date.now().toString(36);
// 账号规则：6-12 位英文或数字（auth 注册校验）
const USER = `nb${stamp}`.replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(6, 'x');
const PASS = 'test123456';
const NICK = `新环${stamp.slice(-4)}`;

const results = [];
function check(name, expected, actual, ok) {
    results.push({ name, expected, actual, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n  期望: ${expected}\n  实际: ${actual}`);
}

const jwt = require('jsonwebtoken');
const { signRequest, createNonce } = require('../../utils/requestSign');

function needsSign(method, p) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) return false;
    if (String(p).startsWith('/api/auth')) return false;
    return true;
}

async function api(method, p, { token, body } = {}) {
    const rawBody = body ? JSON.stringify(body) : '';
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    if (needsSign(method, p) && token) {
        const decoded = jwt.decode(token);
        const rk = decoded?.rk;
        if (!rk) throw new Error('JWT 缺少 rk，无法签名');
        const timestamp = Date.now();
        const nonce = createNonce();
        const signature = signRequest(rk, {
            method,
            url: p,
            timestamp,
            nonce,
            rawBody
        });
        headers['X-Request-Timestamp'] = String(timestamp);
        headers['X-Request-Nonce'] = nonce;
        headers['X-Request-Signature'] = signature;
    }
    const res = await fetch(`${BASE_URL}${p}`, {
        method,
        headers,
        body: rawBody || undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, json, text };
}

async function main() {
    console.log('=== 主循环新手线 e2e ===');
    console.log('BASE_URL', BASE_URL, 'user', USER);

    // 1) 注册
    const reg = await api('POST', '/api/auth/register', {
        body: { username: USER, password: PASS, nickname: NICK }
    });
    check('注册', '201 + playerId', `status=${reg.status} body=${reg.text.slice(0, 200)}`,
        reg.status === 201 && (reg.json?.playerId || reg.json?.data?.playerId));

    const playerId = reg.json?.playerId || reg.json?.data?.playerId;

    // 2) 登录
    const login = await api('POST', '/api/auth/login', {
        body: { username: USER, password: PASS }
    });
    const token = login.json?.token || login.json?.data?.token || login.json?.data?.accessToken;
    check('登录', '200 + token', `status=${login.status} hasToken=${!!token}`, login.status === 200 && !!token);
    if (!token) return finish();

    // 3) 角色面板
    const me = await api('GET', '/api/player/me', { token });
    const d = me.json?.data || {};
    check('面板 code', 200, me.json?.code, me.json?.code === 200);
    check('建号境界', '凡人', d.realm, d.realm === '凡人');
    check('建号修为', '0', String(d.exp), String(d.exp) === '0');
    check('本境界 exp_cap', '>0 且 exp_next==exp_cap', `exp_next=${d.exp_next} exp_cap=${d.exp_cap}`,
        Number(d.exp_cap) > 0 && String(d.exp_next) === String(d.exp_cap));
    check('灵根', '有 type/name', JSON.stringify(d.spirit_roots), !!(d.spirit_roots && d.spirit_roots.type));
    check('realm_rank', '0', String(d.realm_rank), Number(d.realm_rank) === 0);
    check('灵石', '>=10', String(d.spirit_stones), Number(d.spirit_stones) >= 10);

    // 4) 指归看板（应有第一环）
    // 响应形状：{ success, current_node_id, nodes, ... }（路由展开 board，无 data 包一层）
    const board = await api('GET', '/api/system-quest/board', { token });
    const bdata = board.json?.data || board.json || {};
    const currentNode = bdata.current_node_id || bdata.current?.id;
    check('指归当前环', 'zhigui_s1_*（/me 已上报 view 可推进到 first_breath）', `current=${currentNode}`,
        String(currentNode).startsWith('zhigui_s1_'));

    // 5) 静思 short（60s）——先中断结算或用 force：这里 start 后立刻 interrupt 也算 settle_cultivate
    // 为了拿到 exp_gain>0，改走：直接把 start 时间往前拨不可行；用 interrupt 按完成度折。
    // 更贴近设计：调用 settle 路径。服务端 short=60s，e2e 用 interrupt（完成度低）只验证「0 修为也能涨」不成立。
    // 因此这里改为：start short → 用后端 status；再直接调 MeditationService 结算（同步脚本内）以验证公式。
    const med = await api('POST', '/api/meditation/start', { token, body: { duration_type: 'short' } });
    check('静思 start', '200', `${med.status} ${med.text.slice(0, 160)}`, med.status === 200);

    // 强制结算：把 start/end 拨到过去后 interrupt（getStatus 不自动结算，只读快照）
    {
        const { infrastructure } = require('../../modules');
        if (typeof infrastructure.ConfigLoader.initialize === 'function') {
            await infrastructure.ConfigLoader.initialize();
        }
        const sequelize = require('../../config/database');
        const Player = require('../../models/player');
        await sequelize.authenticate();
        const p = await Player.findByPk(playerId);
        p.meditation_start_time = new Date(Date.now() - 61 * 1000);
        p.meditation_end_time = new Date(Date.now() - 1000);
        await p.save();
        const stop = await api('POST', '/api/meditation/interrupt', { token });
        const after = await Player.findByPk(playerId);
        const expNow = Number(after.exp);
        const expGain = stop.json?.data?.exp_gain ?? stop.json?.exp_gain;
        check('静思结算 0 修为也有基础修为', 'exp_gain>=2 或 exp>=2', `exp_gain=${expGain} exp=${expNow} body=${stop.text.slice(0, 180)}`,
            expNow >= 2 || Number(expGain) >= 2);
    }

    // 6) 用物品：指归第一环应已发 low_healing_pill（看板已触发 view_player_status）
    const inv = await api('GET', '/api/inventory', { token });
    const items = inv.json?.data?.items || inv.json?.items || [];
    const pill = items.find(i => i.item_key === 'low_healing_pill' && i.quantity > 0);
    if (pill) {
        // 打掉一点血再吃药，验证 hp_restore
        const sequelize = require('../../config/database');
        const Player = require('../../models/player');
        const p = await Player.findByPk(playerId);
        p.hp_current = 1;
        await p.save();
        const use = await api('POST', '/api/inventory/use', { token, body: { item_key: 'low_healing_pill', quantity: 1 } });
        const after = await Player.findByPk(playerId);
        check('用物品回血', 'hp 上升且 success', `status=${use.status} hp ${1}->${after.hp_current} body=${use.text.slice(0, 160)}`,
            use.json?.success !== false && Number(after.hp_current) > 1);
    } else {
        check('用物品前置（指归发回春丹）', '背包有 low_healing_pill', JSON.stringify(items).slice(0, 200), false);
    }

    // 7) PVE：野兔
    const enc = await api('POST', '/api/combat/encounter', { token, body: { monsterId: 'rabbit' } });
    check('PVE 遭遇', '200 且进入战斗', `status=${enc.status} ${enc.text.slice(0, 200)}`,
        enc.status === 200 && (enc.json?.in_battle || enc.json?.success || enc.json?.data?.battle || enc.json?.battle));

    let won = false;
    for (let i = 0; i < 30; i++) {
        const atk = await api('POST', '/api/combat/attack', { token, body: { action: 'attack' } });
        const j = atk.json || {};
        if (j.victory || j.battleEnded || j.data?.victory) { won = true; break; }
        if (j.defeat || j.data?.defeat) break;
        await api('POST', '/api/combat/monster-turn', { token });
    }
    check('PVE 胜利', 'victory', `won=${won}`, won);

    // 8) 移动：越国(1) → 七玄门(2)；参数名 targetMapId（灵力不足时用灵石补足）
    const move = await api('POST', '/api/map/start-move', {
        token,
        body: { targetMapId: 2 }
    });
    check('移动 start', '200', `status=${move.status} ${move.text.slice(0, 200)}`, move.status === 200 || move.json?.success);

    // 9) 突破：灌修为后 try，断言成功后 exp==0
    {
        const sequelize = require('../../config/database');
        const Player = require('../../models/player');
        const p = await Player.findByPk(playerId);
        // 凡人 exp_cap=100
        p.exp = 100n;
        p.is_meditating = false;
        p.is_secluded = false;
        await p.save();

        const bt = await api('POST', '/api/breakthrough/try', { token });
        const after = await Player.findByPk(playerId);
        const expAfter = String(after.exp);
        const okReset = bt.json?.success === true ? expAfter === '0' : true;
        check('突破 try 成功后 exp 清零', 'success→exp=0 或明确失败', `status=${bt.status} success=${bt.json?.success} exp=${expAfter} msg=${bt.json?.message}`,
            okReset && (bt.json?.success === true || bt.json?.success === false));
        if (bt.json?.success) {
            check('突破后境界', '炼气1层', after.realm, after.realm === '炼气1层');
            check('突破后 realm_rank', '1', String(after.realm_rank), Number(after.realm_rank) === 1);
        }
    }

    // 10) 指归：settle/use/pve/map 后应推进多环
    const board2 = await api('GET', '/api/system-quest/board', { token });
    const b2 = board2.json?.data || board2.json || {};
    check('指归推进', 'current 不再是第一环或已卷后', `current=${b2.current_node_id} completed=${b2.completed_count}`,
        b2.current_node_id !== 'zhigui_s1_open_eyes' || Number(b2.completed_count) > 0);

    finish(playerId);
}

async function finish(playerId) {
    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log('\n=== 汇总 ===');
    console.log(`PASS ${passed} / FAIL ${failed} / TOTAL ${results.length}`);
    for (const r of results.filter(x => !x.ok)) {
        console.log(`  FAIL ${r.name}`);
    }
    // 清理测试号（隔离库）
    try {
        if (playerId) {
            const { PlayerCascadePurge } = (() => {
                try { return require('../../game/persistence/PlayerCascadePurge'); } catch { return {}; }
            })();
            const Player = require('../../models/player');
            const p = await Player.findByPk(playerId);
            if (p) {
                if (PlayerCascadePurge?.purgePlayer) await PlayerCascadePurge.purgePlayer(playerId);
                else await p.destroy();
                console.log('已清理测试号', playerId);
            }
        }
    } catch (e) {
        console.warn('清理测试号失败（请手工删）:', e.message);
    }
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error('e2e 崩溃:', e);
    finish().catch(() => process.exit(1));
});
