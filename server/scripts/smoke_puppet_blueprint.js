/**
 * 「资料片加一只新傀儡」的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * jest 那份 `PuppetBlueprintVocabulary` 证的是内容层装配与启动闸；玩家真正踩到的是
 * 服务与库这三条链：工坊列表里的"可制造"行、参悟（扣背包里那张图谱物品）、制造（落一行傀儡）。
 * 这一格改造前的形状是：`puppet_types` 能扩、它的外键目标 `blueprints` 不能扩，
 * 而客户端"参悟"按钮自己按傀儡类型名拼图谱键 —— 于是一支名字不合约定的图谱点下去只会报"图谱不存在"。
 * 所以这里的临时 pack 故意用不合约定的图谱键（tujian_xinyu_v2），全程只经服务端下发的 blueprint_key。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_puppet_blueprint.js
 *       探针自建账号 puppetprobe01，退出前按账号名级联清干净；不改仓库里的任何 pack。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const PROBE_NAME = 'puppetprobe01';
const NEW_TYPE = 'xinyu_jiang';
const NEW_BLUEPRINT = 'tujian_xinyu_v2';      // 故意不叫 `${NEW_TYPE}_blueprint`
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${detail}`);
}

/** 复制现网 pack 目录，再放一支"只加数据"的傀儡探针片 */
function makeTempPackDir({ withBlueprint = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-puppet-'));
    const packs = path.join(root, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    for (const dir of fs.readdirSync(path.join(SERVER, 'content', 'packs'))) {
        fs.cpSync(path.join(SERVER, 'content', 'packs', dir), path.join(packs, dir), { recursive: true });
    }
    const probe = path.join(packs, 'puppet_probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({ id: 'puppet_probe', name: '傀儡图谱探针', version: '1.0.0' }));
    fs.writeFileSync(path.join(probe, 'puppet_data__puppet_types.json'), JSON.stringify({
        dataset: 'puppet_data', into: 'puppet_types',
        comment: '探针傀儡：只存在于资料片里，图谱键故意不合 <类型>_blueprint 约定。',
        add: [{
            id: NEW_TYPE, name: '心傀·试片', description: '探针傀儡', quality: 'epic',
            required_dayan_level: 0, blueprint_key: NEW_BLUEPRINT,
            base_stats: { atk: 400, def: 200, hp: 1500, speed: 60 },
            manufacture_cost: { spirit_stone: 1000, materials: {} }, color: 'violet'
        }]
    }));
    if (withBlueprint) {
        fs.writeFileSync(path.join(probe, 'puppet_data__blueprints.json'), JSON.stringify({
            dataset: 'puppet_data', into: 'blueprints',
            add: [{ id: NEW_BLUEPRINT, name: '试片心傀图谱', puppet_type: NEW_TYPE, source: '探针资料片', description: '探针图谱' }]
        }));
        fs.writeFileSync(path.join(probe, 'item_data__items.json'), JSON.stringify({
            dataset: 'item_data', into: 'items',
            add: [{ id: NEW_BLUEPRINT, name: '试片心傀图谱', type: 'material', quality: 'epic', description: '参悟用的图谱物品', price: 1 }]
        }));
    }
    return { root, packs };
}

(async () => {
    const { root, packs } = makeTempPackDir();
    process.env.CONTENT_PACK_DIR = packs;

    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    const { contentRegistry } = require('../game/content');
    check('P0 临时 pack 装配上了', (contentRegistry().status().packs || []).map(p => p.id).includes('puppet_probe'),
        `已装配=${(contentRegistry().status().packs || []).map(p => p.id).join(', ')}`);

    await require('../game').initializeGameServices(infrastructure.ConfigLoader);
    const PuppetService = require('../game/services/PuppetService');
    PuppetService.initialize(infrastructure.ConfigLoader);   // 探针不启 HTTP，index.js 里那行注入不会发生
    const Player = require('../models/player');
    const PlayerPuppet = require('../models/playerPuppet');
    const PlayerPuppetBlueprint = require('../models/playerPuppetBlueprint');
    const InventoryService = require('../game/services/InventoryService');
    const RealmService = require('../game/core/RealmService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    await PlayerCascadePurge.deleteByUsernames([PROBE_NAME]);
    const realm = RealmService.getRealmByName('炼气10层') || RealmService.getRealmByName('凡人');
    const player = await Player.create({
        username: PROBE_NAME, password: 'not-a-real-hash', nickname: '傀儡图谱探针',
        realm: realm.name, realm_rank: realm.rank, exp: 0, spirit_stones: 1000000,
        hp_current: 5000, mp_current: 5000, lifespan_current: 25, lifespan_max: 120,
        attributes: {}, token_version: 0
    });

    // ① 工坊的"可制造"行：key/名字/出处都由服务端一次给全（界面不再拼 key）
    const before = await PuppetService.getWorkshop(player.id);
    const row = (before.data?.manufacturable || []).find(m => m.puppet_type === NEW_TYPE);
    check('P1 资料片新傀儡出现在可制造列表，blueprint_key 就是内容里那个不合约定的键',
        !!row && row.blueprint_key === NEW_BLUEPRINT && row.blueprint_name === '试片心傀图谱'
        && row.blueprint_source === '探针资料片',
        JSON.stringify(row && { blueprint_key: row.blueprint_key, blueprint_name: row.blueprint_name, blueprint_source: row.blueprint_source }));
    check('P1b 没参悟之前 has_blueprint=false、can_manufacture=false（按钮该是灰的，而不是消失）',
        !!row && row.has_blueprint === false && row.can_manufacture === false,
        `has_blueprint=${row?.has_blueprint} can=${row?.can_manufacture}`);

    // ② 造不出来：材料/图谱条件真的在服务侧生效（不只是界面灰着）
    const early = await PuppetService.manufacture(player.id, NEW_TYPE);
    check('P2 未参悟时制造被拒，并说清缺的是图谱',
        early.success !== true && /图谱/.test(String(early.message || '')),
        `success=${early.success} message=${(early.message || '').slice(0, 60)}`);

    // ③ 发图谱物品 → 参悟（走的就是客户端拿到的那个 key）
    await InventoryService.addItem(player.id, NEW_BLUEPRINT, 1, null);
    const learned = await PuppetService.learnBlueprint(player.id, row.blueprint_key);
    const learnedRow = await PlayerPuppetBlueprint.findOne({ where: { player_id: player.id, blueprint_key: NEW_BLUEPRINT } });
    check('P3 参悟成功并落库（图谱物品从背包扣掉）',
        learned.success === true && !!learnedRow
        && Number(await InventoryService.getItemQuantity(player.id, NEW_BLUEPRINT)) === 0,
        `success=${learned.success} 消息=${(learned.message || '').slice(0, 40)} 库里行=${!!learnedRow} 落库名=${learnedRow?.blueprint_name}`);

    const mid = await PuppetService.getWorkshop(player.id);
    const rowAfter = (mid.data?.manufacturable || []).find(m => m.puppet_type === NEW_TYPE);
    check('P4 参悟之后同一行的 has_blueprint 翻成 true（面板靠这一个字段点亮按钮，不查本地字典）',
        rowAfter?.has_blueprint === true && rowAfter?.can_manufacture === true,
        `has_blueprint=${rowAfter?.has_blueprint} can=${rowAfter?.can_manufacture}`);
    const learnedList = (mid.data?.blueprints || []).find(b => b.blueprint_key === NEW_BLUEPRINT);
    check('P4b 已学图谱列表里的名字与出处也是内容现算的（不是参悟那一刻写进库里的快照）',
        learnedList?.blueprint_name === '试片心傀图谱' && learnedList?.source === '探针资料片',
        JSON.stringify(learnedList));

    // ④ 造出来 → 出战 → 属性进玩家面板
    const made = await PuppetService.manufacture(player.id, NEW_TYPE);
    const puppet = await PlayerPuppet.findOne({ where: { player_id: player.id, puppet_type: NEW_TYPE } });
    check('P5 制造成功并落一行傀儡，属性按内容 base_stats 算（不是写死的四键）',
        made.success === true && !!puppet && Number(puppet.atk) >= 400 && Number(puppet.def) >= 200,
        `success=${made.success} 消息=${(made.message || '').slice(0, 40)} 库里 atk/def/hp=${puppet?.atk}/${puppet?.def}/${puppet?.hp}`);
    await PuppetService.setBattle(player.id, puppet.id);
    const bonus = await PuppetService.getBattlePuppetBonus(player.id);
    check('P6 出战这只新傀儡给玩家折算属性（比例来自内容 battle_stat_ratio，不挑键名）',
        Number(bonus?.atk) > 0 && Number(bonus?.def) > 0,
        `bonus=${JSON.stringify(bonus).slice(0, 140)}`);

    // ⑤ 控制跑：只加傀儡类型不加图谱（外加图谱物品）→ 启动期就抛，而不是留一只造不出来的傀儡
    {
        const bad = makeTempPackDir({ withBlueprint: false });
        let message = '';
        try {
            const { ContentRegistry } = require('../game/content/ContentRegistry');
            const { statRegistry } = require('../game/stats');
            new ContentRegistry({ configPath: path.join(SERVER, 'config'), packDir: bad.packs, statRegistry }).load();
        } catch (err) { message = String(err.message || err); } finally {
            fs.rmSync(bad.root, { recursive: true, force: true });
        }
        check('P7 控制跑：加了类型没加图谱 → 启动期点名拦下（learnBlueprint 会永远回"图谱不存在"）',
            message.includes('blueprint_key') && message.includes(NEW_BLUEPRINT),
            message.slice(0, 150).replace(/\s+/g, ' '));
    }

    const purged = await PlayerCascadePurge.deleteByUsernames([PROBE_NAME]);
    const residue = await PlayerPuppet.count({ where: { player_id: purged.ids } });
    const bpResidue = await PlayerPuppetBlueprint.count({ where: { player_id: purged.ids } });
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行；傀儡残留=${residue} 图谱残留=${bpResidue}`);
    fs.rmSync(root, { recursive: true, force: true });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames([PROBE_NAME]);
    } catch {}
    process.exit(2);
});
