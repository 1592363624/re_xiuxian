/**
 * 赠送因果税：基础 10% + 小号凡人税 40% + 巨额累进，封顶 95%
 * 对应帖子「💸 一、赠送系统的变革（因果重税）」
 */
'use strict';

const GiftTaxService = require('../game/services/GiftTaxService');

describe('因果税税率叠加', () => {
    test('基础税 10%：20 万给筑基以上 → 凡人税不加、巨额 +20%', () => {
        const r = GiftTaxService.computeStoneTax({ stoneAmount: 200000, recipientRealmRank: 10 });
        expect(r.tax_rate).toBeCloseTo(0.30, 10); // 10% + 20%
        expect(r.tax_amount).toBe(60000);
        expect(r.net_amount).toBe(140000);
    });

    test('帖中例子：大能赠炼气萌新 20 万 → 10%+40%+20% = 70%，到手 6 万', () => {
        const r = GiftTaxService.computeStoneTax({ stoneAmount: 200000, recipientRealmRank: 1 });
        expect(r.tax_rate).toBeCloseTo(0.70, 10);
        expect(r.tax_amount).toBe(140000);
        expect(r.net_amount).toBe(60000);
    });

    test('1 万以上 10 万以下只加 10% 累进；刚好 1 万不算巨额', () => {
        const over = GiftTaxService.computeStoneTax({ stoneAmount: 10001, recipientRealmRank: 20 });
        expect(over.breakdown.large).toBeCloseTo(0.10, 10);
        expect(over.tax_rate).toBeCloseTo(0.20, 10);
        const exact = GiftTaxService.computeStoneTax({ stoneAmount: 10000, recipientRealmRank: 20 });
        expect(exact.breakdown.large).toBe(0);
        expect(exact.tax_rate).toBeCloseTo(0.10, 10);
    });

    test('税率封顶 95%：即便全叠满也不会税光', () => {
        const r = GiftTaxService.computeStoneTax(
            { stoneAmount: 200000, recipientRealmRank: 1 },
            { base_rate: 0.5, low_realm_extra_rate: 0.4, huge_stone_extra_rate: 0.2 }
        );
        expect(r.tax_rate).toBeCloseTo(0.95, 10);
        expect(r.net_amount).toBeGreaterThan(0);
    });
});

describe('物品赠送手续费', () => {
    test('等值灵石手续费：估值 80 → 费 80', () => {
        const r = GiftTaxService.computeItemFee(80);
        expect(r.fee).toBe(80);
    });

    test('灵石不足则拒绝', () => {
        expect(() => GiftTaxService.assertCanPayItemFee(10, 80)).toThrow(/灵石不足/);
        expect(() => GiftTaxService.assertCanPayItemFee(80, 80)).not.toThrow();
    });
});
