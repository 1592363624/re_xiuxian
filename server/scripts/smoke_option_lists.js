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
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
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
    // V9：GM 改灵兽属性。可改集合来自属性注册表，两个方向都要成立：
    //   表上有列的（atk）写列；注册了但没有列的（crit_rate/dodge_rate）写进 spirit_beasts.stat_block 属性块。
    //   2026-09-21 之前第二种是回 400 的（"改表需要授权"）；migration_0088 给了落脚点之后，
    //   这一档改成"改得动、而且按块合并"—— 同块里另一档不许被后一次编辑抹掉。
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
    const blobRes = await request({ port: PORT, method: 'PUT', path: `/api/admin/spirit-beast/beasts/${beast.id}`,
        token: adminToken, body: { crit_rate: 5 } });
    const afterBlob = await SpiritBeast.findByPk(beast.id);
    const blobBody = blobRes.body?.data || {};
    check('V9b GM 改灵兽：注册了但没有专属列的属性落进 stat_block 属性块（不再回 400）',
        blobRes.status === 200 && Number(afterBlob?.stat_block?.crit_rate) === 5
            && Number(blobBody.extra_stats?.crit_rate) === 5,
        `status=${blobRes.status} 库里 stat_block=${JSON.stringify(afterBlob?.stat_block)} 响应 extra_stats=${JSON.stringify(blobBody.extra_stats)}`);
    const mergeRes = await request({ port: PORT, method: 'PUT', path: `/api/admin/spirit-beast/beasts/${beast.id}`,
        token: adminToken, body: { dodge_rate: 7 } });
    const afterMerge = await SpiritBeast.findByPk(beast.id);
    const mergedBlock = afterMerge?.stat_block || {};
    check('V9c 属性块按块合并：后一次编辑不许把前一次的 crit_rate 覆盖掉',
        mergeRes.status === 200 && Number(mergedBlock.dodge_rate) === 7 && Number(mergedBlock.crit_rate) === 5,
        `status=${mergeRes.status} stat_block=${JSON.stringify(mergedBlock)}`);
    await beast.destroy();

    // V10/V11：本轮把两份"客户端抄的主键清单"改成内容下发，这里核的是接口真给全。
    //   V10 灵兽属性词表（后台那个下拉以前抄了五行；凡人遗宝刚补了一档「雷」，抄的那份就没有它）
    //   V11 道途全集（面板以前抄了 key 列表 + 中文名 + 五段描述；内容里的名字其实是"金道·锐金"这种长名）
    // 注意 query 必须拼进 path：lib/smoke_http 的 request() 只认 {port,method,path,token,body}，
    // 传 `query:` 进去会被静默丢掉（第一版就这么"绿"过一次：拿回来的其实是默认集合 beast_types）。
    const elementsRes = await request({ port: PORT, method: 'GET',
        path: '/api/config/content/keys/spirit_beast_data?collection=elements', token: adminToken });
    const contentElements = Object.keys(configLoader.getConfig('spirit_beast_data').elements || {});
    const givenElements = (elementsRes.body?.data?.entries || []);
    check('V10 灵兽属性清单接口回内容里的全部属性（含资料片补的那一档），中文名也取自内容',
        elementsRes.status === 200 && contentElements.length >= 6
            && contentElements.every(k => givenElements.some(e => e.key === k))
            && givenElements.some(e => e.key === 'thunder' && e.name === '雷'),
        `status=${elementsRes.status} 内容 ${contentElements.length} 档=${contentElements.join(',')} 接口=${givenElements.map(e => `${e.key}:${e.name}`).join(',')}`);

    const profileRes = await request({ port: PORT, method: 'GET', path: '/api/taoism-gate/profile', token: adminToken });
    const options = (profileRes.body?.data?.dao_path_options || []);
    const contentPaths = configLoader.getConfig('taoism_gate_data').dao_paths || {};
    check('V11 引道面板的"道途全集"由服务端随 profile 下发，名字与描述都取自内容',
        profileRes.status === 200 && options.length === Object.keys(contentPaths).length
            && Object.keys(contentPaths).every(k => options.some(o => o.key === k
                && o.name === contentPaths[k].name && o.description === contentPaths[k].description)),
        `status=${profileRes.status} 下发 ${options.length} 档/内容 ${Object.keys(contentPaths).length} 档：${options.map(o => o.name).join(',')} 响应=${JSON.stringify(profileRes.body).slice(0, 100)}`);

    // V12：阵法名字表现在是"资料片能改的集合"（FormationService.formationCategories() 直接拿它的键
    // 当合法全集，routes/formation.js:158 用它挡参数）。下发必须是纯字符串：
    // 资料片经 map 集合补的一档是 {id,label} 对象，没过 contentLabel 就会印 [object Object]。
    const formationRes = await request({ port: PORT, method: 'GET', path: '/api/formation/config' });
    const fGlobal = formationRes.body?.data?.global || {};
    const catLabels = fGlobal.category_display_names || {};
    const gradeLabels = fGlobal.grade_display_names || {};
    const contentFormation = configLoader.getConfig('formation_data').global;
    check('V12 阵法流派/品级名字表下发是纯字符串，且键与内容一致（合法全集由这张表决定）',
        formationRes.status === 200
            && Object.keys(catLabels).length === Object.keys(contentFormation.category_display_names).length
            && Object.keys(gradeLabels).length === Object.keys(contentFormation.grade_display_names).length
            && Object.values(catLabels).every(v => typeof v === 'string' && v.trim() && !v.includes('[object'))
            && Object.values(gradeLabels).every(v => typeof v === 'string' && v.trim() && !v.includes('[object')),
        `status=${formationRes.status} 流派=${JSON.stringify(catLabels)} 品阶=${JSON.stringify(gradeLabels)}`);

    // V13：装备槽位词表（2026-09-22 起 `equipment.slot_names` 是唯一来源，`valid_slots` 由它派生，
    // 而且登记成了 map 集合 —— 资料片能加一档槽位）。两个面板（装备栏/背包）都读这份接口，
    // 所以要两头都钉住：派生的数组与规范化后的字符串名字表必须一致，且不许把对象形状漏给前端。
    const gbRes = await request({ port: PORT, method: 'GET', path: '/api/config/game-balance/public', token: adminToken });
    const gbEquip = gbRes.body?.data?.equipment || {};
    const gbSlots = Array.isArray(gbEquip.valid_slots) ? gbEquip.valid_slots : null;
    const gbNames = gbEquip.slot_names || {};
    check('V13 槽位词表下发：valid_slots 是数组、slot_names 是纯字符串、两边键集一致（只有一份真相）',
        !!gbSlots && gbSlots.length >= 6
        && gbSlots.every(s => typeof s === 'string' && s.trim())
        && Object.keys(gbNames).slice().sort().join(',') === gbSlots.slice().sort().join(',')
        && Object.values(gbNames).every(v => typeof v === 'string' && v.trim() && !v.includes('[object'))
        // 槽位必须有自己的中文名，否则界面就在印裸键（V12 同一个坑的第二处）
        && gbSlots.every(s => gbNames[s] !== s),
        `status=${gbRes.status} valid_slots=${JSON.stringify(gbSlots)} 名字=${JSON.stringify(gbNames)}`);

    // V14：品质词表（2026-09-22 起 `game_balance.item_qualities` 是唯一来源，客户端只在
    // composables/useItemQualities.js 一处把色令牌换成 Tailwind 类）。
    // 面板过去各抄一份字典、六份漏了 mythic → 神话档物品在界面上被印成"普通"，
    // 所以这一条要钉住三件事：档全（含 mythic）、标签是人话、按 order 排好（客户端直接 v-for 当下拉）。
    const gbQualities = gbRes.body?.data?.item_qualities;
    const qKeys = Array.isArray(gbQualities) ? gbQualities.map(q => q.key) : [];
    check('V14 品质词表下发：六档齐（含 mythic）、标签非空且不等于键名、order 严格递增',
        Array.isArray(gbQualities) && gbQualities.length >= 6
        && ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].every(k => qKeys.includes(k))
        && gbQualities.every(q => typeof q.label === 'string' && q.label.trim() && q.label !== q.key)
        && gbQualities.every((q, i) => i === 0 || Number(q.order) > Number(gbQualities[i - 1].order))
        && gbQualities.every(q => ['neutral', 'jade', 'azure', 'violet', 'gold', 'crimson'].includes(q.tone)),
        `status=${gbRes.status} 档=${JSON.stringify(gbQualities?.map(q => `${q.key}:${q.label}:${q.tone}`))}`);

    await probePlayer.update({ role: 'player' });

    // 先把 V8 临时提上去的 role='admin' 改回 player（上面那行），再走级联删号 ——
    // deletePlayers 故意拒绝删管理员行，正是为了挡住"提权状态下误删真人号"。
    const purged = await PlayerCascadePurge.deleteByUsernames(['optionprobe01']);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
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
