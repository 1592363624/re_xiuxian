/**
 * 「物品效果的键合法 ≠ 有人把它落到玩家身上」（2026-09-23，使用物品那条链改键级写入时量出来的）
 *
 * `ContentRegistry._validateItemEffects` 早就在管"effect 键必须是注册属性或效果词表里的键"，
 * 但那是**词表**层面的合法：`breakthrough_bonus` 曾经是真属性却没人落账 —— 16 件突破丹吃下去
 * 什么也不会多。2026-09-23 业主拍板后已接上（一次性 pending_breakthrough_bonus）。
 *
 * 本文件继续钉住两件事：
 *   ① 台账里若还有未落账键，必须真有物品在用、理由够厚、资料片新增即拦；
 *   ② 突破加成走一次性池，回执报的数与补丁一致，不写永久 breakthrough_bonus。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, UNAPPLIED_ITEM_EFFECTS, UNAPPLIED_ITEM_EFFECT_EXCEPTIONS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { serverRoot, loadRealContent } = require('./helpers/realContent');

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_item_effect_ledger_fixture');

function loadWithFixture(files, mutate) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'effect_fixture'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'effect_fixture/pack.json'), JSON.stringify({
        id: 'effect_fixture', name: '夹具·物品效果', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'effect_fixture', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_DIR, statRegistry
    });
    const undo = mutate ? mutate() : null;
    try { content.load(); return content; } finally { if (undo) undo(); }
}

// 效果词表里的键（过 _validateItemEffects），再塞进 UNAPPLIED 才能测到死账闸本身
const DEAD_KEY = 'alchemy_bonus';
const pillUsingDeadKey = (effectKey = DEAD_KEY) => ({
    into: 'items',
    add: [{
        id: 'zz_probe_pill', name: '探针丹', type: 'consumable', quality: 'rare',
        description: '夹具', price: 10, effect: { [effectKey]: 5 }
    }]
});

describe('台账本身是真的（判据不是空转）', () => {
    const content = loadRealContent();
    const items = content.dataset('item_data').items;

    test('名单里每一个键都确实有物品在用（过期结论比没有结论更坏）', () => {
        for (const key of Object.keys(UNAPPLIED_ITEM_EFFECTS)) {
            const users = items.filter(i => i.effect && key in i.effect);
            if (!users.length) throw new Error(`${key} 已没有任何物品在用，该从名单删掉`);
        }
    });

    test('breakthrough_bonus 已不在死账名单里（2026-09-23 接上一次性池）', () => {
        expect(UNAPPLIED_ITEM_EFFECTS.breakthrough_bonus).toBeUndefined();
        expect(UNAPPLIED_ITEM_EFFECT_EXCEPTIONS).toEqual([]);
        const users = items.filter(i => i.effect && 'breakthrough_bonus' in i.effect);
        expect(users.length).toBe(16);
    });

    test('理由必须说得出"读它的是谁、缺的那一步是什么、为什么要业主定"（薄结论不算结论）', () => {
        for (const [key, reason] of Object.entries(UNAPPLIED_ITEM_EFFECTS)) {
            if (String(reason).length < 80) throw new Error(`理由太薄：${key}`);
            expect(String(reason).length).toBeGreaterThanOrEqual(80);
            expect(reason).toContain('attributes');
        }
    });

    test('例外表里每一条都还命中着一件资料片物品（不再命中就要被 warn，不留死例外）', () => {
        const packItems = content._entriesWithMeta('item_data', 'items')
            .filter(i => i.__content_origin && i.__content_origin !== 'base');
        for (const exception of UNAPPLIED_ITEM_EFFECT_EXCEPTIONS) {
            if (!packItems.some(i => String(i.__pk || i.id) === exception.item)) throw new Error(`例外 ${exception.item} 现在没有对应的资料片物品，请删掉`);
            expect(String(exception.why).length).toBeGreaterThanOrEqual(30);
        }
    });

    test('启动报告不再点名 breakthrough_bonus 死账', () => {
        const line = content.report.warnings.find(w => w.includes('breakthrough_bonus') && w.includes('没有任何一处'));
        expect(line).toBeFalsy();
    });

    test('名单过期这一半不进启动 errors（本文件第一条才是它的家）', () => {
        const raw = fs.readFileSync(path.join(serverRoot, 'game/content/ContentRegistry.js'), 'utf8');
        const src = raw.replace(/\r\n/g, String.fromCharCode(10)).split(String.fromCharCode(10))
            .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join(String.fromCharCode(10));
        const gate = src.slice(src.indexOf('_validateItemEffectApplication()'), src.indexOf('_validatePuppetBlueprints()'));
        expect(gate).toMatch(/this\.report\.warnings\.push\(\`\$\{stale\}/);
        expect(gate).not.toMatch(/errors\.push\(.?`UNAPPLIED_ITEM_EFFECTS/);
        expect(gate).toMatch(/errors\.push\(.?`资料片新增的/);
    });
});

describe('资料片新增一件用死键的物品 → 拦；登记例外 → 放行并点名', () => {
    test('没登记例外时启动就抛，并把"玩家什么也不会多"说清楚', () => {
        // 先往名单塞一条合成死键：真实名单已清空，闸本身仍要能拦
        UNAPPLIED_ITEM_EFFECTS[DEAD_KEY] = '合成死账：没有任何结算代码读它（本条只活在测试里，用来证明闸不是空转）—— 缺的那一步是使用物品那条链从不写 attributes';
        try {
            let message = '';
            try { loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() }); }
            catch (err) { message = String(err.message || err); }
            expect(message).toContain('zz_probe_pill');
            expect(message).toContain('没有任何落账逻辑');
        } finally {
            delete UNAPPLIED_ITEM_EFFECTS[DEAD_KEY];
        }
        expect(() => loadRealContent()).not.toThrow();
    });

    test('突破加成如今有人落账：资料片再发同款丹药不应被死账闸拦下', () => {
        expect(() => loadWithFixture({
            'item_data__items.json': {
                into: 'items',
                add: [{
                    id: 'zz_bt_pill', name: '夹具突破丹', type: 'consumable', quality: 'rare',
                    description: '夹具', price: 10, effect: { breakthrough_bonus: 5 }
                }]
            }
        })).not.toThrow();
    });

    test('控制跑：把合成结论从名单里删掉，同一支夹具就装得过来（说明抛它的就是这条闸）', () => {
        UNAPPLIED_ITEM_EFFECTS[DEAD_KEY] = '合成死账：没有任何结算代码读它（本条只活在测试里，用来证明闸不是空转）—— 缺的那一步是使用物品那条链从不写 attributes';
        try {
            expect(() => loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() })).toThrow(/zz_probe_pill/);
            delete UNAPPLIED_ITEM_EFFECTS[DEAD_KEY];
            expect(() => loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() })).not.toThrow();
        } finally {
            delete UNAPPLIED_ITEM_EFFECTS[DEAD_KEY];
        }
    });
});

describe('突破加成走一次性池；使用物品不再整块写回 attributes', () => {
    const rawSrc = fs.readFileSync(path.join(serverRoot, 'game/services/InventoryService.js'), 'utf8');
    const src = rawSrc.replace(/\r\n/g, String.fromCharCode(10)).split(String.fromCharCode(10))
        .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join(String.fromCharCode(10));

    test('写入 pending_breakthrough_bonus，不写永久 breakthrough_bonus', () => {
        expect(src).toMatch(/blobPatch\.pending_breakthrough_bonus = \{ \$add: gain/);
        expect(src).not.toMatch(/blobPatch\.breakthrough_bonus\s*=/);
    });

    test('RealmService 突破概率叠加 pending，尝试后清零', () => {
        const realm = fs.readFileSync(path.join(serverRoot, 'game/core/RealmService.js'), 'utf8');
        expect(realm).toMatch(/pending_breakthrough_bonus/);
        expect(realm).toMatch(/clearPendingBreakthroughBonus/);
    });

    test('属性丹走 $add 键级补丁，标量走列上原子加减，函数里没有实例级整块赋值', () => {
        expect(src).toMatch(/blobPatch\[bonusKey\] = \{ \$add: delta \}/);
        expect(src).toMatch(/amounts\.spirit_stones = BigInt\(gain\)/);
        expect(src).toMatch(/amounts\.exp = BigInt\(gain\)/);
        expect(src).toMatch(/amounts\.toxicity = -reduce/);
        expect(src).toMatch(/PlayerStateStore\.patchPlayerState\(/);
        expect(src).toMatch(/mirrorPatchedBlob\(player, updated\)/);
        expect(src).not.toMatch(/player\.attributes\s*=(?!=)/);
        const useItem = src.slice(src.indexOf('async useItem('), src.indexOf('async discardItem('));
        expect(useItem).not.toMatch(/player\.save\(/);
    });

    test('钳制与增量都以锁内那一份为准（不拿调用方手上可能是旧的实例算钱）', () => {
        expect(src).toMatch(/await PlayerStateStore\.readForUpdate\(player\.id, \{ transaction \}\)/);
        expect(src).toMatch(/Number\(fresh\.hp_current\)/);
        expect(src).toMatch(/const attrs = fresh\.attributes \|\| \{\}/);
    });
});
