/**
 * 灵兽战斗快照投影（game/stats/beastView.js）—— 静态等价 + 去重是否真的落地（不连库）
 *
 * 期望值不是照着新实现写的，而是**逐键抄自改造前那三处内联字面量**：这样"收成一个函数"必须保持
 * 每份快照的形状与类型不变，任何顺手改类型（Number ↔ 字符串）、漏字段、换顺序都会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { beastSnapshot } = require('../game/stats/beastView');

const row = {
    id: 7, beast_key: 'qingyun_wolf', beast_name: '青云狼', element: 'metal', rarity: 'common',
    star_level: 2, level: 9, hp_max: '20000', atk: 80, def: 50, speed: 90, loyalty: 70,
    stamina: 55, some_future_column: 'not-for-view'
};

// ↓↓↓ 改造前各服务里的手抄字面量（原样保留，作为等价基线）↓↓↓
const ABYSS_OLD = {
    beast_id: 7, beast_key: 'qingyun_wolf', beast_name: '青云狼', element: 'metal', rarity: 'common',
    star_level: 2, level: 9, hp_max: Number('20000'), atk: 80, def: 50, speed: 90, loyalty: 70, stamina: 55
};
const PASTURE_OLD = {
    beast_id: 7, beast_key: 'qingyun_wolf', beast_name: '青云狼', element: 'metal', rarity: 'common',
    star_level: 2, level: 9, hp_max: '20000'.toString(), atk: 80, def: 50, speed: 90, loyalty: 70
};
const PVP_OLD = {
    beast_id: 7, beast_key: 'qingyun_wolf', beast_name: '青云狼', element: 'metal', rarity: 'common',
    star_level: 2, level: 9, hp_max: '20000'.toString(), atk: 80, def: 50, speed: 90, loyalty: 70
};

const SERVICES = ['BeastAbyssService.js', 'BeastPastureService.js', 'SpiritBeastPvpService.js'];
const read = f => fs.readFileSync(path.join(__dirname, '..', 'game', 'services', f), 'utf8');

describe('灵兽战斗快照投影（beastView）', () => {
    test('探渊那份：Number 型 hp_max + 带 stamina，逐键等于改造前的字面量（含键顺序）', () => {
        const v = beastSnapshot(row, { hpMaxAs: 'number', includeStamina: true });
        expect(v).toEqual(ABYSS_OLD);
        expect(Object.keys(v)).toEqual(Object.keys(ABYSS_OLD));
        expect(typeof v.hp_max).toBe('number');
    });

    test('放养 / 对局那两份：字符串 hp_max、不带 stamina，逐键等于改造前的字面量', () => {
        const v = beastSnapshot(row);
        expect(v).toEqual(PASTURE_OLD);
        expect(v).toEqual(PVP_OLD);
        expect(Object.keys(v)).toEqual(Object.keys(PASTURE_OLD));
        expect(typeof v.hp_max).toBe('string');
        expect('stamina' in v).toBe(false);
    });

    test('缺名字/缺血量时不许抛，也不许写出 undefined 字段', () => {
        const v = beastSnapshot({ id: 1, beast_key: 'x', hp_max: null });
        expect(v.beast_name).toBe('x');
        expect(v.hp_max).toBe('0');
        expect(beastSnapshot({ id: 1, beast_key: 'x', hp_max: null }, { hpMaxAs: 'number' }).hp_max).toBe(0);
    });

    test('投影范围是"已有基础列"：未来列与新属性不许从这条路偷偷漏出去（走注册表消费者，见 #43）', () => {
        const v = beastSnapshot(row, { hpMaxAs: 'number', includeStamina: true });
        expect('some_future_column' in v).toBe(false);
        expect('probe_pierce' in v).toBe(false);
    });

    test('三份手抄确实收掉了：三个服务都不再自己写 atk/def 字面量，而是调投影', () => {
        const problems = [];
        for (const f of SERVICES) {
            const body = read(f);
            if (/atk:\s*beast\.atk/.test(body)) problems.push(`${f} 还留着手抄的字段清单`);
            if (!/beastSnapshot\(/.test(body)) problems.push(`${f} 没有改走 beastSnapshot`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
        // 反向自检：投影文件里确实有这份清单（否则上面的"没有了"可能只是因为读错了文件）
        const viewSrc = fs.readFileSync(path.join(__dirname, '..', 'game', 'stats', 'beastView.js'), 'utf8');
        expect(/atk:\s*beast\.atk/.test(viewSrc)).toBe(true);
    });
});
