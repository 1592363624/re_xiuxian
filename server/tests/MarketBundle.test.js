/**
 * 万宝楼捆绑销售：总价不能被上架数量整除 → 强制整包买
 * 帖：「例如 凝血散*3 换 妖丹*1」
 */
'use strict';

const MarketService = require('../game/services/MarketService');

describe('捆绑判定', () => {
    test('凝血散*3 换 妖丹*1 → 捆绑', () => {
        expect(MarketService.isBundleListing(3, 1)).toBe(true);
    });

    test('凝血散*100 换 灵石*500 → 单价 5，按件出售', () => {
        expect(MarketService.isBundleListing(100, 500)).toBe(false);
    });

    test('单件换单件 → 不捆绑', () => {
        expect(MarketService.isBundleListing(1, 50)).toBe(false);
    });

    test('非法数量按捆绑兜底', () => {
        expect(MarketService.isBundleListing(0, 1)).toBe(true);
        expect(MarketService.isBundleListing(3, 0)).toBe(true);
    });
});
