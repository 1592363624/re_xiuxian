/**
 * 夺舍属性继承（ReincarnationService.inheritanceOf）单元测试 —— 不连库
 *
 * 为什么单独一份：夺舍的"继承攻击/防御/气血"自 2026-09-20 属性管线改造起就是**空转**的——
 * 它读 players.attributes 里旧管线留下的输出键（atk/def/hp_max），写回去也写在那些没人读的键上，
 * 而玩家看到的回执与 player_reincarnation 记录里都记着"继承攻击 = 某个数"。
 * 现在改成：读解析链路、写 attributes.reincarnation_bonus（一个新的独立属性来源）。
 * 换算规则是这条链唯一还留在纯函数里的部分，所以要逐格钉住：
 *   目标总值 = floor(原真实总值 × inherit_ratio) + 这具身体自己的底子
 *   存储值   = max(0, 目标总值 − 跌境后已有的（清零本来源后的）解析值)
 */
'use strict';

const { statRegistry } = require('../game/stats');
const { loadRealContent } = require('./helpers/realContent');
const ReincarnationService = require('../game/services/ReincarnationService');

// 注册表是内容层装配出来的（没跑过内容层时 has() 一律 false，那会让下面那条断言变成假绿）
loadRealContent(statRegistry);

const { inheritanceOf, INHERIT_STAT_FIELDS } = ReincarnationService;

const target = (over = {}) => ({
    inherit_ratio: 0.5,
    base_atk: 30,
    base_def: 20,
    base_hp_max: 300,
    base_speed: 5,
    ...over
});

describe('夺舍继承换算', () => {
    test('差多少补多少：目标值减去跌境后已有的，四档一起算', () => {
        const { bonus, totals } = inheritanceOf(
            { atk: 1000, def: 500, hp_max: 8000, speed: 200 },
            target(),
            { atk: 200, def: 100, hp_max: 1500, speed: 50 }
        );
        // floor(1000×0.5)+30 = 530，已有 200 → 补 330，生效总值 530
        expect(totals).toEqual({ atk: 530, def: 270, hp_max: 4300, speed: 105 });
        expect(bonus).toEqual({ atk: 330, def: 170, hp_max: 2800, speed: 55 });
    });

    test('已有比目标值还高时只写 0，绝不把玩家已有的东西倒扣掉', () => {
        const { bonus, totals } = inheritanceOf(
            { atk: 100, def: 100, hp_max: 100, speed: 100 },
            target({ inherit_ratio: 0.1, base_atk: 1, base_def: 1, base_hp_max: 1, base_speed: 1 }),
            { atk: 900, def: 700, hp_max: 5000, speed: 300 }
        );
        expect(bonus).toEqual({ atk: 0, def: 0, hp_max: 0, speed: 0 });
        expect(totals).toEqual({ atk: 900, def: 700, hp_max: 5000, speed: 300 });
    });

    test('按比例折减向下取整（不给浮点尾巴留进位空间）', () => {
        const { totals } = inheritanceOf(
            { atk: 100, def: 0, hp_max: 0, speed: 0 },
            target({ inherit_ratio: 0.33, base_atk: 0, base_def: 0, base_hp_max: 0, base_speed: 0 }),
            {}
        );
        expect(totals.atk).toBe(33);
    });

    test('目标没配比例（或缺失/非法）就是彻底不继承，旧账一并清零', () => {
        for (const bad of [{ inherit_ratio: undefined }, { inherit_ratio: null }, { inherit_ratio: 'x' }, { inherit_ratio: 0 }, { inherit_ratio: -1 }]) {
            const { bonus, totals } = inheritanceOf({ atk: 999 }, target(bad), { atk: 1 });
            expect(bonus).toEqual({});
            expect(totals).toEqual({});
        }
    });

    test('继承的四个键必须全是注册属性（拼错的属性名进不了引擎，等于白写）', () => {
        expect(INHERIT_STAT_FIELDS.map(f => f.stat)).toEqual(['atk', 'def', 'hp_max', 'speed']);
        for (const { stat } of INHERIT_STAT_FIELDS) {
            expect(statRegistry.has(stat)).toBe(true);
        }
    });

    /**
     * 连续两次夺舍不复合，而且**记录值 == 实际生效值**。
     *
     * 这里用一个小模型代替真解析：final = 境界基数 + 其它来源(装备等) + reincarnation_bonus。
     * 关键不在模型像不像，而在于它复现了调用方唯一会犯错的地方：
     * 第二次算"跌境后已有"时，如果忘了把上一次的继承账清零（sourceOverrides 里那个空的 reincarnation），
     * 上一次攒下的加成会被算成"已经有的"，于是这次只写一点点、甚至写 0，
     * 而落库后真正的总值并不等于回执里承诺的那个数 —— 假账。
     */
    const resolveModel = (state, bonus) => ({
        atk: state.realmBase.atk + state.gear.atk + Number(bonus.atk || 0),
        def: state.realmBase.def + state.gear.def + Number(bonus.def || 0),
        hp_max: state.realmBase.hp_max + state.gear.hp_max + Number(bonus.hp_max || 0),
        speed: state.realmBase.speed + state.gear.speed + Number(bonus.speed || 0)
    });

    function reincarnate(state, cfg, { zeroOwnSource }) {
        const origin = resolveModel(state, state.bonus);
        // 跌境后的"已有"：正确做法是把本来源清零（postDrop = 境界基数 + 装备，不含上一次继承）
        const postDrop = resolveModel(
            { ...state, realmBase: cfg.nextRealmBase },
            zeroOwnSource ? {} : state.bonus
        );
        const { bonus, totals } = inheritanceOf(origin, cfg, postDrop);
        const next = { realmBase: cfg.nextRealmBase, gear: state.gear, bonus };
        return { state: next, totals, actual: resolveModel(next, bonus) };
    }

    const firstRealm = { atk: 800, def: 400, hp_max: 6000, speed: 100 };
    const secondRealm = { atk: 300, def: 150, hp_max: 2500, speed: 60 };
    const gear = { atk: 200, def: 100, hp_max: 1500, speed: 40 };

    test('第一次夺舍：回执里的继承值就是玩家实际拿到的值', () => {
        const r = reincarnate(
            { realmBase: firstRealm, gear, bonus: {} },
            { inherit_ratio: 0.5, base_atk: 30, base_def: 20, base_hp_max: 300, base_speed: 5, nextRealmBase: secondRealm },
            { zeroOwnSource: true }
        );
        // origin atk = 800+200 = 1000 → 目标 530；跌境后已有 = 300+200 = 500 → 补 30 → 生效 530
        expect(r.totals.atk).toBe(530);
        expect(r.state.bonus.atk).toBe(30);
        expect(r.actual.atk).toBe(r.totals.atk);
    });

    test('连着夺两次：账不会越夺越叠，第二次的记录值仍等于实际生效值', () => {
        const cfg = { inherit_ratio: 0.5, base_atk: 30, base_def: 20, base_hp_max: 300, base_speed: 5, nextRealmBase: secondRealm };
        const step1 = reincarnate({ realmBase: firstRealm, gear, bonus: {} }, cfg, { zeroOwnSource: true });
        const step2 = reincarnate(step1.state, cfg, { zeroOwnSource: true });
        // 第二次：origin = 300+200+30 = 530 → 目标 floor(530×0.5)+30 = 295；跌境后已有（清零本来源）= 500
        // → 补 0，生效仍是 500，记录也写 500（继承只托底，不会把人往下拽）
        expect(step2.state.bonus.atk).toBe(0);
        expect(step2.actual.atk).toBe(step2.totals.atk);
        // 关键是"不会越夺越强到叠加"：账是 set 而不是 add，两次之后仍然只有那一档
        expect(step2.actual.atk).toBeLessThanOrEqual(step1.actual.atk);
    });

    test('反证：算"已有"时忘了清零本来源，就会留下"回执 != 实际"的假账（所以那行 sourceOverrides 不是装饰）', () => {
        const cfg = { inherit_ratio: 0.9, base_atk: 500, base_def: 0, base_hp_max: 0, base_speed: 0, nextRealmBase: secondRealm };
        const first = reincarnate({ realmBase: firstRealm, gear, bonus: {} }, cfg, { zeroOwnSource: true });
        // 第二次同样按"忘了清零"来算
        const wrong = reincarnate(first.state, cfg, { zeroOwnSource: false });
        expect(wrong.actual.atk).not.toBe(wrong.totals.atk);
        // 同一份输入、只把清零这步补上，记录值就与实际一致了
        const right = reincarnate(first.state, cfg, { zeroOwnSource: true });
        expect(right.actual.atk).toBe(right.totals.atk);
    });
});
