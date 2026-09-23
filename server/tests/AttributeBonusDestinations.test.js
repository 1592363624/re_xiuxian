/**
 * 每一条"属性/战力加成"聚合器都必须有归宿（2026-09-21，任务 #20）
 *
 * 形状是这样的：服务里有一个 `getXxxBonus()` 把某个系统的加成算出来，注释或文案写着
 * "提供 N% 属性加成"。它真正的归宿只有三种：
 *   provider     —— 挂在 `game/stats/providers.js` 上，进属性引擎（面板/战力/战斗一起吃）
 *   consumer     —— 被某个具体的结算点直接调用（例：兽潮减伤、傀儡折算、炼丹产能）
 *   display_only —— 只发给人看（这种最危险：玩家以为自己有）
 * 前两处都没落地、又没登记成第三种结论的，就是"配了、印了、玩家没拿到"。
 *
 * 现网已经量到两例，都不擅自接（接上等于凭空给一批玩家加属性，是平衡决定）：
 *   - `ArtifactSpiritService.getCombatBonus` 注释写"供 AttributeService 调用"，provider 名单里没有它；
 *   - `NascentSoulService.getDharmaFormBonus`：法相天地按等级"每级 +5% 全属性"（满级 9 级 = +45%），
 *     服务端只把它当 `dharma_form_bonus` 系数发给人看（routes/breakthrough.js:398），
 *     `game/core` / `game/stats` / `game/combat` 三处对 dharma 零引用 —— 玩家花灵石与感悟升上来的
 *     属性加成从未进过属性。同一个系统的"每级 +2% 飞升成功率"倒是真的生效（AscensionService:379）。
 *
 * 这条闸不判"该不该接"，只判"有没有人说清它去哪"。新增一个 getXxxBonus 而不写归宿 → 红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const serverRoot = path.join(__dirname, '..');
const PROVIDERS = fs.readFileSync(path.join(serverRoot, 'game/stats/providers.js'), 'utf8');

/**
 * 归宿台账。verdict 只许三种，`consumer` 与 `display_only` 必须写清是哪一个调用点。
 * 判法（写结论前逐条走完，别只看命中行）：谁调用它 → 调用点把结果用在哪 → 若声称"属性加成"，属性引擎里有没有对应来源。
 */
const DESTINATIONS = {
    'ArtifactDeepLineService.getBloodSwordCombatBonus': { verdict: 'consumer', reason: '只被同文件的统一聚合口 getAllArtifactDeepLineCombatBonuses 取用，聚合后进 artifact_deep_line provider' },
    'ArtifactDeepLineService.getXutianCauldronCombatBonus': { verdict: 'consumer', reason: '只被同文件的统一聚合口 getAllArtifactDeepLineCombatBonuses 取用（虚天鼎那条线的分量）' },
    'ArtifactDeepLineService.getFiveElementWheelCombatBonus': { verdict: 'consumer', reason: '只被同文件的统一聚合口 getAllArtifactDeepLineCombatBonuses 取用（幻世轮那条线的分量）' },
    'SpiritBeastService.getActiveBeastBonus': { verdict: 'provider', provider: 'spirit_beast' },
    'PuppetService.getBattlePuppetBonus': { verdict: 'provider', provider: 'puppet' },
    'TechniqueService.getTechniqueBonus': { verdict: 'provider', provider: 'technique' },
    'EquipmentService.getEquipmentBonus': { verdict: 'provider', provider: 'equipment' },
    'ReincarnationService.getInheritanceBonus': {
        verdict: 'provider',
        provider: 'reincarnation',
        reason: '2026-09-22 新增：夺舍继承的账由 chooseTarget 按 inherit_ratio 算好写进 players.attributes.reincarnation_bonus，'
            + '这个取数函数是它的唯一读点，接在 providers.js 第 10 个来源上（并支持 sourceOverrides 清零，供服务算本次差值）'
    },
    'ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses': { verdict: 'provider', provider: 'artifact_deep_line' },
    'ArtifactDeepLineService.getCombatBonusSourceRegistry': {
        verdict: 'consumer',
        reason: '它不产出任何加成数值，只把内容表 artifact_deep_lines.combat_bonus_sources 那份"有哪几条深线、各自怎么取数"的清单 '
            + '交给同文件的统一聚合口 getAllArtifactDeepLineCombatBonuses 逐条取数（聚合器因此不再点名 blood_sword/xutian_cauldron/…）。'
            + '所以它的归宿是 provider 的那一条，本条只是清单交接'
    },
    'ArtifactSpiritService.getCombatBonus': {
        verdict: 'display_only',
        pending: 'orphan_pending_owner_decision',
        reason: '注释写"供 AttributeService 调用"，但 providers.js 的 9 个来源里没有器灵，全仓也没有第二个调用点；'
            + '器灵的 atk/def/crit/dodge 百分比加成从未进过玩家属性。接上等于给后期法宝凭空一套加成（平衡改动），'
            + '且它写的 percent.crit/dodge 不是注册表键名（应为 crit_rate/dodge_rate），接之前要先改键名口径'
    },
    'NascentSoulService.getDharmaFormBonus': {
        verdict: 'display_only',
        pending: 'attribute_promise_not_applied_pending_owner_decision',
        reason: '法相天地每级 +5% 全属性（配置 dharma_form.attribute_bonus_per_level，满级 9 级 = +45%），'
            + '服务端只在 routes/breakthrough.js:398 把它当 dharma_form_bonus 系数发给客户端展示；'
            + 'game/core、game/stats、game/combat 对 dharma 零引用 → 玩家花钱与感悟升上来的"全属性加成"从未进属性。'
            + '同系统的"每级 +2% 飞升成功率"倒是生效（AscensionService:379），所以这是半条链没接。'
            + '接法很小（providers.js 加一档：对注册表每个属性给 pct=level×0.05），但会直接抬高化神以上玩家的战损口径，等签字'
    },
    'NascentSoulService.getAskDaoBreakthroughBonus': {
        verdict: 'consumer', reason: 'routes/breakthrough.js 突破概率里直接用（成功率类加成，本来就不进属性块）'
    },
    'SectService.getBonusMeta': {
        verdict: 'display_only',
        reason: '它不产出数值加成，只把 sect_data.global.bonus_labels 收成 {label,format} 给面板渲染中文名'
            + '（routes/sect.js 下发）；真正的宗门加成数值走 getPlayerSectBonus 那一条'
    },
    'SectService.getPlayerSectBonus': {
        verdict: 'consumer', reason: 'ExperienceService 修为结算、GatheringService 采集、routes/breakthrough 三处直接用'
    },
    'CaveService.getCaveBonus': {
        verdict: 'consumer', reason: 'CraftingService 炼制产能用它（洞府设施加成作用于制造，不进面板属性）'
    },
    'CaveService.getCaveDefenseBonus': {
        verdict: 'consumer', reason: 'CombatService / WorldBossService / PvpService 的守家减伤直接用它'
    },
    'CaveService.getCaveSeclusionBonus': {
        verdict: 'consumer', reason: '闭关收益结算用它（洞府设施对闭关产出/效率的加成，不走玩家属性块这条路）'
    }
};

/** 扫出所有"属性/战力加成聚合器"方法名（服务里的 get*Bonus… 定义处；惩罚类不在本台账范围，见文件头） */
function collectAggregators() {
    const dir = path.join(serverRoot, 'game/services');
    const found = [];
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const m of text.matchAll(/^\s{4}(?:static\s+)?(?:async\s+)?(get[A-Za-z0-9_]*Bonus[a-zA-Z_]*)\s*\(/gm)) {
            found.push(`${name.replace(/\.js$/, '')}.${m[1]}`);
        }
    }
    return [...new Set(found)].sort();
}

const aggregators = collectAggregators();

describe('加成聚合器的归宿台账', () => {
    test('每个聚合器都写了归宿；台账里的名字必须真的还存在（双向红）', () => {
        const missing = aggregators.filter(name => !DESTINATIONS[name]);
        const gone = Object.keys(DESTINATIONS).filter(name => !aggregators.includes(name));
        expect(missing).toEqual([]);
        expect(gone).toEqual([]);
    });

    test('provider 这一类必须真的挂在属性引擎上；其余两类必须写出具体调用点', () => {
        const providerIds = new Set([...PROVIDERS.matchAll(/^\s+id:\s*'([a-z_]+)'/gm)].map(m => m[1]));
        for (const [name, entry] of Object.entries(DESTINATIONS)) {
            expect(['provider', 'consumer', 'display_only']).toContain(entry.verdict);
            if (entry.verdict === 'provider') {
                expect(providerIds.has(entry.provider)).toBe(true);
                // provider 还得真的调到那个方法，不能只是登记
                expect(PROVIDERS).toContain(name.split('.')[1]);
            } else {
                const note = entry.reason || '';
                expect(note.length).toBeGreaterThan(20);
                if (entry.pending) expect(note).toMatch(/平衡|属性|接法|等签字|等拍板|从未|零引用/);
            }
        }
    });

    test('控制跑：扫描器真的认识这两个已知孤儿（否则本文件是空转）', () => {
        expect(aggregators).toContain('ArtifactSpiritService.getCombatBonus');
        expect(aggregators).toContain('NascentSoulService.getDharmaFormBonus');
        expect(aggregators.length).toBeGreaterThanOrEqual(10);
        // 台账不能把两条已知缺陷偷偷写成 provider
        expect(DESTINATIONS['ArtifactSpiritService.getCombatBonus'].verdict).toBe('display_only');
        expect(DESTINATIONS['NascentSoulService.getDharmaFormBonus'].verdict).toBe('display_only');
        expect(providerIdsOfEngine()).not.toContain('artifact_spirit');
    });

    test('属性引擎里每个来源都在台账里说得出名字（防止新增 provider 不登记）', () => {
        const providerIds = [...PROVIDERS.matchAll(/^\s+id:\s*'([a-z_]+)'/gm)].map(m => m[1]);
        const registered = new Set(Object.values(DESTINATIONS)
            .filter(e => e.verdict === 'provider').map(e => e.provider));
        for (const id of ['spirit_root', 'allocated', 'talent', 'title']) {
            expect(providerIds).toContain(id);        // 这几档来自内容/玩家行，不属于本台账范围
        }
        for (const id of providerIds.filter(x => !['spirit_root', 'allocated', 'talent', 'title'].includes(x))) {
            expect(registered.has(id)).toBe(true);
        }
    });
});

function providerIdsOfEngine() {
    return [...PROVIDERS.matchAll(/^\s+id:\s*'([a-z_]+)'/gm)].map(m => m[1]);
}
