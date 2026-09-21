/**
 * "参数取值来自内容"的接口探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：把写死的主键清单换成从内容取之后，风险变成"取错了 / 服务没初始化 /
 * 名字写错"，而这几个分支只在**参数非法**时才走到 —— GET 类探针永远碰不到（它们是 POST 接口），
 * jest 也不连库不发 HTTP。本探针故意各喂一个非法值，要求：
 *   ① 回 400 而不是 500（证明取清单那几行真的能跑、标识符没写错 —— 这一条当场抓住过一次
 *      `artifactSpiritService` 写成小写、只有运行时才炸的引用错误）；
 *   ② 提示里出现内容里的全部可选项（证明清单真的来自内容，而不是又一份手写）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_option_lists.js
 * 只打参数校验分支，不产生任何玩法状态变更（这些请求都在第一步就被拒）。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5086);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 内容里到底有哪些可选项 —— 断言的期望值也取自内容，不在这里再抄一份 */
function contentOptions(dataset, pick) {
    const config = configLoader.getConfig(dataset) || {};
    return pick(config);
}

async function probe(label, { method, path, body, query, expectKeys, source }) {
    const player = await Player.findOne({ where: { username: 'optionprobe01' } });
    const token = mintToken(player);
    const url = query ? `${path}?${query}` : path;
    const res = await request({ port: PORT, method, path: url, token, body });
    const message = JSON.stringify(res.body || {});
    const missing = expectKeys.filter(key => !message.includes(key));
    check(label, res.status === 400 && missing.length === 0,
        `status=${res.status} 缺少可选项=${missing.join(',') || '无'} 来源=${source} 响应=${message.slice(0, 160)}`);
}

(async () => {
    await bootApp(app, { port: PORT });

    if (!(await Player.findOne({ where: { username: 'optionprobe01' } }))) {
        await Player.create({
            username: 'optionprobe01',
            password: 'not-a-real-hash',
            nickname: '参数取值探针',
            realm: '炼气10层',
            realm_rank: 10
        });
    }

    const dungeons = contentOptions('multi_dungeon_data', c => Object.keys(c.dungeons || {}));
    const rods = contentOptions('fishing_data', c => Object.keys(c.rods || {}));
    const cutMethods = contentOptions('gambling_stone_data', c => Object.keys(c.cut_methods || {}));
    const spiritTypes = contentOptions('artifact_spirit_data', c => Object.keys(c.spirit_types || {}));
    const categories = contentOptions('formation_data', c => Object.keys(c.global?.category_display_names || {}));
    const modes = contentOptions('late_stage_data', c => Object.keys(c.second_soul?.dispatch_modes || {}));
    const facilities = contentOptions('cave_data', c => Object.keys(c.cave?.facilities || {}));

    check('V0 内容里这七类可选项都取得到（有一条空了就说明数据集没进内容层，下面的断言会是空的）',
        [dungeons, cutMethods, spiritTypes, categories, modes, rods, facilities].every(a => a.length >= 3),
        `副本=${dungeons.length} 钓竿=${rods.length} 切法=${cutMethods.length} 器灵=${spiritTypes.length} 流派=${categories.length} 调度=${modes.length} 洞府设施=${facilities.length}`);

    await probe('V1 多人副本：非法键回 400，提示里列全内容中的副本', {
        method: 'POST', path: '/api/multi-dungeon/create', body: { dungeon_key: '__bogus__' },
        expectKeys: dungeons, source: 'multi_dungeon_data.dungeons'
    });
    await probe('V2 赌石：非法切法回 400，提示里列全内容中的切法', {
        method: 'POST', path: '/api/gambling-stone/cut', body: { stone_id: 1, cut_method: '__bogus__' },
        expectKeys: cutMethods, source: 'gambling_stone_data.cut_methods'
    });
    await probe('V3 器灵：非法类型回 400（这一步同时证明路由里那个服务标识符没写错）', {
        method: 'POST', path: '/api/artifact-spirit/awaken', body: { equipment_id: 1, spirit_type: '__bogus__' },
        expectKeys: spiritTypes, source: 'artifact_spirit_data.spirit_types'
    });
    await probe('V4 第二元神：非法调度模式回 400，提示里列全内容中的模式', {
        method: 'POST', path: '/api/second-soul/dispatch', body: { soul_index: 2, mode: '__bogus__' },
        expectKeys: modes, source: 'late_stage_data.second_soul.dispatch_modes'
    });
    await probe('V5 阵法：非法对手流派回 400，提示里列全内容中的流派', {
        method: 'GET', path: '/api/formation/active-effect', query: 'opponent_category=__bogus__',
        expectKeys: categories, source: 'formation_data.global.category_display_names'
    });

    await probe('V7 洞府：非法设施回 400，提示里列全内容中的设施（GM 下拉与升级都从同一份清单来）', {
        method: 'POST', path: '/api/cave/upgrade', body: { facility: '__bogus__' },
        expectKeys: facilities, source: 'cave_data.cave.facilities'
    });

    // V8：GM 设施清单接口。它给的是"内容 ∩ player_caves 真有等级列"，
    // 所以现在这五条必须全在 —— 少任何一条都表示交集算错了（列名拼接写错最容易整份变空）。
    const probePlayer = await Player.findOne({ where: { username: 'optionprobe01' } });
    await probePlayer.update({ role: 'admin' });
    const adminToken = mintToken(probePlayer);
    const facilitiesRes = await request({ port: PORT, method: 'GET', path: '/api/admin/cave/facilities', token: adminToken });
    const listed = (facilitiesRes.body?.data?.facilities || []);
    const labels = listed.map(f => f.label);
    const namesFromContent = facilities.map(key =>
        (configLoader.getConfig('cave_data').cave.facilities[key] || {}).name || key);
    check('V8 GM 设施清单接口回内容里的全部设施，中文名也取自内容',
        facilitiesRes.status === 200
            && listed.length === facilities.length && facilities.every(k => listed.some(f => f.value === k))
            && namesFromContent.every(n => labels.includes(n)),
        `status=${facilitiesRes.status} 条数=${listed.length}/${facilities.length} 名字=${labels.join(',')} 响应=${JSON.stringify(facilitiesRes.body).slice(0, 120)}`);
    // V9：GM 改灵兽属性。可改集合取自"属性注册表 ∩ spirit_beasts 上真有的列"，两个方向都要成立：
    //   有列的注册属性（atk）改得动；注册了但表上没列的（crit_rate）必须回 400 并点名，不许悄悄丢掉。
    //   以前代码抄了 ['atk','def','speed'] 一份字面量，传 mdef/crit_rate 会被无声忽略。
    const beastKey = (configLoader.getConfig('spirit_beast_data').beasts || [])[0]?.id || 'smoke_beast';
    const beast = await SpiritBeast.create({
        player_id: probePlayer.id, beast_key: beastKey, element: 'metal', rarity: 'common',
        star_level: 1, level: 1, exp: 0, hp_max: 1000, atk: 100, def: 50, speed: 20
    });
    const okRes = await request({ port: PORT, method: 'PUT', path: `/api/admin/spirit-beast/beasts/${beast.id}`,
        token: adminToken, body: { atk: 137 } });
    const afterBeast = await SpiritBeast.findByPk(beast.id);
    check('V9a GM 改灵兽：注册表里且表上有列的属性真的写进去了',
        okRes.status === 200 && Number(afterBeast?.atk) === 137,
        `status=${okRes.status} atk=${afterBeast?.atk} 响应=${JSON.stringify(okRes.body).slice(0, 140)}`);
    const badRes = await request({ port: PORT, method: 'PUT', path: `/api/admin/spirit-beast/beasts/${beast.id}`,
        token: adminToken, body: { crit_rate: 5 } });
    const badBody = JSON.stringify(badRes.body || {});
    check('V9b GM 改灵兽：注册了但没列的属性回 400 并点名（不静默丢掉）',
        badRes.status === 400 && badBody.includes('crit_rate') && badBody.includes('spirit_beasts'),
        `status=${badRes.status} 响应=${badBody.slice(0, 180)}`);
    await beast.destroy();

    await probePlayer.update({ role: 'player' });

    await Player.destroy({ where: { username: 'optionprobe01' } });
    return finish();
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await finish(2);
});

async function finish(code = null) {
    await sequelize.close().catch(() => {});
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    process.exit(code !== null ? code : (failed.length ? 1 : 0));
}
