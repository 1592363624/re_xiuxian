/**
 * 灵根解析验收
 *
 * 灵根此前是"配了但从来没生效"的状态：
 *   provider 读 player.spirit_root，而模型里根本没有这一列（只有 spirit_roots），
 *   于是 spiritRootBonuses 这张表对任何真实玩家都返回空。
 * 现网同时存在两种存储形状，这里逐个钉住，并钉住"新增灵根只改数据"这条承诺。
 */
'use strict';

const path = require('path');
const { resolveSpiritRoot, spiritRootBonus, spiritRootTypes } = require('../game/stats/SpiritRoot');
const AttributeService = require('../game/core/AttributeService');
const { statRegistry } = require('../game/stats');
const { loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

const roleInit = require(path.join(__dirname, '..', 'config', 'role_init.json'));

describe('存储形状归一', () => {
    test('老形状 { type: 英文名 }', () => {
        expect(resolveSpiritRoot({ spirit_roots: { type: 'thunder' } }, roleInit))
            .toMatchObject({ type: 'thunder', name: '雷', bonus: { atk: 6, speed: 1 } });
    });

    test('新建角色形状 { "金灵根": { level, affinity } }', () => {
        const root = resolveSpiritRoot({ spirit_roots: { '金灵根': { level: '基础', affinity: 88 } } }, roleInit);
        expect(root).toMatchObject({ type: 'metal', name: '金', value: 88 });
        expect(root.bonus).toEqual({ atk: 4, def: 2 });
    });

    test('历史标量字段仍然认（旧快照/手工构造的对象）', () => {
        expect(resolveSpiritRoot({ spirit_root: '火' }, roleInit)).toMatchObject({ type: 'fire', name: '火' });
    });

    test('权重表形状 { fire: 80, water: 50 } 也认（元素名→亲和度）', () => {
        expect(resolveSpiritRoot({ spirit_roots: { fire: 80 } }, roleInit))
            .toMatchObject({ type: 'fire', name: '火' });
    });

    test('认不出来的灵根返回 null，不猜一个默认值', () => {
        expect(resolveSpiritRoot({ spirit_roots: { type: 'chaos' } }, roleInit)).toBeNull();
        expect(resolveSpiritRoot({}, roleInit)).toBeNull();
        expect(resolveSpiritRoot(null, roleInit)).toBeNull();
        expect(spiritRootBonus({ spirit_roots: { type: 'chaos' } }, roleInit)).toEqual({});
    });
});

/**
 * spiritRootTypes 是"每一条灵根"的版本：五行契合/相克要按全部灵根判断，
 * 只看第一条会把 { fire: 50, water: 50 } 判成只有火。
 */
describe('spiritRootTypes（多灵根全量解析）', () => {
    test('权重表里的每条非零灵根都产出 type，0 视为没有', () => {
        expect(spiritRootTypes({ spirit_roots: { fire: 50, water: 50 } }, roleInit).sort())
            .toEqual(['fire', 'water']);
        expect(spiritRootTypes({ spirit_roots: { fire: 50, water: 0 } }, roleInit)).toEqual(['fire']);
    });

    test('中文名形状按权威表翻译成 type，不返回中文键', () => {
        expect(spiritRootTypes({ spirit_roots: { '金灵根': { affinity: 90 } } }, roleInit)).toEqual(['metal']);
    });

    test('形状 1/3 与标量列都能解析；未知灵根名被丢掉而不是原样返回', () => {
        expect(spiritRootTypes({ spirit_roots: { type: 'thunder' } }, roleInit)).toEqual(['thunder']);
        expect(spiritRootTypes({ spirit_root: '风' }, roleInit)).toEqual(['wind']);
        expect(spiritRootTypes({ spirit_roots: { type: 'chaos', gold: 50 } }, roleInit)).toEqual([]);
    });

    test('读不到 role_init 时返回空数组（调用方按"无灵根"降级，不抛错）', () => {
        expect(spiritRootTypes({ spirit_roots: { type: 'fire' } }, null)).toEqual([]);
    });
});

describe('灵根加成真的进入属性', () => {
    let content;
    beforeAll(() => {
        content = loadRealContent(statRegistry);
        AttributeService.initialize(makeRealConfigLoader(content));
        AttributeService._engine = null;
    });
    afterEach(() => { AttributeService._engine = null; });

    test('spirit_root provider 对两种形状都产出加成，且出现在面板与明细里', () => {
        const base = { id: 3, realm: '炼气3层', realm_rank: 4, talent_id: null, equipped_title_id: null, attributes: {} };

        const metal = AttributeService.calculateFullAttributes({ ...base, spirit_roots: { '金灵根': { affinity: 90 } } });
        const thunder = AttributeService.calculateFullAttributes({ ...base, spirit_roots: { type: 'thunder' } });
        const none = AttributeService.calculateFullAttributes({ ...base, spirit_roots: { type: 'chaos' } });

        expect(metal.breakdown.spirit_root).toMatchObject({ atk: 4, def: 2 });
        expect(metal.final.atk).toBe(none.final.atk + 4);
        expect(metal.final.def).toBe(none.final.def + 2);

        expect(thunder.breakdown.spirit_root).toMatchObject({ atk: 6, speed: 1 });
        expect(thunder.final.atk).toBe(none.final.atk + 6);
    });

    test('AttributeService.getSpiritRootBonus 接受玩家对象（不再要求调用方自己拆形状）', () => {
        expect(AttributeService.getSpiritRootBonus({ spirit_roots: { type: 'water' } }))
            .toEqual({ speed: 3, mp_max: 10 });
    });

    test('八种灵根全部登记了加成，且键都是注册过的属性（拼错属性名会在这里炸）', () => {
        const roots = roleInit.spirit_roots.map(r => r.name);
        expect(roots).toEqual(expect.arrayContaining(['金', '木', '水', '火', '土', '雷', '冰', '风']));
        for (const root of roots) {
            const bonus = roleInit.spiritRootBonuses[root];
            expect(bonus).toBeTruthy();
            for (const key of Object.keys(bonus)) {
                expect(statRegistry.resolveStatKey(key)).not.toBeNull();
            }
        }
    });
});
