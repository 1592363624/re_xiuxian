/**
 * 赠送系统（因果重税）
 *
 * 1. POST /api/gift/stones  - 赠送灵石（body: target_player_id, amount）
 * 2. POST /api/gift/items   - 赠送物品（body: target_player_id, item_key, quantity）
 * 3. GET  /api/gift/preview - 试算税费（query: amount | item_key&quantity&target_player_id）
 */
'use strict';

const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const GiftTaxService = require('../game/services/GiftTaxService');
const InventoryService = require('../game/services/InventoryService');

/** BigInt 安全转数（spirit_stones 列是 BIGINT） */
function safeBigInt(value) {
    try {
        return BigInt(value ?? 0);
    } catch (_) {
        return 0n;
    }
}

async function loadPlayersForGift(senderId, targetId) {
    const t = await sequelize.transaction();
    try {
        const ids = [Number(senderId), Number(targetId)].map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
        if (ids.length !== 2 || ids[0] === ids[1]) {
            await t.rollback();
            throw new AppError('赠送目标无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const rows = await Player.findAll({
            where: { id: ids },
            order: [['id', 'ASC']],
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        const byId = new Map(rows.map(p => [Number(p.id), p]));
        const sender = byId.get(Number(senderId));
        const target = byId.get(Number(targetId));
        if (!sender || !target) {
            await t.rollback();
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        return { t, sender, target };
    } catch (e) {
        if (!t.finished) await t.rollback().catch(() => {});
        throw e;
    }
}

/** GET /api/gift/preview */
router.get('/preview', auth, async (req, res, next) => {
    try {
        const amount = Number(req.query.amount) || 0;
        const itemKey = req.query.item_key;
        const quantity = Number(req.query.quantity) || 1;
        const targetId = Number(req.query.target_player_id);

        if (amount > 0 && Number.isFinite(targetId)) {
            const target = await Player.findByPk(targetId);
            if (!target) throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const tax = GiftTaxService.computeStoneTax({
                stoneAmount: amount,
                recipientRealmRank: target.realm_rank
            });
            return res.json({ code: 200, data: { kind: 'stones', ...tax } });
        }

        if (itemKey) {
            const { infrastructure } = require('../modules');
            const items = infrastructure.ConfigLoader.getConfig?.('item_data')?.items || [];
            const itemConfig = items.find(i => String(i.id) === itemKey) || null;
            const unitPrice = Number(itemConfig?.price) || Number(req.query.unit_price) || 0;
            const fee = GiftTaxService.computeItemFee(unitPrice * quantity);
            return res.json({ code: 200, data: { kind: 'items', valuation: unitPrice * quantity, ...fee } });
        }

        throw new AppError('请提供 amount 或 item_key', 400, ErrorCodes.VALIDATION_ERROR);
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

/** POST /api/gift/stones */
router.post('/stones', auth, async (req, res, next) => {
    const { t, sender, target } = await loadPlayersForGift(req.player.id, req.body.target_player_id).catch(e => {
        next(e);
        return {};
    });
    if (!t) return;
    try {
        const amount = Math.floor(Number(req.body.amount) || 0);
        if (amount <= 0) {
            await t.rollback();
            return res.status(400).json({ code: 400, error_code: ErrorCodes.VALIDATION_ERROR, message: '赠送数量无效' });
        }
        const have = safeBigInt(sender.spirit_stones);
        if (have < BigInt(amount)) {
            await t.rollback();
            return res.status(400).json({ code: 400, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR, message: '灵石不足' });
        }

        const tax = GiftTaxService.computeStoneTax({
            stoneAmount: amount,
            recipientRealmRank: target.realm_rank
        });

        sender.spirit_stones = have - BigInt(amount);
        target.spirit_stones = safeBigInt(target.spirit_stones) + BigInt(tax.net_amount);
        await sender.save({ transaction: t });
        await target.save({ transaction: t });
        await t.commit();

        res.json({
            code: 200,
            message: `已赠送 ${tax.net_amount} 灵石（因果税 ${tax.tax_amount}，税率 ${(tax.tax_rate * 100).toFixed(0)}%）`,
            data: { ...tax, sent: amount, target_player_id: Number(target.id) }
        });
    } catch (err) {
        await t.rollback().catch(() => {});
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

/** POST /api/gift/items —— 发送方按物品估值支付等值灵石手续费 */
router.post('/items', auth, async (req, res, next) => {
    const { t, sender, target } = await loadPlayersForGift(req.player.id, req.body.target_player_id).catch(e => {
        next(e);
        return {};
    });
    if (!t) return;
    try {
        const itemKey = String(req.body.item_key || '');
        const quantity = Math.max(1, Math.floor(Number(req.body.quantity) || 1));
        if (!itemKey) {
            await t.rollback();
            return res.status(400).json({ code: 400, error_code: ErrorCodes.VALIDATION_ERROR, message: '缺少 item_key' });
        }

        // 转移物品：先扣后加（同一事务）
        await InventoryService.removeItem(sender.id, itemKey, quantity, t);
        await InventoryService.addItem(target.id, itemKey, quantity, t);

        // 天道估值：item_data.json 的 price
        const { infrastructure } = require('../modules');
        const items = infrastructure.ConfigLoader.getConfig?.('item_data')?.items || [];
        const itemConfig = items.find(i => String(i.id) === itemKey) || null;
        const unitPrice = Number(itemConfig?.price) || Number(req.body.unit_price) || 0;
        const valuation = unitPrice * quantity;
        const fee = GiftTaxService.computeItemFee(valuation);
        GiftTaxService.assertCanPayItemFee(sender.spirit_stones, fee.fee);

        sender.spirit_stones = safeBigInt(sender.spirit_stones) - BigInt(fee.fee);
        // 手续费归天道回收（不转给接收方）
        await sender.save({ transaction: t });
        await t.commit();

        res.json({
            code: 200,
            message: `已赠送 ${quantity} 个物品，因果税手续费 ${fee.fee} 灵石`,
            data: { item_key: itemKey, quantity, valuation, fee: fee.fee, fee_rate: fee.rate }
        });
    } catch (err) {
        await t.rollback().catch(() => {});
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
