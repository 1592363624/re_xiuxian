/**
 * 账号数据删除 / 清档路由（玩家自助）。
 *
 *   GET  /api/account/deletion-preview  预览将清除的内容
 *   POST /api/account/delete            执行清除（keep 清档留号 / delete 注销删号）
 *
 * 权限：JWT 本人；管理员号拒绝自助（防误触/盗号一键清）。GM 通道走 /api/admin/players/:id。
 * 确认语 + 密码双闸：防误触与盗号后静默毁号。
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const auth = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const AccountDeletionService = require('../game/services/AccountDeletionService');

/**
 * GET /api/account/deletion-preview
 * 只读预览：将删多少行、引用保留多少。
 */
router.get('/deletion-preview', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const preview = await AccountDeletionService.preview(playerId, { accountMode: 'delete' });
        const previewKeep = await AccountDeletionService.preview(playerId, { accountMode: 'keep' });

        res.json({
            code: 200,
            data: {
                account_mode_options: AccountDeletionService.ACCOUNT_MODES,
                confirm_phrases: AccountDeletionService.CONFIRM_PHRASES,
                preview_delete: preview,
                preview_keep: previewKeep,
                notes: preview.notes
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/account/delete
 * Body: { account_mode, confirm_phrase, password, new_nickname?, reason? }
 */
router.post('/delete', auth, authLimiter, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const { account_mode, confirm_phrase, password, new_nickname, reason } = req.body || {};

        const mode = AccountDeletionService.assertMode(account_mode);

        // 管理员号不许自助清 —— 提权状态下的误触会毁掉真账号
        if (req.player.role === 'admin') {
            throw new AppError(
                '管理员账号不能自助清除，请由另一位管理员在后台操作',
                403,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        const expected = AccountDeletionService.CONFIRM_PHRASES[mode];
        if (confirm_phrase !== expected) {
            throw new AppError(
                `确认短语不正确，请准确输入「${expected}」`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        if (!password || typeof password !== 'string') {
            throw new AppError('请输入当前密码以确认身份', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const Player = require('../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const ok = await bcrypt.compare(password, player.password);
        if (!ok) {
            throw new AppError('密码错误', 401, ErrorCodes.UNAUTHORIZED);
        }

        if (reason != null && String(reason).length > 200) {
            throw new AppError('reason 不超过 200 字', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await AccountDeletionService.execute(playerId, {
            accountMode: mode,
            newNickname: mode === 'keep' ? new_nickname : undefined,
            actorId: playerId,
            reason: reason ? String(reason) : null,
            ip: req.ip || req.connection?.remoteAddress || null
        });

        // 尽力踢线（delete 后行已不在，auth 也会拒；keep 后 token_version 已 +1）
        try {
            const webSocketNotificationService = require('../game/services/WebSocketNotificationService');
            webSocketNotificationService.notifyPlayerUpdate(playerId, mode === 'keep' ? 'account_wipe' : 'account_delete');
        } catch (_) { /* 踢线失败不影响删除结果 */ }

        res.json({
            code: 200,
            message: mode === 'keep' ? '数据已清除，请重新登录开启新的仙途' : '账号已注销',
            data: result
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
