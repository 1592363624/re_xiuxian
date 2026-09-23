/**
 * "给一把刀加一个新属性"的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：jest 那份 StatExtensionReachability 证明的是内容层/引擎/公式这三段，
 * 但玩家真正看到的是 HTTP 面板与战斗结算那两条链上的装配（provider 清单、schema 下发、
 * 装备槽读取）。这条探针用一个临时目录里的资料片（新属性 + 新武器 + 新战斗档位 + 新装备槽位 +
 * 新一档灵根 + 给现网灵兽补一档属性）起一次真实启动：P1-P7 给探针号穿上那把刀，E1-E4 穿新槽位上
 * 的装备，S1-S6 建号抽灵根并量面板差值，P8-P13 走灵兽那条腿 —— 证明同一档新内容在**没有专属列的
 * 实体**上也不需要改代码、也不需要改表，属性真的算得出来、面板真的列得出来。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_stat_extension.js
 *       探针自建账号 statprobe01 与 rootprobe01..05，退出前删号并清临时目录；不改仓库里的任何 pack。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const SERVER = path.join(__dirname, '..');
const results = [];
/** 灵根那一段建的号（模块作用域：崩了也要能在 catch 里按账号名收干净） */
const ROOT_PROBE_NAMES = ['rootprobe01', 'rootprobe02', 'rootprobe03', 'rootprobe04', 'rootprobe05'];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 复制现网三个 pack，再放一个只存在于临时目录的探针 pack */
function makeTempPackDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-pack-'));
    const packs = path.join(root, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    for (const dir of fs.readdirSync(path.join(SERVER, 'content', 'packs'))) {
        fs.cpSync(path.join(SERVER, 'content', 'packs', dir), path.join(packs, dir), { recursive: true });
    }
    const probe = path.join(packs, 'stat_probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({ id: 'stat_probe', name: '属性探针', version: '1.0.0' }));
    fs.writeFileSync(path.join(probe, 'stat_definitions__stats.json'), JSON.stringify({
        add: [{
            key: 'probe_pierce', label: '破阵', group: 'offense', unit: 'point',
            agg: 'flat_then_pct', base: { default: 0 },
            panel: { visible: true, order: 990 }, powerWeight: 0.2,
            battleRoles: ['attack_probe'], description: '探针属性：只存在于资料片里'
        }]
    }));
    fs.writeFileSync(path.join(probe, 'item_data__items.json'), JSON.stringify({
        add: [{
            id: 'probe_blade', name: '试剑刀', type: 'equipment', subtype: 'weapon', quality: 'rare',
            description: '探针武器', effect: { probe_pierce: 77, atk: 10 }, price: 100, required_realm_rank: 1
        }, {
            // 第二件：subtype 用的是**这个 pack 自己新增的槽位**（见下面 game_balance__equipment__slot_names.json）
            id: 'probe_banner', name: '探针旗', type: 'equipment', subtype: 'probe_slot', quality: 'rare',
            description: '探针旗帜：证明"资料片加一档槽位"零代码', effect: { probe_pierce: 11, def: 30 },
            price: 100, required_realm_rank: 1
        }]
    }));
    // 槽位词表登记成了 map 集合（2026-09-22），所以"加一档新槽位"就是一条内容。
    // 文件名里的第三段会还原成 `into` 路径 `equipment.slot_names`（ContentRegistry 按剩余段 join('.')）。
    fs.writeFileSync(path.join(probe, 'game_balance__equipment__slot_names.json'), JSON.stringify({
        add: [{ id: 'probe_slot', label: '探针槽' }]
    }));
    fs.writeFileSync(path.join(probe, 'combat_formulas__profiles.json'), JSON.stringify({
        add: [{ id: 'probe_duel', label: '探针档位', attack_stat: 'probe_pierce', mitigate_stat: 'def', skill_multiplier: 1, defense_coef: 1, min_damage: 1 }]
    }));
    // 灵根三件套同样登记成了集合（2026-09-22，任务 #29）：概率表/加成表是 map 集合，所以资料片
    // 加的条目必然是对象形状（{id,value}）—— 下面 S 段量的是"读取端认不认得这个形状"。
    fs.writeFileSync(path.join(probe, 'role_init__spirit_roots.json'), JSON.stringify({
        dataset: 'role_init', into: 'spirit_roots',
        comment: '探针灵根：只存在于资料片里，用来量"加一档灵根要不要改代码"。',
        add: [{ id: 'star', name: '星', displayName: '星', type: 'star', description: '探针灵根' }]
    }));
    fs.writeFileSync(path.join(probe, 'role_init__spiritRootProbabilities.json'), JSON.stringify({
        dataset: 'role_init', into: 'spiritRootProbabilities', add: [{ id: '星', value: 0.05 }]
    }));
    fs.writeFileSync(path.join(probe, 'role_init__spiritRootBonuses.json'), JSON.stringify({
        dataset: 'role_init', into: 'spiritRootBonuses', add: [{ id: '星', atk: 3, crit_rate: 0.01 }]
    }));
    // 相克表也登记成了 map 集合（任务 #30）：新灵根不该只会"契合"。片里写的是对象条目（counters 数组），
    // 读取端过 contentList —— 只认 Array.isArray 的话这条会被静默丢掉，而面板与契合照常工作、没有任何信号。
    fs.writeFileSync(path.join(probe, 'technique_data__element_match__conflicts.json'), JSON.stringify({
        dataset: 'technique_data', into: 'element_match.conflicts', add: [{ id: 'star', counters: ['metal'] }]
    }));
    // 第二个对象类型：灵兽。spirit_beasts 上只有 hp_max/atk/def/speed 四个属性列，
    // 所以"给一只现网灵兽加一档新属性"走的是 stat_block 属性块（migration_0088）——
    // 这条腿证明的是同一档新属性在**第二种实体**上也不需要改代码、也不需要改表。
    const beastFile = path.join(SERVER, 'config', 'spirit_beast_data.json');
    const existingBeastKey = (JSON.parse(fs.readFileSync(beastFile, 'utf8')).beast_types || [])[0]?.beast_key;
    if (existingBeastKey) {
        fs.writeFileSync(path.join(probe, 'spirit_beast_data.json'), JSON.stringify({
            dataset: 'spirit_beast_data',
            into: 'beast_types',
            comment: '探针：给现网第一只灵兽种类补一档没有专属列的属性（用 override，base_* 之外的字段原样保留）。',
            override: { [existingBeastKey]: { base_probe_pierce: 30 } }
        }));
    }
    return { root, packs, beastKey: existingBeastKey };
}

(async () => {
    const { root, packs, beastKey } = makeTempPackDir();
    process.env.CONTENT_PACK_DIR = packs;

    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    const { contentRegistry } = require('../game/content');
    const content = contentRegistry();
    const loadedPackIds = (content && content.status().packs || []).map(p => p.id);
    check('P0 启动时读到了临时 pack 目录里的资料片', loadedPackIds.includes('stat_probe'),
        `已装配：${loadedPackIds.join(', ') || '(空)'}（CONTENT_PACK_DIR=${packs}）`);

    await require('../game').initializeGameServices(infrastructure.ConfigLoader);
    const { statRegistry } = require('../game/stats');

    const Player = require('../models/player');
    const InventoryService = require('../game/services/InventoryService');
    const EquipmentService = require('../game/services/EquipmentService');
    const AttributeService = require('../game/core/AttributeService');
    const combatResolver = require('../game/combat/CombatResolver');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    // 词表与面板 schema
    check('P1 新属性进了词表', statRegistry.has('probe_pierce'), `has('probe_pierce')=${statRegistry.has('probe_pierce')}`);
    const panel = await AttributeService.getPanelSchema();
    const panelKeys = JSON.stringify(panel);
    check('P2 面板 schema 里出现了新属性（客户端不用改代码就能显示）',
        panelKeys.includes('probe_pierce') && panelKeys.includes('破阵'),
        `schema 命中 probe_pierce=${panelKeys.includes('probe_pierce')} 破阵=${panelKeys.includes('破阵')}`);

    // 建号 → 发刀 → 穿上 → 算属性
    // 境界必须用 realm_breakthrough 里的**真名号**：写成"炼气初期"这种不存在的名字，
    // AttributeService 会按定义里的 default 兜底（境界加成全丢），面板照开、探针照绿，量到的却是假的。
    const PROBE_REALM = '炼气1层';
    const realmNames = new Set(((infrastructure.ConfigLoader.getConfig('realm_breakthrough') || {}).realms || [])
        .map(r => r.name));
    check('P0b 探针用的境界名在内容里真的存在（否则属性按 default 兜底，测出来的"正常"是假的）',
        realmNames.has(PROBE_REALM), `realm='${PROBE_REALM}' 在 realm_breakthrough 里=${realmNames.has(PROBE_REALM)}`);
    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的灵兽/背包行，新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames(['statprobe01']);
    const player = await Player.create({
        username: 'statprobe01', password: 'not-a-real-hash', nickname: '属性探针',
        realm: PROBE_REALM, realm_rank: 1, exp: 0, spirit_stones: 10000,
        hp_current: 5000, mp_current: 500, lifespan_current: 1, lifespan_max: 60,
        attributes: {}, token_version: 0
    });
    await InventoryService.addItem(player.id, 'probe_blade', 1, null);
    const equipped = await EquipmentService.equip(player.id, 'probe_blade');
    check('P3 带上只存在于资料片里的武器', equipped.success !== false && !!equipped,
        JSON.stringify(equipped && (equipped.message || equipped.success || equipped)).slice(0, 120));

    const fresh = await Player.findByPk(player.id);
    const attrs = await AttributeService.calculateFullAttributesAsync(fresh);
    check('P4 装备效果里的新属性真的算进了最终属性（77）',
        Number(attrs.final.probe_pierce) === 77,
        `final.probe_pierce=${attrs.final.probe_pierce}；来源=${JSON.stringify((attrs.by_stat || attrs.breakdown || {}).probe_pierce || '').slice(0, 160)}`);

    const combat = await combatResolver.resolveCombatStats(fresh);
    check('P5 战斗属性解析也带着它（战斗侧不需要为新材料改代码）',
        Number(combat.stats.probe_pierce) === 77,
        `resolveCombatStats().stats.probe_pierce=${combat.stats.probe_pierce}`);

    const dmg = combatResolver.computeDamage('probe_duel', {
        attackerStats: combat.stats, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
    });
    check('P6 用新属性当攻击项的战斗档位能结算', dmg.attack === 77 && dmg.damage > 0,
        `profile=${dmg.profile} attack=${dmg.attack} damage=${dmg.damage}`);

    // 单调性：属性值变大伤害必须跟着变大 —— 否则"结算得出 1"可能只是被 min_damage 兜住的空测
    const big = combatResolver.computeDamage('probe_duel', {
        attackerStats: { probe_pierce: 7777 }, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
    });
    check('P6b 新属性真的在驱动公式（值变大 → 伤害变大，不是被 min_damage 兜底）',
        big.damage > dmg.damage, `probe_pierce 77 → ${dmg.damage}；7777 → ${big.damage}`);

    // 反证：没穿刀时这一项应当回到内容声明的 default（0），而不是 undefined 或旧值
    await EquipmentService.unequip ? await EquipmentService.unequip(player.id, 'weapon') : null;
    const bare = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('P7 卸掉武器后新属性回到内容声明的默认值（不是 undefined）',
        Number(bare.final.probe_pierce) === 0,
        `final.probe_pierce=${bare.final.probe_pierce}`);

    // ============ 资料片新增一档"装备槽位"：词表 → 校验 → 穿戴 → 面板（任务 #28）============
    // 以前槽位清单是一份裸字符串数组（game_balance.equipment.valid_slots），不能按条增删，
    // 于是"加一件新装备"能做成、"加它要进的那个槽位"做不到 —— 那件装备会被启动自检判成永远穿不上的死内容
    // （现网真的出现过一件：五行神光旗 subtype 写成 artifact）。现在槽位词表登记成了 map 集合，这一段证明闭环。
    {
        const PlayerEquipment = require('../models/playerEquipment');
        const vocab = EquipmentService.slotVocabulary();
        check('E1 资料片只加一条内容就扩了一档槽位（probe_slot / 探针槽），且基础槽位顺序没被打乱',
            vocab.slots.includes('probe_slot') && vocab.labels.probe_slot === '探针槽'
            && vocab.slots.slice(0, 6).join(',') === 'weapon,armor,accessory,boots,dharma,fabao'
            && vocab.missingLabel.length === 0,
            `槽位=${vocab.slots.join('/')}｜新档=${vocab.labels.probe_slot}｜缺名字=${vocab.missingLabel.join(',') || '无'}`);

        const before = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
        await InventoryService.addItem(player.id, 'probe_banner', 1, null);
        const putOn = await EquipmentService.equip(player.id, 'probe_banner');
        const row = await PlayerEquipment.findOne({ where: { player_id: player.id, item_key: 'probe_banner' } });
        check('E2 新槽位真的能穿：equip 的合法集与词表同源（没有第二处登记），落库 slot=probe_slot',
            putOn.success === true && putOn.slot === 'probe_slot' && putOn.slot_name === '探针槽'
            && row?.slot === 'probe_slot',
            `返回 success=${putOn.success} slot=${putOn.slot} slot_name=${putOn.slot_name}｜库里 slot=${row?.slot}`);

        const withBanner = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
        check('E3 新槽位上的装备照样进面板（probe_pierce +11、def +30 就是内容里写的那两个数）',
            Number(withBanner.final.probe_pierce) - Number(before.final.probe_pierce) === 11
            && Number(withBanner.final.def) - Number(before.final.def) === 30,
            `probe_pierce ${before.final.probe_pierce}→${withBanner.final.probe_pierce}｜def ${before.final.def}→${withBanner.final.def}`);

        const off = await EquipmentService.unequip(player.id, 'probe_slot');
        const residue = await PlayerEquipment.count({ where: { player_id: player.id, slot: 'probe_slot' } });
        check('E4 新槽位也能卸（unequip 用同一份词表），卸完不留行',
            off.success === true && off.slot_name === '探针槽' && residue === 0,
            `${off.message || JSON.stringify(off).slice(0, 100)}｜残留行=${residue}`);
    }

    // ================= 灵根那一腿：资料片加一档灵根，建号与面板都不改代码（任务 #29）=================
    // 灵根以前是全仓最典型的"配了不生效"：provider 读的是根本不存在的 player.spirit_root 列，
    // 于是加成永远是 0；概率表与声明表两套键没人对过，键写错就是那一档谁也抽不到。
    // 这一段量的就是修完之后：合并视图有没有回灌到 getConfig、归一化抽得到新档、加成真的进面板。
    {
        const PlayerService = require('../game/core/PlayerService');
        const { rollSpiritRoot, resolveSpiritRoot } = require('../game/stats/SpiritRoot');
        const liveRoleInit = infrastructure.ConfigLoader.getConfig('role_init');
        const declaredNames = (liveRoleInit.spirit_roots || []).map(r => r.name);

        check('S1 资料片加的灵根回灌进了 getConfig("role_init")（不是只有 ContentRegistry 看得见）',
            declaredNames.includes('星') && Number(liveRoleInit.spiritRootProbabilities['星']?.value) === 0.05
            && Number(liveRoleInit.spiritRootBonuses['星']?.atk) === 3,
            `声明档=${declaredNames.join('/')}｜片里的概率=${JSON.stringify(liveRoleInit.spiritRootProbabilities['星'])}`);

        const roll = rollSpiritRoot(liveRoleInit, 0.999);
        check('S2 归一化活体：片加一档不必回头改其余五条，roll_enabled:false 的雷/冰/风进不了池子',
            roll.pool.includes('星') && Math.abs(roll.totalWeight - 1.05) < 1e-9
            && !['雷', '冰', '风'].some(name => roll.pool.includes(name)) && roll.name === '星',
            `池子=${roll.pool.join('/')}｜总权=${roll.totalWeight}（基础 1 + 片里 0.05）｜ratio=0.999 → ${roll.name}`);

        // 建号走真实入口：把 Math.random 钉成 0.999，那一次掷骰必然落在池子末尾（= 片里的新档）
        await PlayerCascadePurge.deleteByUsernames(ROOT_PROBE_NAMES);
        const realRandom = Math.random;
        Math.random = () => 0.999;
        let created;
        try {
            created = await PlayerService.initializePlayer('rootprobe01', 'not-a-real-hash', '灵根探针');
        } finally {
            Math.random = realRandom;
        }
        const rolled = created?.spirit_roots;
        check('S3 建号真的抽到了资料片那档新灵根，并且存进 players.spirit_roots 的形状可被解析',
            !!rolled && Object.keys(rolled).join() === '星灵根' && resolveSpiritRoot(created, liveRoleInit)?.type === 'star',
            `库里=${JSON.stringify(rolled)}｜解析 type=${resolveSpiritRoot(created, liveRoleInit)?.type}`);

        // 同境界、同 attributes 的两个号相比，差值只可能来自 spirit_roots 那一条。
        // 境界名必须先确认存在（同 P0b 的教训）：名字不存在时 AttributeService 按 default 兜底，
        // 两边都兜底 → 差值照样是 0/3/4，量到的"正常"却是假的。
        const baseRealm = '凡人';
        check('S4a 对照组用的境界名在内容里真的存在（否则属性按 default 兜底，差值是白捡的）',
            realmNames.has(baseRealm),
            `realm='${baseRealm}' 在 realm_breakthrough 里=${realmNames.has(baseRealm)}`);
        const bareRow = await Player.create({
            username: 'rootprobe02', password: 'not-a-real-hash', nickname: '无灵根对照',
            realm: baseRealm, exp: 0, attributes: {}, spirit_roots: {}, hp_current: 100, lifespan_current: 16, lifespan_max: 60
        });
        const bareAttrs = await AttributeService.calculateFullAttributesAsync(bareRow);
        async function rootDelta(username, spiritRoots, label) {
            const row = await Player.create({
                username, password: 'not-a-real-hash', nickname: label, realm: baseRealm, exp: 0,
                attributes: {}, spirit_roots: spiritRoots, hp_current: 100, lifespan_current: 16, lifespan_max: 60
            });
            const attrs = await AttributeService.calculateFullAttributesAsync(row);
            return {
                row,
                atk: Number(attrs.final.atk) - Number(bareAttrs.final.atk),
                def: Number(attrs.final.def) - Number(bareAttrs.final.def),
                crit: Number(attrs.final.crit_rate ?? 0) - Number(bareAttrs.final.crit_rate ?? 0),
                raw: attrs.final
            };
        }

        const star = await rootDelta('rootprobe03', { '星灵根': { level: '基础', affinity: 90 } }, '星灵根');
        check('S4 资料片那档灵根的加成零代码进面板（atk +3、crit_rate +0.01 就是片里写的两个数）',
            star.atk === 3 && Math.abs(star.crit - 0.01) < 1e-9,
            `atk 差=${star.atk}｜crit_rate 差=${star.crit}｜对照号 atk=${bareAttrs.final.atk}`);

        const metal = await rootDelta('rootprobe04', { '金灵根': { level: '基础', affinity: 88 } }, '金灵根');
        check('S5 基础那几条灵根没被这次改动弄坏（金：atk +4、def +2）',
            metal.atk === 4 && metal.def === 2,
            `atk 差=${metal.atk}｜def 差=${metal.def}`);

        // 控制跑：一条 spirit_roots 里查无此根的写法（老数据/手改库都会出现）必须"什么都不加"，
        // 而不是把某条别的加成算到它头上 —— 否则上面两条的差值是白捡的。
        const ghost = await rootDelta('rootprobe05', { '查无此根灵根': { level: '基础', affinity: 99 } }, '幽灵灵根');
        check('S6 控制跑：spirit_roots 里查无此根 → 解析为 null、加成差 0（差值不是白捡的）',
            resolveSpiritRoot(ghost.row, liveRoleInit) === null && ghost.atk === 0 && ghost.def === 0,
            `解析=${JSON.stringify(resolveSpiritRoot(ghost.row, liveRoleInit))}｜atk 差=${ghost.atk}｜def 差=${ghost.def}`);

        // 相克这一腿：片里给 star 补了一条 star→metal，TechniqueService 必须当场认得（对象形状）。
        // 期望系数从生效配置现读现算，不写死 0.85。
        const TechniqueService = require('../game/services/TechniqueService');
        const liveTechnique = infrastructure.ConfigLoader.getConfig('technique_data');
        const penalty = 1 - Number(liveTechnique.element_match.conflict_penalty_pct) / 100;
        const matchBonus = 1 + Number(liveTechnique.element_match.match_bonus_pct) / 100;
        const starPlayer = { spirit_roots: { '星灵根': { level: '基础', affinity: 90 } } };
        check('S7 资料片补的那条相克生效（对象形状经 contentList 被认得），契合也照常生效',
            Array.isArray(liveTechnique.element_match.conflicts.star) === false
            && Math.abs(TechniqueService.getElementMultiplier(starPlayer, 'metal') - penalty) < 1e-9
            && Math.abs(TechniqueService.getElementMultiplier(starPlayer, 'star') - matchBonus) < 1e-9,
            `片里那条的形状=${JSON.stringify(liveTechnique.element_match.conflicts.star)}｜星×metal=${TechniqueService.getElementMultiplier(starPlayer, 'metal')}（期望 ${penalty}）｜星×star=${TechniqueService.getElementMultiplier(starPlayer, 'star')}（期望 ${matchBonus}）`);

        check('S8 控制跑：星只克 metal —— 克不到的属性系数是 1.0；基础数组形状那条（火克金）没被弄坏',
            TechniqueService.getElementMultiplier(starPlayer, 'wood') === 1.0
            && Math.abs(TechniqueService.getElementMultiplier({ spirit_roots: { type: 'fire' } }, 'metal') - penalty) < 1e-9,
            `星×wood=${TechniqueService.getElementMultiplier(starPlayer, 'wood')}｜火×metal=${TechniqueService.getElementMultiplier({ spirit_roots: { type: 'fire' } }, 'metal')}`);

        const purgedRoots = await PlayerCascadePurge.deletePlayers(
            [created, bareRow, star.row, metal.row, ghost.row].map(row => row.id));
        console.log(`清理：灵根探针号删掉 ${purgedRoots.ids.length} 个（建的那批 5 个都在里面），级联带走 ${purgedRoots.total} 行派生数据`);
    }

    // ================= 灵兽那一腿：同一档新属性，换一种实体（没有专属列）=================
    const SpiritBeast = require('../models/spiritBeast');
    const SpiritBeastService = require('../game/services/SpiritBeastService');
    const beastConfig = infrastructure.ConfigLoader.getConfig('spirit_beast_data');
    const beastType = (beastConfig?.beast_types || []).find(b => b.beast_key === beastKey);
    check('P8 资料片给现网灵兽补了一档 spirit_beasts 上没有列的属性',
        !!beastType && beastType.base_probe_pierce !== undefined,
        `beast_key=${beastKey} base_probe_pierce=${beastType?.base_probe_pierce}`);

    // 灵兽行按 player_id 归属：开头那次"按账号名删号"已经把它一起收掉了，这里不再手写清单
    const beast = await SpiritBeast.create({
        player_id: player.id, beast_key: beastKey, beast_name: '探针灵兽', element: beastType.element,
        rarity: beastType.rarity, star_level: 2, level: 7, exp: 0, loyalty: 50,
        hp_max: 1000, atk: 100, def: 50, speed: 20, is_active: false
    });
    // 走真实的重算入口（升级/升星/GM 发放都是这一条），再存盘
    SpiritBeastService.applyComputedStats(beast, SpiritBeastService.computeStats(beastType, 7, 2));
    await beast.save();
    const storedRow = await SpiritBeast.findByPk(beast.id);
    const expectedBeastStat = SpiritBeastService.computeStats(beastType, 7, 2).stat_block?.probe_pierce;
    check('P9 新属性真的落进了 spirit_beasts.stat_block（过一遍 MySQL 的 JSON 列，读回来还在）',
        expectedBeastStat > 0 && Number(storedRow?.stat_block?.probe_pierce) === expectedBeastStat,
        `期望 ${expectedBeastStat}，库里 ${JSON.stringify(storedRow?.stat_block)}；四项老属性=${[storedRow?.hp_max, storedRow?.atk, storedRow?.def, storedRow?.speed].join('/')}`);

    await SpiritBeast.update({ is_active: true }, { where: { id: beast.id } });
    const beastBonus = await SpiritBeastService.getActiveBeastBonus(player.id);
    check('P10 出战灵兽把这一档折算给玩家（服务侧系数生效，且不是 0）',
        Number(beastBonus?.probe_pierce) > 0,
        `bonus.probe_pierce=${beastBonus?.probe_pierce}（灵兽行上 ${expectedBeastStat}）`);

    const withBeast = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('P11 玩家面板上的这一项 == 灵兽折算值（面板不是另一套数）',
        Number(withBeast.final.probe_pierce) === Number(beastBonus.probe_pierce),
        `面板=${withBeast.final.probe_pierce} 灵兽折算=${beastBonus.probe_pierce}`);

    const withBeastCombat = await combatResolver.resolveCombatStats(await Player.findByPk(player.id));
    check('P12 战斗属性解析也带着灵兽给的这一档',
        Number(withBeastCombat.stats.probe_pierce) === Number(beastBonus.probe_pierce),
        `resolveCombatStats().stats.probe_pierce=${withBeastCombat.stats.probe_pierce}`);

    await SpiritBeast.update({ is_active: false }, { where: { id: beast.id } });
    const noBeast = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('P13 收起灵兽后这一档归零（灵兽不是常驻加成）',
        Number(noBeast.final.probe_pierce) === 0,
        `final.probe_pierce=${noBeast.final.probe_pierce}`);

    // 收尾只叫一次"删号"：spirit_beasts / player_items 这些按 player_id 归属的行由级联带走
    const purged = await PlayerCascadePurge.deletePlayers([player.id]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
    fs.rmSync(root, { recursive: true, force: true });
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['statprobe01', ...ROOT_PROBE_NAMES]);
    } catch {}
    process.exit(2);
});
