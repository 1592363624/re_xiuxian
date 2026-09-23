/**
 * 法宝深线"给玩家看的那份加成清单"（任务 #27，2026-09-22）
 *
 * 一句话形状：**同一张 BONUS_ROUTES 既要决定数值进不进属性，也要决定界面怎么说**。
 * 改造前是两头各写各的：聚合口按表分发，面板手写六行 `combat_bonus.xxx * 100` 全涂绿色 ——
 * 于是 ① 资料片加一档加成界面永远看不见；② 战斗侧根本没结算的那几档（吸血/暴击/暴伤/减免/回血）
 * 也照样子显示成生效中的 "+X%"。现在清单由服务端出，`applied=false` 的一律灰字 + "（未生效）"。
 *
 * 这里不连库：判的是形状与判定，真取到数由 scripts/smoke_deep_line_bonuses.js 在隔离库上量。
 * 每条负向判据都配控制跑（内存 monkeypatch，不改仓库 json），否则"绿"只说明我没写对测试。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { infrastructure } = require('../modules');
const Svc = require('../game/services/ArtifactDeepLineService');
const { DATASET_SPECS } = require('../game/content/ContentRegistry');

const SERVER = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');

// jest 一律不连库，但配置层要装上（本文件判的是"内容里的名字表 + 口径表"两份数据怎么被读）
beforeAll(async () => {
    const { initializeModules } = require('../modules');
    await initializeModules();
});

/** 换掉 getConfig 对某个数据集的返回（用结构化克隆，改完不需要还原字段引用） */
function patchDataset(datasetName, transform) {
    const loader = infrastructure.ConfigLoader;
    const real = loader.getConfig.bind(loader);
    loader.getConfig = (name) => {
        const value = real(name);
        if (name !== datasetName || !value) return value;
        const clone = JSON.parse(JSON.stringify(value));
        transform(clone);
        return clone;
    };
    return () => { loader.getConfig = real; };
}

/** 三条线各自"会被玩家看到"的字段（skip 与非零判定在实现里） */
const SAMPLES = {
    blood_sword: {
        is_active: true, reason: 'ok',
        atk_bonus_rate: 0.45, def_bonus_rate: 0.1, hp_steal_bonus_rate: 0.05,
        crit_rate_bonus: 0.12, crit_damage_bonus: 0.2, blood_backlash_hp_rate_per_round: 0.03
    },
    xutian_cauldron: {
        def_bonus: 120, final_atk_bonus: 300, atk_bonus: 0.8, atk_multiplier: 1.2,
        backlash_rate_per_round: 0.02
    },
    five_element_wheel: {
        atk_bonus_rate: 0.03, def_bonus_rate: 0.02, hp_bonus_rate: 0.04, speed_bonus_rate: 0.01,
        crit_rate_bonus: 0.05, crit_damage_bonus: 0.06, damage_reduction_rate: 0.07,
        hp_regen_bonus_rate: 0.008
    }
};

const byKey = (rows) => Object.fromEntries(rows.map(r => [r.key, r]));

describe('combatBonusDisplay：清单由 BONUS_ROUTES 那一份口径生成', () => {
    test('每条线都出得来，且每一项都有中文名、换算方式、语气与"进没进战斗"', () => {
        for (const [source, block] of Object.entries(SAMPLES)) {
            const rows = Svc.combatBonusDisplay(source, block);
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
                expect(typeof row.label).toBe('string');
                expect(row.label.length).toBeGreaterThan(0);
                // 每一项都必须来自口径表本身（不比字段名正则 —— 表才是唯一口径）
                expect(Object.keys(Svc.BONUS_ROUTES[source])).toContain(row.key);
                expect(['percent', 'point']).toContain(row.format);
                expect(['bonus', 'cost']).toContain(row.tone);
                expect(typeof row.applied).toBe('boolean');
                expect(row.reason.length).toBeGreaterThan(8);
            }
        }
    });

    test('吸血/暴击/暴伤折进属性档，effects 档（减免/回血/反噬）也已接战斗，全部 applied=true', () => {
        const sword = byKey(Svc.combatBonusDisplay('blood_sword', SAMPLES.blood_sword));
        expect(sword.atk_bonus_rate.applied).toBe(true);
        expect(sword.atk_bonus_rate.bucket).toBe('percent');
        for (const key of ['hp_steal_bonus_rate', 'crit_rate_bonus', 'crit_damage_bonus']) {
            expect(sword[key].bucket).toBe('absolute');
            expect(sword[key].applied).toBe(true);
        }
        expect(sword.blood_backlash_hp_rate_per_round.bucket).toBe('effects');
        expect(sword.blood_backlash_hp_rate_per_round.applied).toBe(true);
        // 反噬是代价，不是奖励：语气必须由内容说了算（内容里写成 tone:"cost"）
        expect(sword.blood_backlash_hp_rate_per_round.tone).toBe('cost');
        expect(sword.atk_bonus_rate.tone).toBe('bonus');
        const cauldron = byKey(Svc.combatBonusDisplay('xutian_cauldron', SAMPLES.xutian_cauldron));
        expect(cauldron.def_bonus.bucket).toBe('absolute');
        expect(cauldron.def_bonus.format).toBe('point');
        expect(cauldron.backlash_rate_per_round.tone).toBe('cost');
    });

    test('skip 的那两档（倍率与倍率前值）不许冒到玩家面前，口径表与泛化规则都不认的键也不许', () => {
        const keys = Object.keys(byKey(Svc.combatBonusDisplay('xutian_cauldron', SAMPLES.xutian_cauldron)));
        expect(keys).not.toContain('atk_bonus');
        expect(keys).not.toContain('atk_multiplier');
        // 非零但没人认领的键：由聚合口的 unconsumed 去响，不该在清单里冒充一档加成
        expect(Svc.combatBonusDisplay('five_element_wheel', { not_a_stat_at_all: 5, zz_unknown_bonus: 7 }))
            .toEqual([]);
        // 零值与非数值同样不进清单
        expect(Svc.combatBonusDisplay('blood_sword', { atk_bonus_rate: 0, reason: 'x', is_active: true }))
            .toEqual([]);
    });

    test('"这一档进不进战斗"的答案只有一处（展示层不许自己再判一次桶名）', () => {
        expect(Svc.bonusBucketSettled('percent')).toBe(true);
        expect(Svc.bonusBucketSettled('absolute')).toBe(true);
        expect(Svc.bonusBucketSettled('effects')).toBe(true);
        // 控制跑：面板要是绕开这个入口自己写 `bucket !== 'effects'`，这条静态判据就会红
        const panel = read('../client/src/components/panels/BloodSwordPanel.vue');
        expect(panel).not.toMatch(/bucket\s*[!=]==?\s*['"]effects['"]/);
        expect(panel).toMatch(/b\.applied/);
    });
});

describe('名字与语气来自内容：缺一条就在启动期点名，而不是让玩家收 500', () => {
    test('启动自检认得 BONUS_ROUTES 里每一条会显示的字段（判据非空跑）', () => {
        const expected = Object.values(Svc.BONUS_ROUTES)
            .flatMap(table => Object.entries(table))
            .filter(([, route]) => route && route[0] !== 'skip').length;
        const out = Svc.assertBonusLabelCoverage();
        expect(out.checked).toBe(expected);
        expect(out.checked).toBeGreaterThanOrEqual(15);
    });

    test('删掉一条标签：取名字要抛、启动自检也要抛，并且报错里写着该补哪儿', () => {
        // 用 effects 桶的反噬字段：它没有注册表中文名兜底，删标签必须抛
        const restore = patchDataset('artifact_deep_lines', cfg => {
            delete cfg.bonus_field_labels.blood_backlash_hp_rate_per_round;
        });
        try {
            expect(() => Svc.combatBonusDisplay(
                'blood_sword', { blood_backlash_hp_rate_per_round: 0.12 })).toThrow(/取不到中文名/);
            let message = '';
            try { Svc.assertBonusLabelCoverage(); } catch (e) { message = e.message; }
            expect(message).toMatch(/会显示成裸键名/);
            expect(message).toMatch(/blood_backlash_hp_rate_per_round/);
            expect(message).toMatch(/bonus_field_labels/);
        } finally { restore(); }
        // 还原要真的还原：补回去之后启动自检必须重新通过（否则上面的"抛了"可能只是永久弄坏了配置）
        expect(Svc.assertBonusLabelCoverage().checked).toBeGreaterThanOrEqual(15);
    });

    test('语气写错也要抛：猜一个会把代价显示成奖励', () => {
        const restore = patchDataset('artifact_deep_lines',
            cfg => { cfg.bonus_field_labels.backlash_rate_per_round = { label: '反噬', tone: 'bad' }; });
        try {
            expect(() => Svc.combatBonusDisplay('xutian_cauldron', { backlash_rate_per_round: 0.02 }))
                .toThrow(/tone/);
        } finally { restore(); }
        expect(Svc.combatBonusDisplay('xutian_cauldron', { backlash_rate_per_round: 0.02 })[0].tone).toBe('cost');
    });

    test('这条标签表登记成了集合（资料片能往里加档），且基础配置里真的存在', () => {
        const artifact = DATASET_SPECS?.artifact_deep_lines?.collections || {};
        expect(artifact.bonus_field_labels).toBeTruthy();
        expect(artifact.bonus_field_labels.map).toBe(true);
        expect(infrastructure.ConfigLoader.getConfig('artifact_deep_lines').bonus_field_labels).toBeTruthy();
    });
});

describe('面板不再自己抄字段名（这条链上第二次挖出同一个形状）', () => {
    const panel = read('../client/src/components/panels/BloodSwordPanel.vue');

    test('渲染的是服务端清单，不是手写的六行', () => {
        expect(panel).toMatch(/combat_bonus_display/);
        expect(panel).toMatch(/v-for="b in \(heldStatus\.combat_bonus_display \|\| \[\]\)"/);
        // 逐字段点名是这次的根因：`combat_bonus.crit_rate_bonus` 这种写法一律不许回来
        expect(panel).not.toMatch(/combat_bonus\.[a-z_]+_bonus/);
        expect(panel).not.toMatch(/combat_bonus\.hp_steal_bonus_rate/);
        // 留两条"该继续读的"：空态与失效原因仍然读 raw
        expect(panel).toMatch(/combat_bonus\.is_active/);
        expect(panel).toMatch(/combat_bonus\.reason/);
    });

    test('控制跑：把旧写法塞回一段合成源码，判据必须命中', () => {
        for (const old of [
            '<span>+{{ (heldStatus.combat_bonus.crit_rate_bonus * 100).toFixed(1) }}%</span>',
            '<span>{{ heldStatus.combat_bonus.def_bonus_rate }}</span>',
            '<div v-if="heldStatus.combat_bonus.hp_steal_bonus_rate > 0">'
        ]) {
            expect(old).toMatch(/combat_bonus\.[a-z_]+_bonus/);
        }
        // 反面：新写法的 raw 读取（空态与原因）不该被这条判据误伤
        expect('combat_bonus.is_active').not.toMatch(/combat_bonus\.[a-z_]+_bonus/);
        expect('combat_bonus_display').not.toMatch(/combat_bonus\.[a-z_]+_bonus/);
    });
});
