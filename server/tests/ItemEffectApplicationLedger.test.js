/**
 * 「物品效果的键合法 ≠ 有人把它落到玩家身上」（2026-09-23，使用物品那条链改键级写入时量出来的）
 *
 * `ContentRegistry._validateItemEffects` 早就在管"effect 键必须是注册属性或效果词表里的键"，
 * 但那是**词表**层面的合法：`breakthrough_bonus` 是一个真属性，规则放行了它，
 * 可是"使用物品"这条链从来没往玩家身上写过这个键 —— 于是 16 件物品（整条突破丹药线，
 * 筑基丹 +15 一直到补天丹 +60）吃下去什么也不会多，而回执里还带着一个 `breakthrough_bonus` 的数。
 * 这是"配了、回执报了、玩家没拿到"那一族的又一个成员：
 * 前几例是成就奖励键、称号、灵兽战力权重，这一例是**物品效果**。
 *
 * 本轮没有替业主定语义（永久 / 本次一次性 / 上限 30 点要不要抬 —— 现网 11 件配的值超过上限，
 * 还有一件写 0.1，同一个键两种单位），只做了两件事：
 *   ① 回执不再报一个没发生的数；② 名单 + 硬拦资料片新增 + 例外带理由且过期会红。
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

const pillUsingDeadKey = extra => ({
    into: 'items',
    add: [{
        id: 'zz_probe_pill', name: '探针丹', type: 'consumable', quality: 'rare',
        description: '夹具', price: 10, effect: { breakthrough_bonus: 5, ...extra }
    }]
});

describe('台账本身是真的（判据不是空转）', () => {
    const content = loadRealContent();
    const items = content.dataset('item_data').items;

    test('名单里每一个键都确实有物品在用（过期结论比没有结论更坏）', () => {
        for (const key of Object.keys(UNAPPLIED_ITEM_EFFECTS)) {
            const users = items.filter(i => i.effect && key in i.effect);
            if (!users.length) throw new Error(`${key} 已没有任何物品在用，该从名单删掉`);
            if (key === 'breakthrough_bonus') expect(users.length).toBe(16);
        }
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

    test('启动报告里点名这份死账（数量与"等业主定出口"一起出现）', () => {
        const line = content.report.warnings.find(w => w.includes('breakthrough_bonus') && w.includes('没有任何一处'));
        expect(line).toBeTruthy();
        expect(line).toContain('16 件');
    });

    test('名单过期这一半不进启动 errors（本文件第一条才是它的家）', () => {
        // "名单里这条还有物品在用吗"是对**仓库内容**的结论，而启动闸跑在任何一份内容集上：
        // ContentRegistry.test.js / ContentHotReload.test.js / BorderContentGate.test.js 的夹具各带两三件物品，
        // 把它们钉在这里等于让每一份夹具都得抄一遍真实物品表（第一版就是这么炸了 34 项的）。
        // 所以启动期只 warn + 进报告，硬拦留在本文件上面那条（它加载真实内容，过期就抛）。
        const raw = fs.readFileSync(path.join(serverRoot, 'game/content/ContentRegistry.js'), 'utf8');
        const src = raw.replace(/\r\n/g, String.fromCharCode(10)).split(String.fromCharCode(10))
            .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join(String.fromCharCode(10));
        const gate = src.slice(src.indexOf('_validateItemEffectApplication()'), src.indexOf('_validatePuppetBlueprints()'));
        expect(gate).toMatch(/this\.report\.warnings\.push\(\`\$\{stale\}/);
        expect(gate).not.toMatch(/errors\.push\(.?`UNAPPLIED_ITEM_EFFECTS/);
        // 反过来：资料片新增死键那一半必须留在启动期（它在任何内容集上都成立，夹具也拦得住）
        expect(gate).toMatch(/errors\.push\(.?`资料片新增的/);
    });
});

describe('资料片新增一件用死键的物品 → 拦；登记例外 → 放行并点名', () => {
    test('没登记例外时启动就抛，并把"玩家什么也不会多"说清楚', () => {
        const exceptions = UNAPPLIED_ITEM_EFFECT_EXCEPTIONS;
        const saved = exceptions.slice();
        exceptions.length = 0;
        try {
            let message = '';
            try { loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() }); }
            catch (err) { message = String(err.message || err); }
            expect(message).toContain('zz_probe_pill');
            expect(message).toContain('没有任何落账逻辑');
        } finally {
            exceptions.push(...saved);
        }
        // 还原之后（wuzhen_dan 在例外表里），基础内容照样能装配
        expect(() => loadRealContent()).not.toThrow();
    });

    test('例外表只豁免它点名的那一件：新物品用同一个键仍然抛', () => {
        expect(() => loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() })).toThrow(/zz_probe_pill/);
    });

    test('控制跑：把这条结论从名单里删掉，同一支夹具就装得过来（说明抛它的就是这条闸）', () => {
        const keys = Object.keys(UNAPPLIED_ITEM_EFFECTS);
        expect(keys).toContain('breakthrough_bonus');
        const saved = UNAPPLIED_ITEM_EFFECTS.breakthrough_bonus;
        delete UNAPPLIED_ITEM_EFFECTS.breakthrough_bonus;
        try {
            expect(() => loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() })).not.toThrow();
        } finally {
            UNAPPLIED_ITEM_EFFECTS.breakthrough_bonus = saved;
        }
        expect(() => loadWithFixture({ 'item_data__items.json': pillUsingDeadKey() })).toThrow(/zz_probe_pill/);
    });
});

describe('回执不再报没发生的数；使用物品不再整块写回 attributes', () => {
    const rawSrc = fs.readFileSync(path.join(serverRoot, 'game/services/InventoryService.js'), 'utf8');
    // 判据只读代码：解释性注释里出现的 player.save() / 整块赋值形状不算命中
    // （这一条是被 §51 那个自坑教出来的：在注释里写了一遍被判据匹配的写法，就会把一张本该变短的表钉住）
    const src = rawSrc.replace(/\r\n/g, String.fromCharCode(10)).split(String.fromCharCode(10))
        .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join(String.fromCharCode(10));

    test('_applyItemEffect 不再把 breakthrough_bonus 塞进回执', () => {
        expect(src).not.toMatch(/applied\.breakthrough_bonus\s*=/);
    });

    test('属性丹走 $add 键级补丁，标量走列上原子加减，函数里没有实例级整块赋值', () => {
        expect(src).toMatch(/blobPatch\[bonusKey\] = \{ \$add: delta \}/);
        expect(src).toMatch(/amounts\.spirit_stones = BigInt\(gain\)/);
        expect(src).toMatch(/amounts\.exp = BigInt\(gain\)/);
        expect(src).toMatch(/amounts\.toxicity = -reduce/);
        expect(src).toMatch(/PlayerStateStore\.patchPlayerState\(/);
        expect(src).toMatch(/mirrorPatchedBlob\(player, updated\)/);
        // 整块写回的形状（把 player 那份 attributes 赋回去 / 使用完再 save 整行）不许回潮
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
