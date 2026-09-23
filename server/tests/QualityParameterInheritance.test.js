/**
 * 「加一档品质，按品质取参数的表没跟着长」时该怎么算（2026-09-23）
 *
 * 起因是量到一个玩家可见的数值缺陷：品质词表上一轮长成六档（`mythic`），
 * 而 `game_balance.pawnshop.valuation_ratios` 只有五档。典当估值的写法是
 * `ratios[quality] ?? ratios['common'] ?? 0.6` —— 那张表是**越高档越保守**的递减曲线
 * （common 0.6 → legendary 0.3），于是新长出来的最高档拿到了全表**最慷慨**的系数：
 * 现网 45 件神话物品里 12 件没触到 `max_valuation_per_item` 的顶，它们被估成 0.6×基准价，
 * 而传说品质只有 0.3×。没有一处会响：词表、物品、典当、界面全都是"正常"的。
 *
 * 修法选的是规则级而不是"我替你补一个数"：缺档按词表档序取**不高于本档的最近一档**，
 * 于是神话继承传说（0.3）——加一档永远只会持平或更保守，不会反向；
 * 想单独定价就在表里补一键，启动报告（`npm run content:report`）会点名"哪一档在继承谁"。
 */
'use strict';

const { serverRoot, loadRealContent } = require('./helpers/realContent');
const { qualityParamFor, qualityParamCoverage } = require('../game/items/itemQuality');
const fs = require('fs');
const path = require('path');

/** 一个只装品质词表的假 loader（档序与真实词表同形状） */
function balanceLoader(balance) {
    return { getConfig: name => (name === 'game_balance' ? balance : null) };
}
const VOCAB = {
    item_qualities: {
        _comment: '说明',
        common: { label: '普通', order: 1 },
        uncommon: { label: '优良', order: 2 },
        rare: { label: '稀有', order: 3 },
        epic: { label: '史诗', order: 4 },
        legendary: { label: '传说', order: 5 },
        mythic: { label: '神话', order: 6 }
    }
};
const RATIOS = { common: 0.6, uncommon: 0.55, rare: 0.5, epic: 0.4, legendary: 0.3 };

describe('规则：缺档取"不高于本档的最近一档"，不兜到最低档', () => {
    test('现网那份典表：神话按传说的 0.3 继承（旧写法会拿到 0.6）', () => {
        const loader = balanceLoader(VOCAB);
        expect(qualityParamFor(loader, RATIOS, 'mythic')).toEqual({ value: 0.3, inheritedFrom: 'legendary' });
        // 旧算法的实际结果 —— 这条就是本次的病因，钉在这里防有人"顺手改回去"
        expect(RATIOS['mythic'] ?? RATIOS['common']).toBe(0.6);
    });

    test('中间插一档也只会继承它下面那一档，不会整体挪走旧档的位次', () => {
        const withGap = {
            item_qualities: { ...VOCAB.item_qualities, mythic: { label: '神话', order: 6 }, primordial: { label: '太初', order: 7 } }
        };
        const loader = balanceLoader(withGap);
        expect(qualityParamFor(loader, RATIOS, 'primordial')).toEqual({ value: 0.3, inheritedFrom: 'legendary' });
        // 已有档永远用自己的值
        expect(qualityParamFor(loader, RATIOS, 'rare')).toEqual({ value: 0.5, inheritedFrom: null });
    });

    test('资料片条目写成 {id,value} 也取到（map 集合加进来的必然是对象形状）', () => {
        const mixed = { ...RATIOS, mythic: { id: 'mythic', value: 0.25 } };
        expect(qualityParamFor(balanceLoader(VOCAB), mixed, 'mythic')).toEqual({ value: 0.25, inheritedFrom: null });
    });

    test('品质本身不在词表里时不猜：返回 null 交调用方兜底', () => {
        expect(qualityParamFor(balanceLoader(VOCAB), RATIOS, 'zz_unknown')).toEqual({ value: null, inheritedFrom: null });
        expect(qualityParamFor(balanceLoader(VOCAB), null, 'rare')).toEqual({ value: null, inheritedFrom: null });
    });

    test('覆盖面统计点名"缺哪一档、继承谁"（报告与启动日志用它，静默继承要能被看见）', () => {
        const coverage = qualityParamCoverage(balanceLoader(VOCAB), RATIOS);
        expect(coverage.total).toBe(6);
        expect(coverage.missing).toEqual([{ key: 'mythic', inheritedFrom: 'legendary' }]);
    });

    test('控制跑：把 mythic 补进表里，缺口统计立刻变空（判据不是恒真）', () => {
        const coverage = qualityParamCoverage(balanceLoader(VOCAB), { ...RATIOS, mythic: 0.25 });
        expect(coverage.missing).toEqual([]);
    });
});

describe('真内容与真服务', () => {
    const content = loadRealContent();
    const balance = content.datasets.get('game_balance');

    test('2026-09-23 业主拍板后现网典表已补齐 mythic=0.2，报告不再点名缺口', () => {
        expect(Object.keys(balance.item_qualities).filter(k => !k.startsWith('_'))).toHaveLength(6);
        expect(balance.pawnshop.valuation_ratios.mythic).toBe(0.2);
        const warning = content.report.warnings.find(w => w.includes('pawnshop.valuation_ratios'));
        expect(warning).toBeFalsy();
    });

    test('典当估值用 mythic 自己的 0.2（不再继承 legendary 的 0.3）', () => {
        const { initializeModules } = require('../modules');
        return initializeModules().then(() => {
            const PawnshopService = require('../game/services/PawnshopService');
            const mythic = PawnshopService._calculateValuation({ price: 50000, quality: 'mythic' }, 0);
            expect(mythic.quality_ratio).toBeCloseTo(0.2, 10);
            expect(mythic.quality_ratio_inherited_from).toBeNull();
            expect(mythic.valuation).toBe(10000);
            // 已有档不受影响
            const legendary = PawnshopService._calculateValuation({ price: 50000, quality: 'legendary' }, 0);
            expect(legendary.quality_ratio).toBeCloseTo(0.3, 10);
            expect(legendary.quality_ratio_inherited_from).toBeNull();
            expect(legendary.valuation).toBe(15000);
            const common = PawnshopService._calculateValuation({ price: 50000, quality: 'common' }, 0);
            expect(common.valuation).toBe(30000);
        });
    });

    test('服务里不许再留"缺档兜到 common"那种写法', () => {
        const src = fs.readFileSync(path.join(serverRoot, 'game/services/PawnshopService.js'), 'utf8');
        expect(src).not.toMatch(/valuation_ratios\[[^\]]+\]\s*\?\?\s*valuationRatios\[/);
        expect(src).toMatch(/qualityParamFor\(/);
    });
});
