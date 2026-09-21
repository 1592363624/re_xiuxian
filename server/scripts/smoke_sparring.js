/**
 * 切磋木人端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：jest 里那 4800 个等价点证明的是"伤害算式与改造前逐点相同"，
 * 但切磋真正跑起来还要过 AttributeService、每日次数、冷却、BigInt 记账、评分入库。
 * 更要紧的是：改造前这个服务的配置是 `require('../../config/sparring_woodman.json')`，
 * 于是资料片无论加什么木人都永远不会出现在切磋里 —— 这种"看起来是内容、其实被代码焊死"
 * 的接线问题只有起一次真的进程才看得到。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_sparring.js
 * 探针自建/复用单个专用玩家 spartest01，只动它自己的行，跑完清掉自己的切磋记录。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5088);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerSparring = require('../models/playerSparring');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const SparringService = require('../game/services/SparringService');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const { contentRegistry } = require('../game/content');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer() {
    // 用一个"能赢但要打上几回合"的修士：一记秒掉木人的话，日志里既没有木人回击、
    // 也看不出技能/普攻两档是不是都在跑，S2/S4 就退化成只看一记。筑基中期大约五回合解决第一档。
    const RealmService = require('../game/core/RealmService');
    const realm = RealmService.getRealmByName('筑基中期');
    let player = await Player.findOne({ where: { username: 'spartest01' } });
    if (!player) {
        player = await Player.create({
            username: 'spartest01',
            password: 'not-a-real-hash',
            nickname: '切磋探针',
            realm: realm.name,
            realm_rank: realm.rank
        });
    } else {
        await PlayerStateStore.patchPlayerState(player.id, {
            columns: { realm: realm.name, realm_rank: realm.rank }
        });
        player = await Player.findByPk(player.id);
    }
    // 每日 5 次与冷却会挡住重复运行：清掉探针自己的记录（只删自己玩家的行）
    await PlayerSparring.destroy({ where: { player_id: player.id } });
    return player;
}

(async () => {
    await bootApp(app, { port: PORT });

    const player = await ensurePlayer();

    // S0 配置来源：服务读的必须是内容层的合并视图，而不是被 require 焊死的那份文件
    const viaLoader = configLoader.getConfig('sparring_woodman');
    const viaContentLayer = contentRegistry().dataset('sparring_woodman');
    check('S0 切磋配置来自内容层合并视图（资料片加的东西才可能进切磋）',
        !!viaLoader && viaLoader === viaContentLayer && (viaLoader.woodmen || []).length >= 5,
        `loader=${!!viaLoader} 同一对象=${viaLoader === viaContentLayer} 木人 ${(viaLoader && viaLoader.woodmen || []).length} 个`);

    const tier1 = viaLoader.woodmen.find(w => w.key === 'qi_refining');
    const g = viaLoader.global;
    // 战斗里用的就是这份解析结果（含装备/灵兽/称号）；开打前取一次，避免与战后发的奖励混在一起
    const AttributeService = require('../game/core/AttributeService');
    const before = (await AttributeService.calculateFullAttributesAsync(player)).final || {};

    const started = await SparringService.startSparring(player.id, 'qi_refining');
    const battle = started && started.battle;
    check('S1 切磋能开打完并给出结果与评分（改造前从这里开始全是私有公式与私有配置）',
        !!battle && ['win', 'lose', 'timeout'].includes(battle.result) && Number(started.score) > 0,
        `结果=${battle && battle.result} 回合=${battle && battle.rounds}/${g.max_rounds} 分=${started && started.score} ${started && started.message ? started.message : ''}`);
    if (!battle) return finish();

    const hits = (battle.log || []).flatMap(entry => entry.actions || []);
    check('S2 战斗日志里两档出手与木人回击都出现了，且每一记伤害都是正整数（BigInt 记账安全）',
        hits.length > 2 && hits.some(h => h.attacker === 'woodman') && hits.some(h => h.action === 'skill')
            && hits.every(h => Number.isInteger(Number(h.damage)) && Number(h.damage) >= 1),
        `出手 ${hits.length} 记，样本=${hits.slice(0, 4).map(h => `${h.attacker}:${h.action}:${h.damage}`).join(' ')}`);

    check('S3 木人的血量取自内容声明（资料片改这个数字，切磋当场就跟着变）',
        String(battle.woodman_hp_max) === String(tier1.stats.max_hp)
            && (battle.result === 'win' ? BigInt(battle.woodman_hp_remaining) <= 0n : BigInt(battle.woodman_hp_remaining) > 0n)
            && BigInt(battle.player_hp_remaining) >= 0n,
        `内容 max_hp=${tier1.stats.max_hp} 结算 max_hp=${battle.woodman_hp_max} 剩余=${battle.woodman_hp_remaining} 玩家余血=${battle.player_hp_remaining}`);

    // 与改造前那条内联算式同带：普攻 = 攻 - 防 + [0, range-1] - offset（夹 1 保底）；技能 = 整带乘倍率后取整
    const playerAtk = Number(before.atk) || 10;
    const playerDef = Number(before.def) || 5;
    const bandOf = (raw) => {
        const lo = Math.max(1, raw - Number(g.damage_random_offset));
        const hi = Math.max(1, raw + Number(g.damage_random_range) - 1 - Number(g.damage_random_offset));
        return [lo, hi];
    };
    const outOfBand = [];
    for (const hit of hits) {
        const raw = hit.attacker === 'player' ? playerAtk - Number(tier1.stats.def) : Number(tier1.stats.atk) - playerDef;
        let [lo, hi] = bandOf(raw);
        if (hit.action === 'skill') {
            lo = Math.floor(lo * Number(g.skill_damage_multiplier));
            hi = Math.floor(hi * Number(g.skill_damage_multiplier));
        }
        if (Number(hit.damage) < lo || Number(hit.damage) > hi) {
            outOfBand.push(`${hit.attacker}/${hit.action}:${hit.damage}∉[${lo},${hi}]`);
        }
    }
    check('S4 每一记伤害只可能来自改造前那条算式的取值带（数值等价性在真实链路上成立）',
        outOfBand.length === 0,
        `玩家 atk=${playerAtk} def=${playerDef}（含装备），越界=${outOfBand.slice(0, 3).join(' ') || '无'}`);

    const mpUses = hits.filter(h => h.action === 'skill').length;
    check('S5 蓝条仍然管着技能：MP 用量 = 技能次数 × 单次消耗，且不超过上限',
        BigInt(battle.player_mp_used) === BigInt(mpUses * Number(g.skill_mp_cost))
            && mpUses > 0 && mpUses * Number(g.skill_mp_cost) <= Number(before.mp_max || 0),
        `技能 ${mpUses} 次，耗蓝=${battle.player_mp_used}，单次=${g.skill_mp_cost}，上限=${before.mp_max}`);

    await PlayerSparring.destroy({ where: { player_id: player.id } });
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
