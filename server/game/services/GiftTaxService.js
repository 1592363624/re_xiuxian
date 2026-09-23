/**
 * 赠送因果税（天道法则：因果重税）
 *
 * 对应 linux.do 帖「因果税与坊市铁律」：
 *   1. 基础税率 10%（天道截留）
 *   2. 接收方低于筑基期 → 额外 +40% 凡人税（防小号）
 *   3. 单次灵石 > 1 万 → +10%；> 10 万 → +20%（巨额累进，防洗钱）
 *   4. 赠送物品时发送方按物品估值支付等值灵石作为手续费；灵石不足则失败
 *
 * 税率叠加封顶 95%，保证至少能送到 5%。
 */
'use strict';

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/** 筑基期门槛（realm_rank）：低于此为「凡人税」对象 */
const FOUNDATION_REALM_RANK = 3;

const DEFAULT_TAX = {
    base_rate: 0.10,
    low_realm_extra_rate: 0.40,
    low_realm_rank: FOUNDATION_REALM_RANK,
    large_stone_extra_rate: 0.10,
    large_stone_threshold: 10000,
    huge_stone_extra_rate: 0.20,
    huge_stone_threshold: 100000,
    item_tax_rate: 1.0,          // 物品税 = 等值灵石 × 100%（帖：发送方需支付等值的灵石作为手续费）
    max_tax_rate: 0.95
};

class GiftTaxService {
    /**
     * 计算赠送灵石的因果税
     * @param {Object} params
     * @param {number} params.stoneAmount - 赠送灵石数
     * @param {number} params.recipientRealmRank - 接收方 realm_rank
     * @param {Object} [taxConfig] - 可覆盖的税率表
     * @returns {{tax_rate:number, tax_amount:number, net_amount:number, breakdown:Object}}
     */
    computeStoneTax({ stoneAmount, recipientRealmRank }, taxConfig = {}) {
        const cfg = { ...DEFAULT_TAX, ...taxConfig };
        const amount = Math.max(0, Math.floor(Number(stoneAmount) || 0));
        if (amount <= 0) {
            return { tax_rate: 0, tax_amount: 0, net_amount: 0, breakdown: { base: 0, low_realm: 0, large: 0, huge: 0 } };
        }

        let rate = cfg.base_rate;
        const breakdown = { base: cfg.base_rate, low_realm: 0, large: 0, huge: 0 };

        const rank = Number(recipientRealmRank) || 0;
        if (rank > 0 && rank < cfg.low_realm_rank) {
            rate += cfg.low_realm_extra_rate;
            breakdown.low_realm = cfg.low_realm_extra_rate;
        }
        if (amount > cfg.huge_stone_threshold) {
            rate += cfg.huge_stone_extra_rate;
            breakdown.huge = cfg.huge_stone_extra_rate;
        } else if (amount > cfg.large_stone_threshold) {
            rate += cfg.large_stone_extra_rate;
            breakdown.large = cfg.large_stone_extra_rate;
        }

        rate = Math.min(rate, cfg.max_tax_rate);
        const taxAmount = Math.floor(amount * rate);
        return {
            tax_rate: rate,
            tax_amount: taxAmount,
            net_amount: amount - taxAmount,
            breakdown
        };
    }

    /**
     * 计算赠送物品的手续费（发送方以灵石支付）
     * @param {number} itemValuation - 物品天道估值（price × 数量）
     * @param {Object} [taxConfig]
     * @returns {{fee:number, rate:number}}
     */
    computeItemFee(itemValuation, taxConfig = {}) {
        const cfg = { ...DEFAULT_TAX, ...taxConfig };
        const valuation = Math.max(0, Math.floor(Number(itemValuation) || 0));
        // 物品手续费是「等值灵石」，不走灵石税的 95% 封顶（那条是防税光转账）
        const rate = Math.max(0, Number(cfg.item_tax_rate) || 0);
        return { fee: Math.floor(valuation * rate), rate };
    }

    /**
     * 校验发送方灵石是否足够支付物品手续费
     */
    assertCanPayItemFee(senderStones, fee) {
        const have = Number(senderStones) || 0;
        if (have < fee) {
            throw new AppError(
                `灵石不足以支付因果税手续费（需要 ${fee}，持有 ${have}）`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }
    }
}

module.exports = new GiftTaxService();
module.exports.GiftTaxService = GiftTaxService;
module.exports.DEFAULT_TAX = DEFAULT_TAX;
