/**
 * 法宝深线"战力加成来源清单"的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要单独一条：jest 那份 DeepLineBonusRouting 第 7 组证的是**聚合器本身**——来源清单来自内容、
 * 第四条线零代码进账。但玩家真正吃到加成还要再过两段：属性引擎的 artifact_deep_line provider
 * 与面板/战斗解析（providers.js 只认 absolute/percent 里的属性键）。这两段只有连库、连真配置才验得出来。
 *
 * 这条探针用**临时目录里的资料片**（注册一档新属性 + 给幻世轮的相位配置补一档数值字段）起一次真实启动，
 * 然后在真库上造两条深线装备行，逐段量：
 *   D1 来源清单是真内容给的（三条、每条点名的方法在服务上真的存在）
 *   D2-D3 没有深线的玩家：不生效、也不谎报（source_problems 为空 ≠ 有问题）
 *   D4 资料片往相位配置里加一档新属性 → 泛化生成器真的把它做进 combat_bonus
 *   D5-D7 聚合器零代码路由 → 属性引擎 → 面板与战斗解析（同一份数，不是另一套）
 *   D8 多条线共存时数值守恒（百分比等于各线自己那份之和，从配置现读现算）
 *   D9 内容把方法名写错：这一条要响，且不能把另外两条一起带走
 *   D10 清单缺失/为空：不能退化成"静默为 0"
 *   D11 封鞘 = 那条线不再进账（差额恰好等于它自己那份）
 *   D12 面板同步退回去（聚合口与面板不是两处各算各的）
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_deep_line_bonuses.js
 *       自建探针号 deepprobe01 与临时 pack 目录，退出前删号、删装备行、删临时目录；不改仓库里的任何 pack。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const SERVER = path.join(__dirname, '..');
const NEW_STAT = 'probe_deep';              // 只存在于临时资料片里的属性（"以后想加的那一档"）
const NEW_FIELD = `${NEW_STAT}_bonus`;      // _bonus 结尾 → 泛化规则判成绝对值（_bonus_rate 才是百分比）
const NEW_VALUE = 12;                       // 相位配置里写的基础值
const PHASE = 'rotation';                   // 血魔剑/幻世轮都用轮转相位，不需要额外玩法流程
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 浮点比较：加成是小数倍率，别用 === */
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

/** 复制现网 pack 目录，再放一个只存在于临时目录的探针资料片 */
function makeTempPackDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-deepline-'));
    const packs = path.join(root, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    for (const dir of fs.readdirSync(path.join(SERVER, 'content', 'packs'))) {
        fs.cpSync(path.join(SERVER, 'content', 'packs', dir), path.join(packs, dir), { recursive: true });
    }
    const probe = path.join(packs, 'deep_line_probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({
        id: 'deep_line_probe', name: '法宝深线属性探针', version: '1.0.0'
    }));
    fs.writeFileSync(path.join(probe, 'stat_definitions__stats.json'), JSON.stringify({
        add: [{
            key: NEW_STAT, label: '探渊', group: 'offense', unit: 'point',
            agg: 'flat_then_pct', base: { default: 0 },
            panel: { visible: true, order: 991 }, powerWeight: 0.2,
            description: '探针属性：只存在于资料片里，代码里没有第二处认识它'
        }]
    }));
    // 相位配置里的每个数值字段都会被 _calculatePhaseBonus 泛化成加成（× 阶数倍率）。
    // override 只做一层深合并，所以这里必须把整条 rotation 抄全（漏一个键就是把它删了）。
    const base = JSON.parse(fs.readFileSync(path.join(SERVER, 'config', 'artifact_deep_lines.json'), 'utf8'));
    const basePhase = base.settings.five_element_wheel.phases[PHASE];
    fs.writeFileSync(path.join(probe, 'artifact_deep_lines__settings.json'), JSON.stringify({
        comment: '探针：给幻世轮相位补一档新属性（代码里没有它的名字），看它能不能一路走到面板。',
        override: {
            five_element_wheel: {
                phases: { [PHASE]: { ...basePhase, [NEW_FIELD]: NEW_VALUE } }
            }
        }
    }));
    return { root, packs };
}

(async () => {
    const { root, packs } = makeTempPackDir();
    process.env.CONTENT_PACK_DIR = packs;

    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    const { contentRegistry } = require('../game/content');
    const loadedPackIds = ((contentRegistry() || {}).status() || {}).packs?.map(p => p.id) || [];
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const Player = require('../models/player');
    const PlayerEquipment = require('../models/playerEquipment');
    const sequelize = require('../config/database');
    const { statRegistry } = require('../game/stats');
    const { resetLogOnce } = require('../utils/logOnce');
    const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const AttributeService = require('../game/core/AttributeService');
    const combatResolver = require('../game/combat/CombatResolver');

    check('D0 临时资料片装上了（新属性与新相位字段都来自它）',
        loadedPackIds.includes('deep_line_probe') && statRegistry.has(NEW_STAT),
        `已装配=${loadedPackIds.join(', ')}｜词表 has('${NEW_STAT}')=${statRegistry.has(NEW_STAT)}`);

    /* ---------- 来源清单本身 ---------- */
    const registry = ArtifactDeepLineService.getCombatBonusSourceRegistry();
    const sourceKeys = (registry.sources || []).map(s => s.key);
    const missingMethods = (registry.sources || []).filter(s => typeof ArtifactDeepLineService[s.method] !== 'function');
    check('D1 有哪几条线进账由内容说了算，且每条点名的方法在服务上真的存在',
        registry.problem === null && sourceKeys.length >= 3
        && ['blood_sword', 'xutian_cauldron', 'five_element_wheel'].every(k => sourceKeys.includes(k))
        && missingMethods.length === 0,
        `清单=${sourceKeys.join(',')}｜problem=${registry.problem}｜取不到的方法=${missingMethods.map(s => `${s.key}.${s.method}`).join(',') || '无'}`);

    /* ---------- 探针号与两条深线装备行 ---------- */
    // player_equipment 上有 uk_player_slot(player_id, slot) 唯一索引：**每个槽位只能穿一件**，
    // 所以两条线要同时生效必须落在不同槽位（血魔剑 subtype=weapon；幻世轮 subtype=fabao，
    // 现网那行真装备记的是 dharma 槽）。深线的取数只看 player_id + item_key、不看 slot，
    // 槽位在这里唯一的作用是别撞上下标。
    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的号与装备行，换新 id 永远找不回来。
    // player_equipment 的 player_id 是"归属"列（uk_player_slot(player_id, slot) 也是这个前缀），
    // 级联会把装备行一起带走，所以这里不再手写 PlayerEquipment.destroy。
    await PlayerCascadePurge.deleteByUsernames(['deepprobe01']);
    const player = await Player.create({
        username: 'deepprobe01', password: 'not-a-real-hash', nickname: '深线探针',
        realm: '炼虚初期', realm_rank: 27, exp: 1000000, spirit_stones: 100000000,
        hp_current: 5000000, lifespan_current: 300, lifespan_max: 5000,
        attributes: {}, token_version: 0
    });

    const empty = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
    const barePanel = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('D2 没有深线装备的玩家：不生效、也不谎报有问题',
        empty.is_active === false && (empty.effects.active_sources || []).length === 0
        && (empty.source_problems || []).length === 0,
        `is_active=${empty.is_active}｜生效来源=${JSON.stringify(empty.effects.active_sources)}｜问题=${JSON.stringify(empty.source_problems)}`);
    check('D3 面板上这一档确实是 0（不是"有值但没人看"）',
        near(barePanel.final[NEW_STAT] || 0, 0), `final.${NEW_STAT}=${barePanel.final[NEW_STAT]}`);

    /* ---------- 幻世轮：内容加一档新属性 → 泛化 → 聚合 → 引擎 → 面板 ---------- */
    const wheelKey = ArtifactDeepLineService.getFiveElementWheelConfig().item_key;
    await PlayerEquipment.create({
        player_id: player.id, slot: 'dharma', item_key: wheelKey, refine_level: 0,
        is_benming: 0, spirit_power: 0, sort_order: 0, is_summoned: 0,
        deep_line_state: {
            five_element_wheel: {
                insight_stage: 1, insight_exp: 0, current_phase: PHASE, wheel_spin_enabled: false,
                last_phase_set_at: null, daily_insight_gained: 0, daily_insight_reset_at: '2026-01-01'
            }
        }
    });

    const wheelCfg = ArtifactDeepLineService.getFiveElementWheelConfig();
    const stage = (wheelCfg.stages || []).find(s => s.stage === 1) || {};
    const multiplier = stage.phase_multiplier || 1.0;
    const expectedNew = Math.round(NEW_VALUE * multiplier * 10000) / 10000;
    const expectedWheelAtkRate = Math.round((wheelCfg.phases[PHASE].atk_bonus_rate || 0) * multiplier * 10000) / 10000;

    const wheelRaw = await ArtifactDeepLineService.getFiveElementWheelCombatBonus(player.id);
    check('D4 资料片给相位配置补一档新属性，泛化生成器真的把它做进 combat_bonus（期望值现读现算）',
        wheelRaw.has_wheel === true && near(wheelRaw.combat_bonus?.[NEW_FIELD], expectedNew),
        `has_wheel=${wheelRaw.has_wheel}｜倍率=${multiplier}｜combat_bonus.${NEW_FIELD}=${wheelRaw.combat_bonus?.[NEW_FIELD]}，期望 ${expectedNew}`);

    const onlyWheel = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
    check('D5 聚合器零代码把它路由进 absolute（服务里没有出现过这个属性名）',
        near(onlyWheel.absolute[NEW_STAT], expectedNew)
        && !onlyWheel.unconsumed.some(u => u.startsWith(`five_element_wheel.${NEW_FIELD}`))
        && (onlyWheel.effects.active_sources || []).includes('five_element_wheel'),
        `absolute.${NEW_STAT}=${onlyWheel.absolute[NEW_STAT]}｜未消费项=${JSON.stringify(onlyWheel.unconsumed)}`);

    const wheelPanel = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('D6 面板算出来的是同一份数（provider 挂上了，不是"聚合口有、面板没有"）',
        near(wheelPanel.final[NEW_STAT], expectedNew),
        `面板=${wheelPanel.final[NEW_STAT]}｜聚合口=${expectedNew}`);
    const wheelCombat = await combatResolver.resolveCombatStats(await Player.findByPk(player.id));
    check('D7 战斗解析也带着这一档（面板与战斗不是两套装配）',
        near(wheelCombat.stats[NEW_STAT], expectedNew),
        `resolveCombatStats().stats.${NEW_STAT}=${wheelCombat.stats[NEW_STAT]}`);

    /* ---------- 多条线共存的数值守恒 ---------- */
    const bloodCfg = ArtifactDeepLineService.getBloodSwordConfig();
    const bloodKey = bloodCfg.item_key;
    const mkBloodState = (sheathUntil) => ({
        blood_sword: {
            blood_pact_stage: 3, blood_pact_stage_name: '探针', corruption: 0, suppression: 0,
            blood_pact_weekly_progress: 0, blood_pact_week_reset_at: '2026-01-01',
            imprint_type: 'blood', sheath_until: sheathUntil, last_sacrifice_at: null
        }
    });
    await PlayerEquipment.create({
        player_id: player.id, slot: 'weapon', item_key: bloodKey, refine_level: 0,
        is_benming: 0, spirit_power: 0, sort_order: 1, is_summoned: 0,
        deep_line_state: mkBloodState(null)
    });
    const bloodStage = (bloodCfg.blood_pact?.stages || []).find(s => s.stage === 3) || {};
    const bloodImpress = bloodCfg.imprint?.blood_imprint || {};
    const expectedBloodAtkRate = (bloodStage.atk_bonus_rate || 0) + (bloodImpress.atk_bonus_rate || 0);

    const both = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
    check('D8 两条线一起进账时数值守恒（百分比=各线自己那份之和，从配置现算）',
        near(both.percent.atk, expectedWheelAtkRate + expectedBloodAtkRate)
        && near(both.absolute[NEW_STAT], expectedNew)
        && both.effects.active_sources.length === 2
        && Object.keys(both.breakdown).length === 2
        && (both.source_problems || []).length === 0,
        `percent.atk=${both.percent.atk}，期望 ${expectedWheelAtkRate}+${expectedBloodAtkRate}｜`
        + `来源=${both.effects.active_sources.join(',')}｜问题=${JSON.stringify(both.source_problems)}`);

    /* ---------- 内容写错的两种形状都必须响 ---------- */
    const ConfigLoader = infrastructure.ConfigLoader;
    const realGetConfig = ConfigLoader.getConfig;
    const snapshot = JSON.stringify({ absolute: both.absolute, percent: both.percent, effects: both.effects });
    // 血魔剑还亮着时先量一次面板：下面封鞘后再量一次，两次之间只变了深线这一件事
    const bloodActivePanel = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));

    const errors = [];
    const realError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    resetLogOnce();
    try {
        // D9：某条线的取数方法名写错 —— 那一条要响，另外两条不能被带走
        ConfigLoader.getConfig = function (key) {
            const cfg = realGetConfig.call(this, key);
            if (key !== 'artifact_deep_lines' || !cfg) return cfg;
            return {
                ...cfg,
                combat_bonus_sources: [...(cfg.combat_bonus_sources || []),
                    { key: 'probe_bad_line', method: 'noSuchDeepLineBonusMethod', active_field: 'is_active' }]
            };
        };
        const badList = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
        check('D9 来源清单里写错方法名：这条被点名，另外两条的分文不少（不是整表作废，也不是静默跳过）',
            badList.source_problems.some(p => p.includes('probe_bad_line'))
            && JSON.stringify({ absolute: badList.absolute, percent: badList.percent, effects: badList.effects }) === snapshot
            && errors.some(e => e.includes('取不到数')),
            `问题=${JSON.stringify(badList.source_problems)}｜响过=${errors.length} 条`);

        // D10：整张清单缺失 —— 语义上等价于"所有法宝线都不进账"，这必须是一句响的话而不是一个 0
        ConfigLoader.getConfig = function (key) {
            const cfg = realGetConfig.call(this, key);
            if (key !== 'artifact_deep_lines' || !cfg) return cfg;
            const { combat_bonus_sources, ...rest } = cfg;
            return rest;
        };
        const noList = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
        check('D10 清单缺失时不静默：全部归零 + 说清为什么，is_active 也跟着 false',
            noList.is_active === false && noList.source_problems.length > 0
            && near(noList.percent.atk || 0, 0) && near(noList.absolute[NEW_STAT] || 0, 0),
            `is_active=${noList.is_active}｜problem=${JSON.stringify(noList.source_problems)}`);
    } finally {
        ConfigLoader.getConfig = realGetConfig;
        console.error = realError;
    }

    /* ---------- D13 面板那份清单与真正进战斗的那份数必须同源 ---------- */
    {
        const held = await ArtifactDeepLineService.getBloodSwordStatus(player.id);
        const rows = held?.combat_bonus_display || [];
        const shown = new Map(rows.map(r => [r.key, r]));
        const bareLabels = rows.filter(r => !r.label || r.label === r.key);
        // 报"生效"的每一档：聚合口里那一档属性必须真的带着数（不许虚报）
        const overstated = rows.filter(r => r.applied).filter(r => {
            const acc = r.bucket === 'absolute' ? both.absolute : both.percent;
            return !(Number(acc[r.target] || 0) > 0);
        });
        // 报"未生效"的必须就是 effects 桶那几档（答案只有一处，界面不许自己判断）
        const mislabeled = rows.filter(r => !r.applied && r.bucket !== 'effects');
        // 反向一半：吸血/暴击/暴伤今天一个都没进属性 —— 谁哪天把它们标成生效，这条与上面那条会一前一后红
        const leakedIntoStats = ['hp_steal_bonus_rate', 'crit_rate_bonus', 'crit_damage_bonus']
            .filter(k => shown.has(k))
            .filter(k => Number(both.percent.lifesteal || 0) !== 0
                || Number(both.percent.crit_rate || 0) !== 0
                || Number(both.percent.crit_damage || 0) !== 0);
        check('D13 面板清单=战斗数字（生效档聚合口真有数、未生效档一个都没进属性、名字全来自内容）',
            rows.length > 0 && bareLabels.length === 0 && overstated.length === 0
            && mislabeled.length === 0 && leakedIntoStats.length === 0
            && [...shown.values()].some(r => r.applied) && [...shown.values()].some(r => !r.applied),
            `清单 ${rows.length} 条（${rows.map(r => `${r.label}${r.applied ? '' : '·未生效'}`).join('、')}）`
            + `｜虚报=${overstated.map(r => r.key).join(',') || '无'}`
            + `｜漏进属性的未生效档=${leakedIntoStats.join(',') || '无'}`);
    }

    /* ---------- 封鞘：那条线自己退出，别人的分文不动 ---------- */
    const sheathed = await PlayerEquipment.findOne({ where: { player_id: player.id, item_key: bloodKey } });
    await sequelize.query(
        'UPDATE player_equipment SET deep_line_state=:s WHERE id=:id',
        {
            replacements: {
                s: JSON.stringify(mkBloodState(new Date(Date.now() + 3600 * 1000).toISOString())),
                id: sheathed.id
            }
        }
    );
    const afterSheath = await ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id);
    check('D11 封鞘后血魔剑那一份精确退出（差额=它自己那份，幻世轮不受影响）',
        near(afterSheath.percent.atk, expectedWheelAtkRate)
        && near(both.percent.atk - afterSheath.percent.atk, expectedBloodAtkRate)
        && near(afterSheath.absolute[NEW_STAT], expectedNew)
        && !afterSheath.effects.active_sources.includes('blood_sword'),
        `封鞘前=${both.percent.atk} 后=${afterSheath.percent.atk}，血魔剑那份=${expectedBloodAtkRate}｜`
        + `来源=${afterSheath.effects.active_sources.join(',')}`);
    const sheathedPanel = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('D12 面板跟着退（同一份数，不是两处各算各的）',
        near(sheathedPanel.final[NEW_STAT], expectedNew)
        && Number(bloodActivePanel.final.atk) > Number(sheathedPanel.final.atk),
        `面板 ${NEW_STAT}=${sheathedPanel.final[NEW_STAT]}｜atk 封鞘前 ${bloodActivePanel.final.atk} → 封鞘后 ${sheathedPanel.final.atk}`);

    /* ---------- 收尾：删号只走级联那扇门，装备行（player_id 归属）由它一起带走 ---------- */
    const purged = await PlayerCascadePurge.deletePlayer(player.id);
    console.log(`清理：删掉 1 个探针号（${purged.username}），级联带走 ${purged.total} 行派生数据`);
    fs.rmSync(root, { recursive: true, force: true });
    const residue = await Promise.all([
        Player.count({ where: { username: 'deepprobe01' } }),
        PlayerEquipment.count({ where: { player_id: player.id } })
    ]);
    check('TEARDOWN 探针数据与临时目录都清干净',
        residue.every(n => n === 0) && !fs.existsSync(root), `残留计数=${residue.join('/')}｜临时目录还在=${fs.existsSync(root)}`);

    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 项通过，失败 ${results.length - passed} 项`);
    process.exit(passed === results.length ? 0 : 1);
})().catch(async error => {
    console.error('探针异常:', error);
    process.exit(1);
});
