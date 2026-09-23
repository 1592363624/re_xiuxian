/**
 * 称号追加的唯一入口：契约测试（不连库）
 *
 * 为什么要收成一处：副本结算 7 处 + 切磋 1 处各自抄了同一份
 * "读出来 -> includes 判重 -> push -> 赋回 -> save"，八份去重逻辑、八份顺序语义，加一处漏一处。
 *
 * **这是消除重复，不是修 bug。** players.titles 定义是 TEXT + "get 里 JSON.parse / set 里 JSON.stringify"，
 * 每次读都得到一个新数组，所以原来那种写法在这一列上照样落库。
 * 我一开始把"整块 JSON 列"当成一类，报了 7 处"丢写"，那是错的：真丢写只发生在**原生 JSON 列**上
 * （getter 返回库里那份引用），例如 spirit_beast_pastures.steal_yields。
 * 两类列的对照证据在同一条探针里：scripts/smoke_title_grant.js 的 J1（TEXT 列不丢）/J2（原生 JSON 列会丢）。
 *
 * changed()/脏标记不在这里验：Player.build() 的脏标记语义与"从库里读出来的行"不同
 * （我第一版就拿 build 判错过一次），那一条是探针的活。
 */
'use strict';

const Player = require('../models/player');
const { addTitleToInstance } = require('../game/persistence/PlayerStateStore');

describe('addTitleToInstance 的契约（称号是玩家可见资产，去重与顺序都要稳）', () => {
    test('新加成功返回 true，并且赋回的是**新数组**而不是原引用', () => {
        const player = Player.build({ username: 'grant_probe', nickname: '称号探针', realm: '炼气1层', titles: ['a'] });
        const before = player.titles;
        expect(addTitleToInstance(player, 'b')).toBe(true);
        expect(player.titles).toEqual(['a', 'b']);
        expect(player.titles).not.toBe(before);          // 这一条才是"会被 save() 带上"的前提
    });

    test('不写回、也不改掉调用方原来那份数组（避免别名把旧值一起改了）', () => {
        const original = ['a'];
        const player = Player.build({ username: 'grant_probe', nickname: '称号探针', realm: '炼气1层', titles: original });
        addTitleToInstance(player, 'b');
        expect(original).toEqual(['a']);                 // 原数组必须原封不动
    });

    test('幂等：已经有这个称号返回 false、不重复、也不改这一列', () => {
        const player = Player.build({ username: 'grant_probe', nickname: '称号探针', realm: '炼气1层', titles: ['a'] });
        // 判"有没有动这一列"要比对**底层原始值**：titles 的 getter 每次读都 JSON.parse 一个新数组，
        // 所以 `player.titles === player.titles` 这种引用比较在这一列上毫无意义（第一版就这么判错过）。
        const beforeRaw = player.getDataValue('titles');
        expect(addTitleToInstance(player, 'a')).toBe(false);
        expect(player.getDataValue('titles')).toBe(beforeRaw);
        expect(player.titles).toEqual(['a']);
    });

    test('titles 还是 null（新号）时能建出数组', () => {
        const player = Player.build({ username: 'grant_probe', nickname: '称号探针', realm: '炼气1层', titles: null });
        expect(addTitleToInstance(player, 'first_blood')).toBe(true);
        expect(player.titles).toEqual(['first_blood']);
    });

    test('非法称号 ID 直接抛，不静默塞进数组', () => {
        const player = Player.build({ username: 'grant_probe', nickname: '称号探针', realm: '炼气1层', titles: ['a'] });
        expect(() => addTitleToInstance(player, '')).toThrow();
        expect(() => addTitleToInstance(player, undefined)).toThrow();
        expect(player.titles).toEqual(['a']);
    });
});

describe('副本/切磋不许再各自抄一份称号追加', () => {
    const fs = require('fs');
    const path = require('path');
    const files = ['game/services/MultiDungeonService.js', 'game/services/SparringService.js'];

    test('那 8 处的旧形状已从代码里消失，并且都改成走统一入口', () => {
        for (const rel of files) {
            const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
            // 旧形状（读引用后原样赋回）一处都不许剩，注释里也不要抄 —— 抄了会被这种文本判定抓到
            expect(src).not.toMatch(/const titles = player\.titles/);
            expect(src).toMatch(/addTitleToInstance\(/);
        }
    });

    test('入口只有一份定义（别再长出第二个"称号追加"）', () => {
        const store = fs.readFileSync(path.join(__dirname, '..', 'game/persistence/PlayerStateStore.js'), 'utf8');
        expect((store.match(/function addTitleToInstance\(/g) || []).length).toBe(1);
    });
});
