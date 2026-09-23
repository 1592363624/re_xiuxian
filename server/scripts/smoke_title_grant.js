/**
 * 整块列的写入语义 + 称号唯一入口（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：`players.titles` 和 `spirit_beast_pastures.steal_yields` 都叫"整块 JSON 列"，
 * 但两者对"读出来就地改、再把同一个引用赋回去"的反应**不一样**：
 *   · TEXT + get(){JSON.parse} / set(){JSON.stringify} → 每次读都得到新对象，赋回去照样落库；
 *   · 原生 DataTypes.JSON（getter 直接返回库里那份引用）→ changed() 判成没改，save() 不带这一列，静默丢。
 * 我 2026-09-21 先按列名一刀切，得出"副本称号 7 处在丢写"的错判；这条探针就是那两次纠正的证据。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_title_grant.js
 *       自建账号 titlegrant01 + 一条放养行，退出前自己删干净。
 */
'use strict';

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

function rawTitles(player) {
    const raw = player && player.getDataValue && player.getDataValue('titles');
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw) || []; } catch { return []; } }
    return [];
}

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const Pasture = require('../models/spiritBeastPasture');
    const { addTitleToInstance } = require('../game/persistence/PlayerStateStore');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的行，新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames(['titlegrant01']);
    const created = await Player.create({
        username: 'titlegrant01', password: 'not-a-real-hash', nickname: '称号探针',
        realm: '炼气1层', realm_rank: 1, exp: 0, spirit_stones: 1000,
        hp_current: 5000, mp_current: 500, lifespan_current: 1, lifespan_max: 60,
        attributes: {}, titles: ['title_first'], token_version: 0
    });

    // J1：TEXT+parse 列（players.titles）—— 旧写法**并不丢写**。这是对我自己那次误判的纠正。
    {
        await sequelize.transaction(async (t) => {
            const p = await Player.findByPk(created.id, { transaction: t, lock: t.LOCK.UPDATE });
            const titles = p.titles || [];
            titles.push('j1_old_shape');
            p.titles = titles;
            await p.save({ transaction: t });
        });
        const reread = await Player.findByPk(created.id);
        check('J1 TEXT+parse 列（players.titles）用"同引用赋回"仍然落库 —— 副本称号那 7 处不是丢写',
            rawTitles(reread).includes('j1_old_shape'),
            `库里 titles=${JSON.stringify(rawTitles(reread))}`);
    }

    // J2/J3：原生 JSON 列（spirit_beast_pastures.steal_yields）—— 同引用赋回真的丢，新数组才落库
    const pasture = await Pasture.create({
        player_id: created.id, beast_id: 900001, location_key: 'qingyun_mountain',
        location_name: '青云山', start_time: new Date(), end_time: new Date(Date.now() + 3600_000),
        status: 'active', yield_snapshot: [], steal_count: 0, stolen_count: 0, steal_yields: []
    });
    {
        await sequelize.transaction(async (t) => {
            const row = await Pasture.findByPk(pasture.id, { transaction: t, lock: t.LOCK.UPDATE });
            const yields = row.steal_yields || [];
            yields.push({ item_id: 'j2_old_shape', qty: 1 });
            row.steal_yields = yields;                 // 同一个引用赋回
            await row.save({ transaction: t });
        });
        const afterOld = await Pasture.findByPk(pasture.id);
        const oldLanded = Array.isArray(afterOld.getDataValue('steal_yields'))
            ? afterOld.getDataValue('steal_yields') : JSON.parse(afterOld.getDataValue('steal_yields') || '[]');
        check('J2 原生 JSON 列用"同引用赋回"确实静默丢写（changed=false，save 不带这一列）',
            oldLanded.length === 0, `库里 steal_yields 长度=${oldLanded.length}，内容=${JSON.stringify(oldLanded)}`);

        await sequelize.transaction(async (t) => {
            const row = await Pasture.findByPk(pasture.id, { transaction: t, lock: t.LOCK.UPDATE });
            row.steal_yields = [...(row.steal_yields || []), { item_id: 'j3_new_array', qty: 1 }];
            await row.save({ transaction: t });
        });
        const afterNew = await Pasture.findByPk(pasture.id);
        const newRaw = afterNew.getDataValue('steal_yields');
        const newLanded = Array.isArray(newRaw) ? newRaw : JSON.parse(newRaw || '[]');
        check('J3 改成"赋一个新数组"就落库（这就是 BeastPastureService 那一处的修法）',
            newLanded.length === 1 && newLanded[0].item_id === 'j3_new_array',
            `库里=${JSON.stringify(newLanded)}`);
    }

    // J4：称号入口 + 两个并发事务各加一个不同称号 → 两个都在（行锁把它串起来）
    {
        const worker = (title) => sequelize.transaction(async (t) => {
            const fresh = await Player.findByPk(created.id, { transaction: t, lock: t.LOCK.UPDATE });
            const added = addTitleToInstance(fresh, title);
            await fresh.save({ transaction: t });
            return added;
        });
        const both = await Promise.all([worker('j4_left'), worker('j4_right')]);
        const stored = rawTitles(await Player.findByPk(created.id));
        check('J4 两个并发事务各加一个称号：两个都在，且都只加一次',
            both.every(Boolean) && stored.filter(x => x === 'j4_left').length === 1
            && stored.includes('j4_right'), `库里=${JSON.stringify(stored)}`);
    }

    // J5：幂等与非法入参（不写库，单实例上判）
    {
        const p = await Player.findByPk(created.id);
        const had = rawTitles(p).includes('j4_left');
        check('J5 已有该称号时 addTitleToInstance 返回 false（不重复发）',
            had && addTitleToInstance(p, 'j4_left') === false, `titles=${JSON.stringify(p.titles)}`);
        let threw = false;
        try { addTitleToInstance(p, ''); } catch { threw = true; }
        check('J5b 非法称号 ID 直接抛，不会静默塞进数组', threw && !p.titles.includes(''), `titles=${JSON.stringify(p.titles)}`);
    }

    // J6：自清理 —— 只叫一次"删号"，派生行（放养行）由级联自己带走
    await PlayerCascadePurge.deletePlayer(created.id);
    const left = await Promise.all([
        Player.count({ where: { username: 'titlegrant01' } }),
        Pasture.count({ where: { id: pasture.id } })
    ]);
    check('J6 探针自己清干净（删号只走级联那扇门，不留诱饵值给下一次运行）',
        left.every(c => c === 0), `残留 玩家=${left[0]} 放养行=${left[1]}`);

    await sequelize.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['titlegrant01']);
    } catch {}
    process.exit(2);
});
