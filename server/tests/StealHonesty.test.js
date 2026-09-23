/**
 * 偷菜（灵兽放养 stealCrops）两条口径的回归钉（任务 #5，2026-09-22）
 *
 * 顺着"背包满时谎报成功"这条老账读进 `stealCrops`，挖出比谎报更严重的一处：
 * "全偷光"那一支先把 `produce_item_id`/`seed_id` 写成 null，**之后**才读它去发货 →
 * 读到 null → 一件都不发、`steal_yields` 也不记、地里那份作物凭空消失，全程没人报错。
 * 所以这个文件钉两件事：
 *   1. 文案必须报"真收到几个"，不能报"地里被摘走几个"（三种形状 + 旧写法的控制跑）；
 *   2. 静态顺序闸：扣地之前必须先把物品键抄下来（纯函数 + 合成控制跑，不往真文件里注入）。
 * 真发到手没有，由 `scripts/smoke_pasture_race.js` 的 P6 在隔离库上量（jest 一律不连库）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BeastPastureService = require('../game/services/BeastPastureService');

const SERVER = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');

describe('_stealResultMessage：给玩家的那句话只报真收到的', () => {
    test('全收到了：报名字与数量', () => {
        expect(BeastPastureService._stealResultMessage({ stolenQty: 4, stolenLanded: 4, grantAttempted: true }))
            .toBe('偷菜成功！获得 4 个作物');
    });

    test('背包放不下：差额与"不会补发"都要说出来', () => {
        const msg = BeastPastureService._stealResultMessage({ stolenQty: 5, stolenLanded: 3, grantAttempted: true });
        expect(msg).toContain('地里摘走 5');
        expect(msg).toContain('放不下 2');
        expect(msg).toContain('只收下 3');
        expect(msg).toContain('不会补发');
        // 控制跑：旧写法是 `获得 ${stolenQty} 个作物` —— 判据必须能把它区分出来
        expect(msg).not.toBe('偷菜成功！获得 5 个作物');
        expect(/获得 5 个/.test(msg)).toBe(false);
    });

    test('一件都没塞进去：不能说"获得 N"', () => {
        const msg = BeastPastureService._stealResultMessage({ stolenQty: 3, stolenLanded: 0, grantAttempted: true });
        expect(msg).toContain('只收下 0');
        expect(msg).toContain('放不下 3');
    });

    test('这一局根本没有可发的物品键：不许甩锅给背包', () => {
        const msg = BeastPastureService._stealResultMessage({ stolenQty: 2, stolenLanded: 0, grantAttempted: false });
        expect(msg).not.toMatch(/背包|放不下/);
        expect(msg).toContain('摘走 2');
    });
});

/**
 * 纯函数：读一份 stealCrops 源码，判"物品键是在清空地块之前抄的还是之后抄的"。
 * 做成纯函数是为了拿合成输入证伪 —— 注入真实文件会和其它并行的改动撞车。
 */
function stealItemCaptureOrder(source) {
    const capture = source.indexOf('const produceItemId');
    const cleared = source.indexOf('targetPlot.produce_item_id = null');
    if (capture < 0 || cleared < 0) {
        return { ok: false, reason: '找不到其中一处（形状变了，得重看这段代码）', capture, cleared };
    }
    return { ok: capture < cleared, reason: capture < cleared ? '' : '物品键是在地块被清空之后才读的 → 全偷光那一支会读到 null，作物凭空消失', capture, cleared };
}

describe('顺序闸：扣地之前必须先把"这块地里是什么"抄下来', () => {
    const body = (() => {
        const text = read('game/services/BeastPastureService.js');
        const start = text.indexOf('async stealCrops(');
        const next = text.indexOf('\n    async ', start + 10);
        return text.slice(start, next < 0 ? text.length : next);
    })();

    test('现网这段是"先抄再清"', () => {
        const out = stealItemCaptureOrder(body);
        expect(out).toMatchObject({ ok: true });
    });

    test('控制跑：把两处换成旧顺序（先清再抄）必须红', () => {
        const swapped = body
            .replace('const produceItemId = targetPlot.produce_item_id || targetPlot.seed_id;', '/* MOVED */')
            .replace('const stolenGrant = produceItemId',
                'const produceItemId = targetPlot.produce_item_id || targetPlot.seed_id;\n                const stolenGrant = produceItemId');
        const out = stealItemCaptureOrder(swapped);
        expect(out.ok).toBe(false);
        expect(out.reason).toMatch(/null/);
    });

    test('控制跑：整段读不到形状时也要报问题，不许静默放行', () => {
        expect(stealItemCaptureOrder('function nothing() {}').ok).toBe(false);
    });

    test('返回的载荷把两个数都给出去（界面不必自己猜）', () => {
        expect(body).toMatch(/stolen_landed_qty:\s*stolenLanded/);
        expect(body).toMatch(/stolen_qty:\s*stolenQty/);
        // produce_item_id 取抄下来那份，而不是被清空后的列
        expect(body).toMatch(/produce_item_id:\s*stolenItemId\s*\?\?\s*targetPlot\.produce_item_id/);
    });
});
