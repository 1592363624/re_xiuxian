/**
 * 宗门外交路由
 * GET  /api/sect-diplomacy/board     - 天下大势 / 我的外交版图
 * POST /api/sect-diplomacy/relation  - 掌门敕令：示好/敌对/结盟/解除
 * POST /api/sect-diplomacy/appoint   - [GM] 手动任命掌门
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const SectDiplomacyService = require('../game/services/SectDiplomacyService');

router.get('/board', auth, async (req, res, next) => {
    try {
        const publicOnly = req.query.public === '1' || req.query.public === 'true';
        const data = await SectDiplomacyService.getBoard(req.player.id, { publicOnly });
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/relation', auth, async (req, res, next) => {
    try {
        const { action, target_sect: targetSect } = req.body;
        const data = await SectDiplomacyService.changeRelation(req.player.id, action, targetSect);
        res.json({ code: 200, message: `外交关系已更新：${data.status}`, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') next();
    else res.status(403).json({ code: 403, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR, message: '需要管理员权限' });
};

router.post('/appoint', auth, adminCheck, async (req, res, next) => {
    try {
        const data = await SectDiplomacyService.appointLeaders();
        res.json({ code: 200, message: `已任命 ${data.length} 个宗门掌门`, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
