/**
 * gift 物品估值与数量钳制（不连库）
 *
 * 钉住三件事：
 *   1) 估值只来自服务端 item_data.price，客户端 unit_price 无法压低手续费
 *   2) 缺 price 的物品必须拒绝赠送（不能免费送）
 *   3) 数量/金额钳制：非正整数、超上限一律拒绝
 */
'use strict';

const configLoader = require('../modules/infrastructure/ConfigLoader');
const GiftTaxService = require('../game/services/GiftTaxService');

configLoader.setMergedConfig('item_data', {
    items: [
        { id: 'spirit_sword', name: '灵剑', price: 1000 },
        { id: 'priceless_artifact', name: '无价神器', price: 999999 },
        { id: 'no_price_item', name: '未定价物' }
    ]
});

afterAll(() => {
    configLoader.configCache.delete('item_data');
});

describe('物品估值来源', () => {
    test('只读服务端 price，不采信客户端 unit_price', () => {
        // 旧漏洞：unitPrice = config.price || req.body.unit_price || 0
        // 现在 resolveItemUnitPrice 根本不接收客户端入参
        expect(GiftTaxService.resolveItemUnitPrice('spirit_sword')).toBe(1000);

        // 手续费按配置价计，与假设的客户端出价无关
        const clientUnitPrice = 0;
        const fee = GiftTaxService.computeItemFee(
            GiftTaxService.resolveItemUnitPrice('spirit_sword') * 2
        );
        expect(fee.fee).toBe(2000);
        expect(fee.fee).not.toBe(clientUnitPrice * 2);
    });

    test('缺 price 的物品拒绝赠送', () => {
        expect(() => GiftTaxService.resolveItemUnitPrice('no_price_item')).toThrow(/天道估值/);
        expect(() => GiftTaxService.resolveItemUnitPrice('not_exist')).toThrow(/天道估值/);
    });

    test('高价物品按配置全额计费', () => {
        const unit = GiftTaxService.resolveItemUnitPrice('priceless_artifact');
        expect(unit).toBe(999999);
        expect(GiftTaxService.computeItemFee(unit).fee).toBe(999999);
    });
});

describe('数量/金额钳制', () => {
    test('非正整数拒绝', () => {
        expect(() => GiftTaxService.parsePositiveInt(0, '赠送数量')).toThrow(/正整数/);
        expect(() => GiftTaxService.parsePositiveInt(-1, '赠送数量')).toThrow(/正整数/);
        expect(() => GiftTaxService.parsePositiveInt(1.5, '赠送数量')).toThrow(/正整数/);
        expect(() => GiftTaxService.parsePositiveInt('abc', '赠送数量')).toThrow(/正整数/);
        expect(() => GiftTaxService.parsePositiveInt(NaN, '赠送数量')).toThrow(/正整数/);
    });

    test('超上限拒绝', () => {
        expect(GiftTaxService.parsePositiveInt(1, '赠送数量', { max: 9999 })).toBe(1);
        expect(GiftTaxService.parsePositiveInt(9999, '赠送数量', { max: 9999 })).toBe(9999);
        expect(() => GiftTaxService.parsePositiveInt(10000, '赠送数量', { max: 9999 })).toThrow(/上限/);
    });
});
