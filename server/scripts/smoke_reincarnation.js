/**
 * 夺舍重生活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么单独一条：夺舍的"属性继承"在 2026-09-20 属性管线改造之后就是**空转**的 ——
 * 它读 players.attributes 里旧管线留下的输出键（atk/def/hp_max），写回去也写在那些没人读的键上，
 * 而玩家看到的回执、WebSocket 推送与 player_reincarnation 记录里都记着"继承攻击 = 某个数"。
 * 这一段只有连库才断得出来：jest 里那些"配方/内容对不对"的断言看不到"落库的到底是哪一列"。
 *
 * 这条探针量四件玩家可见的事：
 *   1) 继承按**解析出来的真实属性**算（blob 里放诱饵值 999999，它不许被用）；
 *   2) 继承的账落在一个真的会被读的地方（attributes.reincarnation_bonus → 新的属性来源），
 *      并且"记录里的数 == 玩家实际生效的数"（回执不许是假账）；
 *   3) "满血复活"写的是 players.hp_current 那一列（旧实现只写了 blob 的同名键，人复活了血还是 0）；
 *   4) 连着夺两次不叠账（存储是 set 而不是 add）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_reincarnation.js
 *       探针自建账号 reinprobe01，退出前走级联清理删号；不改仓库里的任何内容。
 *   控制跑（证明这些断言不是空转）：
 *       git show HEAD:server/game/services/ReincarnationService.js 覆回去再跑，应当一片红。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5100);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}
const num = v => Number(v) || 0;

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const Player = require('../models/player');
    const PlayerReincarnation = require('../models/playerReincarnation');
    const ReincarnationTarget = require('../models/reincarnationTarget');
    const RealmService = require('../game/core/RealmService');
    const CombatResolver = require('../game/combat/CombatResolver');
    const ReincarnationService = require('../game/services/ReincarnationService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    const BAIT = 999999;
    const username = 'reinprobe01';
    const PROBE_TARGET_KEY = 'smoke_rein_probe_body';
    let strongTarget = null;      // 先声明再赋值：早退分支也要能在 finish() 里安全清理（TDZ 会把清场本身弄挂）
    await PlayerCascadePurge.deleteByUsernames([username]);

    // ===== R0：先把"这条探针有没有东西可测"钉住，别让后面全部空跑 =====
    const targets = await ReincarnationTarget.findAll({ order: [['weight', 'DESC']] });
    check('R0a 夺舍目标池非空（migration_0030 的种子行；空的话整条探针都是空跑）',
        targets.length > 0, `目标数=${targets.length}`);
    if (!targets.length) return finish();

    const startRealm = '化神初期';
    check('R0b 探针境界是真境界名（写错名会一路按默认值算，测出来的"正常"是假的）',
        !!RealmService.getRealmByName(startRealm), `realm=${startRealm}`);
    if (!RealmService.getRealmByName(startRealm)) return finish();

    /**
     * 探针自备一个"底子够厚"的夺舍目标：三条种子目标都是凡人（比例 0.3、底子几十点），
     * 拿它们跑只会走"已有比目标值高 → 补 0"那一支，于是"继承真的落了账"这一件最要紧的事
     * 会被一个全 0 的存储值假绿过去。所以第一轮用这条强目标逼出正值，第二轮再用种子凡人目标
     * 走钳制支（顺带证明第二次是"换账"而不是"叠账"）。退出时只删自己建的这一行。
     * 先按自己的 target_key 清一遍：上一次若是异常退出（外层 catch 那条路），行会留在库里，
     * 而 target_key 上有唯一索引，不清就直接 Duplicate entry 把整条探针打死。
     */
    await ReincarnationTarget.destroy({ where: { target_key: PROBE_TARGET_KEY } });
    strongTarget = await ReincarnationTarget.create({
        target_key: PROBE_TARGET_KEY, target_name: '探针夺舍用肉身', target_type: 'cultivator',
        realm_rank: 19, base_atk: 5000, base_def: 2000, base_hp_max: 20000, base_speed: 300, base_sense: 100,
        inherit_ratio: 0.9, drop_realm_count: 1, risk_level: 1, weight: 99999, is_rare: 0,
        description: '探针自建，跑完删除'
    });
    const allTargets = await ReincarnationTarget.findAll();

    const player = await Player.create({
        username, password: 'not-a-real-hash', nickname: '夺舍探针',
        realm: startRealm, realm_rank: RealmService.getRealmByName(startRealm).rank,
        exp: 100000, spirit_stones: 1000,
        hp_current: 0, mp_current: 100, lifespan_current: 100, lifespan_max: 500,
        // 诱饵：旧管线的输出键形状。继承若还从 blob 取数，这些数会直接出现在结果里。
        attributes: { atk: BAIT, def: BAIT, hp_max: BAIT, speed: BAIT, sense: 66 },
        spirit_roots: {}, token_version: 0, is_dead: true, death_reason: 'pvp_kill'
    });

    const before = (await CombatResolver.resolveCombatStats(player)).stats;
    check('R1 解析链路不吃 blob 里的诱饵值（陈旧镜像键确实没人读了）',
        before.atk !== BAIT && before.hp_max !== BAIT,
        `解析 atk=${before.atk} hp_max=${before.hp_max}（诱饵=${BAIT}）`);

    // 把随机钉成 0：夺舍判定是 roll < 成功率，0 必然成功；目标加权随机也必然取权重最高那条。
    const realRandom = Math.random;
    Math.random = () => 0;
    const trigger = await ReincarnationService.triggerReincarnation(player.id, 'pvp_kill');
    Math.random = realRandom;
    const listed = (trigger.data?.targets || []).map(t => Number(t.target_id));
    check('R2a 触发夺舍拿到目标列表，且探针那条强目标在列（不然第一轮的账永远是 0）',
        trigger.success === true && listed.every(id => id > 0) && listed.includes(Number(strongTarget.id)),
        trigger.success ? `目标 ${listed.join(',')}` : trigger.message);
    if (!trigger.success) return finish();

    const picked = trigger.data.targets.find(t => Number(t.target_id) === Number(strongTarget.id));
    const targetRow = allTargets.find(t => String(t.id) === String(picked.target_id));
    /** 这条链唯一应当成立的等式：生效值 = max(跌境后已有的, floor(原值×比例) + 这具身体的底子) */
    const expectedTotal = (origin, tRow, postDrop, stat) => Math.max(
        num(postDrop[stat]),
        Math.floor(num(origin[stat]) * num(tRow.inherit_ratio)) + num(tRow[`base_${stat}`])
    );
    /** 把本来源清零后的解析值 = "跌境后已有的"，与服务里那一步取的是同一个数 */
    const postDropOf = async inst => (await CombatResolver
        .resolveCombatStats(inst, { sourceOverrides: { reincarnation: {} } })).stats;
    console.log(`     目标=${targetRow.target_name} 继承比例=${targetRow.inherit_ratio} `
        + `底子 atk=${targetRow.base_atk}/def=${targetRow.base_def}/hp=${targetRow.base_hp_max}/speed=${targetRow.base_speed}`);

    const result = await ReincarnationService.chooseTarget(player.id, picked.target_id, { force: true });
    check('R2b 选定夺舍目标返回成功', result.success === true, result.message || JSON.stringify(result.result));
    if (!result.success) return finish();

    const row = await Player.findByPk(player.id);
    const blob = row.attributes || {};
    const record = await PlayerReincarnation.findOne({ where: { player_id: player.id }, order: [['id', 'DESC']] });

    // ===== R3 复活那一笔必须落在 players.hp_current 这一列上 =====
    const after = (await CombatResolver.resolveCombatStats(row)).stats;
    const postDrop = await postDropOf(row);
    check('R3 "满血复活"写的是 players.hp_current 列，且等于现在的血上限（旧实现只写 blob 同名键，人活了血还是 0）',
        num(row.hp_current) > 0 && num(row.hp_current) === num(after.hp_max) && row.is_dead === false,
        `hp_current=${row.hp_current} 血上限=${after.hp_max} is_dead=${row.is_dead}`);

    // ===== R4 继承的账落在真的会被读的地方，并且没去碰那五个陈旧键 =====
    const stored = blob.reincarnation_bonus;
    check('R4a 继承值写进 attributes.reincarnation_bonus（新来源）且这一轮真的补了正值',
        !!stored && ['atk', 'def', 'hp_max', 'speed'].every(k => Number.isFinite(Number(stored[k])))
            && num(stored.atk) > 0,
        JSON.stringify(stored));
    check('R4b blob 里那五个旧输出键保持原样（没有任何代码再往它们身上写）',
        num(blob.atk) === BAIT && num(blob.hp_max) === BAIT,
        `blob.atk=${blob.atk} blob.hp_max=${blob.hp_max}（应当仍是诱饵值）`);

    // ===== R5 生效值 == 规则算出的值 == 记录里的值（回执不许是假账）=====
    const wrongTotal = ['atk', 'def', 'hp_max', 'speed'].filter(stat =>
        num(after[stat]) < expectedTotal(before, targetRow, postDrop, stat));
    check('R5a 四档生效值都不低于 max(跌境后已有, floor(原值×比例)+底子)（只许等于或更高：平加会被同一套百分比再乘一遍）',
        wrongTotal.length === 0,
        wrongTotal.length ? wrongTotal.map(s => `${s}=${after[s]}<${expectedTotal(before, targetRow, postDrop, s)}`).join(' ')
            : `atk ${before.atk}→${after.atk}（跌境后本底 ${postDrop.atk}，纸面目标 ${expectedTotal(before, targetRow, postDrop, 'atk')}）`);
    const wrongRecord = ['atk', 'def', 'hp_max'].filter(stat =>
        num(record?.[`inherited_${stat}`]) !== num(after[stat]));
    check('R5b 夺舍记录里的 inherited_* 就是玩家现在真的有的数（记录表是玩家可查的历史）',
        !!record && wrongRecord.length === 0,
        wrongRecord.length ? wrongRecord.map(s => `记录${s}=${record?.[`inherited_${s}`]} 生效=${after[s]}`).join(' ')
            : `记录 atk=${record?.inherited_atk} def=${record?.inherited_def} hp=${record?.inherited_hp_max}`);

    // ===== R6 面板/战斗/来源明细同一份，且这块账指名道姓 =====
    const resolved = await require('../game/core/AttributeService')
        .calculateFullAttributesAsync(row);
    const group = resolved.breakdown?.reincarnation;
    // breakdown 里的 effective 是"这一档对最终值的实际贡献"（带百分比来源时会被乘一遍），
    // 存储值是平加原值，所以判"不低于"而不是"相等"；探针号没有任何百分比来源，两者本来就相等。
    check('R6a breakdown.reincarnation 里有这笔账（"加成来自哪里"看得见来源，不能靠 undefined==0 蒙过去）',
        !!group && typeof group.atk === 'number' && num(stored.atk) > 0 && num(group.atk) >= num(stored.atk),
        `breakdown.reincarnation.atk=${group?.atk}（分组存在=${!!group}）存储=${stored?.atk}`);
    check('R6b 面板与战斗解析同一份数（不存在"面板一个数、结算另一个数"）',
        num(resolved.final.atk) === num(after.atk), `面板=${resolved.final.atk} 战斗=${after.atk}`);

    // ===== R7 连着夺第二次：账是 set 而不是 add，不许叠层 =====
    const firstBonus = num(stored.atk);
    await require('../game/persistence/PlayerStateStore').patchPlayerState(player.id, {
        columns: { last_reincarnation_time: null, is_dead: true, death_reason: 'pvp_kill', hp_current: 0 }
    });
    Math.random = () => 0;
    const trigger2 = await ReincarnationService.triggerReincarnation(player.id, 'pvp_kill');
    // 第二轮故意选一条**种子凡人目标**（底子只有几十点）：这样"目标总值"低于现在的我，
    // 账应当被整块换掉（甚至换成 0），而不是在第一次的账上再加一层。
    const picked2 = trigger2.success
        ? (trigger2.data.targets.find(t => Number(t.target_id) !== Number(strongTarget.id)) || trigger2.data.targets[0])
        : null;
    const result2 = picked2
        ? await ReincarnationService.chooseTarget(player.id, picked2.target_id, { force: true })
        : trigger2;
    Math.random = realRandom;
    const row2 = await Player.findByPk(player.id);
    const bonus2 = row2.attributes?.reincarnation_bonus || {};
    const after2 = (await CombatResolver.resolveCombatStats(row2)).stats;
    const record2 = await PlayerReincarnation.findOne({ where: { player_id: player.id }, order: [['id', 'DESC']] });
    const targetRow2 = targets.find(t => String(t.id) === String(picked2?.target_id));
    const postDrop2 = await postDropOf(row2);
    check('R7a 第二次夺舍成功（同一套链路可重复走）',
        result2.success === true, result2.message || '');
    check('R7b 第二次仍然"记录值 == 生效值"，且生效值不低于规则值',
        !!targetRow2 && ['atk', 'def', 'hp_max'].every(stat =>
            num(after2[stat]) === num(record2?.[`inherited_${stat}`])
            && num(after2[stat]) >= expectedTotal(after, targetRow2, postDrop2, stat)),
        !!targetRow2
            ? `atk ${after.atk}→${after2.atk}（规则值≥${expectedTotal(after, targetRow2, postDrop2, 'atk')}，记录=${record2?.inherited_atk}）`
            : '第二轮没拿到种子目标（探针自建的那条强目标不该被再选一次）');
    check('R7c 账是被"换掉"而不是"叠上去"：第二次的存储值既不等于两次的和，也比第一次小',
        num(bonus2.atk) !== firstBonus + num(stored.atk) && num(bonus2.atk) < firstBonus,
        `第一次补 ${firstBonus} → 第二次补 ${num(bonus2.atk)}（若是 add 语义会变成 ${firstBonus + num(bonus2.atk)}）`);
    check('R7d 境界按目标要求跌落（跌境与继承两件事都真的落了库）',
        !!record2 && record2.new_realm !== record2.origin_realm,
        `${record?.new_realm} → ${record2?.new_realm}`);

    // ===== R8 清场：只删自己记下的主键，并且确认库里不残留 =====
    await strongTarget.destroy();
    await PlayerCascadePurge.deleteByUsernames([username]);
    const leftovers = await PlayerReincarnation.count({ where: { player_id: player.id } });
    const stillThere = await Player.count({ where: { username } });
    const targetLeft = await ReincarnationTarget.count({ where: { id: strongTarget.id } });
    check('R8 探针号、夺舍记录与自建目标行都清干净（级联带走派生行）',
        leftovers === 0 && stillThere === 0 && targetLeft === 0,
        `玩家=${stillThere} 夺舍记录残留=${leftovers} 自建目标残留=${targetLeft}`);

    finish();

    async function finish() {
        const failed = results.filter(r => !r.ok);
        // 无论走到哪一步都先清场：半途 return 的探针号若留在库里，下次运行会被"账号已存在"挡住，
        // 更糟的是它带着诱饵值留在测试库里，别人一查就当真相看。
        try { await PlayerCascadePurge.deleteByUsernames([username]); } catch (e) { console.warn('清场失败:', e.message); }
        try { if (strongTarget) await ReincarnationTarget.destroy({ where: { id: strongTarget.id } }); }
        catch (e) { console.warn('自建目标清理失败:', e.message); }
        console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
        Math.random = realRandom;
        process.exit(failed.length ? 1 : 0);
    }
})().catch(async err => {
    console.error('探针异常:', err.message || err);
    // 异常退出也要尽力清场：留着自建目标行会让下一次运行一上来就撞唯一索引
    try {
        const ReincarnationTarget = require('../models/reincarnationTarget');
        await ReincarnationTarget.destroy({ where: { target_key: 'smoke_rein_probe_body' } });
        const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
        await PlayerCascadePurge.deleteByUsernames(['reinprobe01']);
    } catch (cleanupError) {
        console.warn('异常退出后的清场也失败了（请手工删 reinprobe01 与 smoke_rein_probe_body）:', cleanupError.message);
    }
    process.exit(2);
});
