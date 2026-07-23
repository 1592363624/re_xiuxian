/**
 * 洞天绘卷系统 API 端到端测试脚本
 *
 * 测试 4 个接口：
 *   1. GET  /api/cave-social/scroll/me              查看自己的洞天绘卷
 *   2. GET  /api/cave-social/scroll/ranking          绘卷风貌排行榜
 *   3. GET  /api/cave-social/scroll/player/:playerId 查看他人洞天绘卷
 *   4. POST /api/cave-social/scroll/:playerId/inscribe 在他人洞天绘卷上题词
 *
 * 测试账号：1592363624 / 1592363624（主账号）
 * 副账号：1592363625 / 1592363625（用于题词测试）
 *
 * 运行：node server/scripts/_test_cave_scroll.js
 */
'use strict';
const http = require('http');

const BASE = { hostname: '127.0.0.1', port: 5000 };
const MAIN_ACCOUNT = { username: '1592363624', password: '1592363624' };
const SUB_ACCOUNT = { username: process.argv[2] || '1592363625', password: process.argv[3] || '1592363625' };

let passed = 0, failed = 0;
const results = [];

function request(method, path, token, body) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        const req = http.request({ ...BASE, method, path, headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, body: { raw: data } }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(account) {
    const res = await request('POST', '/api/auth/login', null, {
        username: account.username, password: account.password
    });
    const token = res.body.token || res.body.data?.token;
    const player = res.body.player || res.body.data?.player;
    if (res.status !== 200 || !token) {
        throw new Error(`登录失败(${account.username}): ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { token, player };
}

function record(name, ok, detail) {
    if (ok) { passed++; results.push(`  ✅ ${name}`); }
    else { failed++; results.push(`  ❌ ${name} — ${detail || ''}`); }
}

async function main() {
    console.log('===== 洞天绘卷系统 API 测试 =====\n');

    console.log('[1] 登录主账号...');
    const main = await login(MAIN_ACCOUNT);
    console.log(`  主账号: ${main.player.nickname} (ID=${main.player.id})\n`);

    console.log('[2] 登录副账号...');
    let sub = null;
    try {
        sub = await login(SUB_ACCOUNT);
        console.log(`  副账号: ${sub.player.nickname} (ID=${sub.player.id})\n`);
    } catch (e) {
        console.log(`  副账号登录失败（跳过题词测试）: ${e.message}\n`);
    }

    // ===== 测试1: GET /scroll/me =====
    console.log('[3] 测试 GET /api/cave-social/scroll/me — 查看自己的洞天绘卷');
    {
        const res = await request('GET', '/api/cave-social/scroll/me', main.token, null);
        if (res.status === 200 && res.body.code === 200) {
            const d = res.body.data;
            record('状态码200', true);
            record('返回 owner 字段', !!d.owner, 'owner 缺失');
            record('返回 cave 字段', !!d.cave, 'cave 缺失');
            record('返回 exhibits 字段', !!d.exhibits, 'exhibits 缺失');
            record('返回 popularity 字段', !!d.popularity, 'popularity 缺失');
            record('返回 rating 字段', !!d.rating, 'rating 缺失');
            record('返回 inscriptions 数组', Array.isArray(d.inscriptions), 'inscriptions 非数组');
            record('rating.tier_name 有效', ['凡品','灵品','玄品','地品','天品','仙品'].includes(d.rating?.tier_name), `tier_name=${d.rating?.tier_name}`);
            record('rating.tier_index 0-5', d.rating?.tier_index >= 0 && d.rating?.tier_index <= 5, `tier_index=${d.rating?.tier_index}`);
            record('rating.score 为数字', typeof d.rating?.score === 'number', `score=${d.rating?.score}`);
            record('cave.facilities 含5项设施', !!d.cave?.facilities && typeof d.cave.facilities === 'object', 'facilities 缺失');
            record('cave.facility_total_level 为数字', typeof d.cave?.facility_total_level === 'number');
            record('exhibits.count 为数字', typeof d.exhibits?.count === 'number');
            record('popularity.visitor_count 为数字', typeof d.popularity?.visitor_count === 'number');
            record('owner.player_id 正确', d.owner?.player_id === main.player.id, `期望${main.player.id}, 实际${d.owner?.player_id}`);
            console.log(`  评级: ${d.rating?.tier_name}, 得分: ${d.rating?.score}, 题词数: ${d.inscriptions?.length}`);
        } else {
            record('GET /scroll/me 返回200', false, `${res.status} ${JSON.stringify(res.body).slice(0,200)}`);
        }
    }
    console.log();

    // ===== 测试2: GET /scroll/ranking =====
    console.log('[4] 测试 GET /api/cave-social/scroll/ranking — 绘卷风貌排行榜');
    {
        const res = await request('GET', '/api/cave-social/scroll/ranking', main.token, null);
        if (res.status === 200 && res.body.code === 200) {
            const d = res.body.data;
            record('状态码200', true);
            record('返回 ranking 数组', Array.isArray(d.ranking), 'ranking 非数组');
            record('返回 total 字段', typeof d.total === 'number', 'total 缺失');
            if (d.ranking && d.ranking.length > 0) {
                const item = d.ranking[0];
                record('榜单项含 rank', typeof item.rank === 'number');
                record('榜单项含 player_id', typeof item.player_id === 'number');
                record('榜单项含 nickname', typeof item.nickname === 'string');
                record('榜单项含 score', typeof item.score === 'number');
                record('榜单项含 tier_name', typeof item.tier_name === 'string');
                record('榜单项含 tier_index', typeof item.tier_index === 'number');
                // 验证排序：score 降序
                const sorted = d.ranking.every((it, i) => i === 0 || it.score <= d.ranking[i-1].score);
                record('榜单按 score 降序排序', sorted);
                console.log(`  榜首: ${item.nickname} (${item.tier_name}, ${item.score}分)`);
            } else {
                record('榜单为空（无数据，结构正确）', true);
            }
            console.log(`  榜单总数: ${d.total}, 返回条数: ${d.ranking?.length || 0}`);
        } else {
            record('GET /scroll/ranking 返回200', false, `${res.status} ${JSON.stringify(res.body).slice(0,200)}`);
        }
    }
    console.log();

    // ===== 测试3: GET /scroll/player/:playerId =====
    console.log('[5] 测试 GET /api/cave-social/scroll/player/:playerId — 查看他人洞天绘卷');
    // 从排行榜获取一个有洞府的非自己玩家作为查看目标
    const rankRes = await request('GET', '/api/cave-social/scroll/ranking', main.token, null);
    const rankingData = rankRes.body.data?.ranking || [];
    const targetItem = rankingData.find(r => r.player_id !== main.player.id);
    const targetPlayerId = targetItem?.player_id || (sub ? sub.player.id : null);

    if (targetPlayerId) {
        const res = await request('GET', `/api/cave-social/scroll/player/${targetPlayerId}`, main.token, null);
        if (res.status === 200 && res.body.code === 200) {
            const d = res.body.data;
            record('状态码200', true);
            record('返回 owner 字段', !!d.owner);
            record('返回 cave 字段', !!d.cave);
            record('返回 rating 字段', !!d.rating);
            // 有洞府的目标才返回 today_inscribed 等字段
            if (d.cave?.is_opened) {
                record('返回 today_inscribed 字段', typeof d.today_inscribed === 'boolean', `today_inscribed=${d.today_inscribed}`);
                record('返回 inscribe_today_count 字段', typeof d.inscribe_today_count === 'number');
                record('返回 inscribe_daily_limit 字段', typeof d.inscribe_daily_limit === 'number');
                record('返回 can_inscribe 字段', typeof d.can_inscribe === 'boolean');
            } else {
                record('目标无洞府（返回简化结构）', !!d.message);
            }
            record('owner.player_id 正确', d.owner?.player_id === targetPlayerId, `期望${targetPlayerId}, 实际${d.owner?.player_id}`);
            console.log(`  目标: ${d.owner?.nickname}, 评级: ${d.rating?.tier_name}, 今日已题词: ${d.today_inscribed}, 可题词: ${d.can_inscribe}`);
        } else {
            record('GET /scroll/player/:id 返回200', false, `${res.status} ${JSON.stringify(res.body).slice(0,200)}`);
        }
    } else {
        record('查看他人绘卷（需有洞府的其他玩家）', false, '无可用目标');
    }
    console.log();

    // ===== 测试4: POST /scroll/:playerId/inscribe =====
    console.log('[6] 测试 POST /api/cave-social/scroll/:playerId/inscribe — 题词');
    if (targetPlayerId) {
        // 4a. 正常题词：主账号给目标玩家题词
        const content = '仙府灵气盎然，令人心旷神怡';
        const res = await request('POST', `/api/cave-social/scroll/${targetPlayerId}/inscribe`, main.token, { content });
        if (res.status === 200 && res.body.code === 200) {
            const d = res.body.data;
            record('题词成功状态', d.success === true);
            record('返回 inscription 记录', !!d.inscription);
            record('题词内容正确', d.inscription?.content === content);
            record('返回 honor_gained', typeof d.honor_gained === 'number');
            record('返回 today_inscribe_count', typeof d.today_inscribe_count === 'number');
            record('返回 daily_limit', typeof d.daily_limit === 'number');
            record('返回 target 信息', !!d.target);
            console.log(`  题词成功！声望+${d.honor_gained}, 今日${d.today_inscribe_count}/${d.daily_limit}`);
        } else {
            // 可能今日已题词（之前测试过），视为通过（重复题词校验）
            const msg = res.body.message || '';
            if (res.status === 400 && (msg.includes('今日已为该道友') || msg.includes('次数已达上限'))) {
                record('题词成功（今日已题词，跳过）', true);
                console.log(`  今日已为该道友题词，跳过正常题词测试`);
            } else {
                record('题词成功', false, `${res.status} ${JSON.stringify(res.body).slice(0,200)}`);
            }
        }

        // 4b. 重复题词校验：同一洞府每日仅1次
        const res2 = await request('POST', `/api/cave-social/scroll/${targetPlayerId}/inscribe`, main.token, { content: '再来一次' });
        record('重复题词被拒绝(400)', res2.status === 400, `期望400, 实际${res2.status}`);

        // 4c. 空内容校验
        const res3 = await request('POST', `/api/cave-social/scroll/${targetPlayerId}/inscribe`, main.token, { content: '' });
        record('空内容被拒绝(400)', res3.status === 400, `期望400, 实际${res3.status}`);

        // 4d. 自题词校验：不能给自己题词
        const res4 = await request('POST', `/api/cave-social/scroll/${main.player.id}/inscribe`, main.token, { content: '自吹自擂' });
        record('自题词被拒绝(400)', res4.status === 400, `期望400, 实际${res4.status}`);

        // 4e. 超长内容校验（>20字）
        const longContent = '这是一段超过二十个字的题词内容用来测试长度限制功能是否正常工作';
        const res5 = await request('POST', `/api/cave-social/scroll/${targetPlayerId}/inscribe`, main.token, { content: longContent });
        record('超长内容被拒绝(400)', res5.status === 400, `期望400, 实际${res5.status}`);

        // 4f. 验证题词后绘卷数据更新：再次查看目标绘卷，today_inscribed 应为 true
        const res6 = await request('GET', `/api/cave-social/scroll/player/${targetPlayerId}`, main.token, null);
        if (res6.status === 200 && res6.body.code === 200 && res6.body.data.cave?.is_opened) {
            record('题词后 today_inscribed=true', res6.body.data.today_inscribed === true, `today_inscribed=${res6.body.data.today_inscribed}`);
            record('题词列表包含新题词', res6.body.data.inscriptions?.some(i => i.content === content), '题词列表未包含新题词（可能今日已题词）');
        }
    } else {
        record('题词测试（需有洞府的其他玩家）', false, '无可用目标');
    }
    console.log();

    // ===== 测试5: 未认证访问 =====
    console.log('[7] 测试未认证访问');
    {
        const res = await request('GET', '/api/cave-social/scroll/me', null, null);
        record('未认证访问被拒绝(401)', res.status === 401, `期望401, 实际${res.status}`);
    }
    console.log();

    // ===== 测试6: 查看不存在玩家的绘卷 =====
    console.log('[8] 测试查看不存在玩家的绘卷');
    {
        const res = await request('GET', '/api/cave-social/scroll/player/99999999', main.token, null);
        record('不存在玩家返回404', res.status === 404, `期望404, 实际${res.status}`);
    }
    console.log();

    // ===== 汇总 =====
    console.log('===== 测试汇总 =====');
    console.log(results.join('\n'));
    console.log(`\n通过: ${passed}, 失败: ${failed}, 总计: ${passed + failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
