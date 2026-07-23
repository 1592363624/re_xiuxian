/**
 * 傀儡工坊系统路由
 *
 * 玩法文档对照：第23节·大衍诀与傀儡路线
 *
 * 接口清单（11个）：
 *   1. GET  /config              — 获取配置（无需鉴权）
 *   2. GET  /workshop            — 查看工坊（需鉴权）
 *   3. POST /blueprint/learn     — 参悟图谱（需鉴权）
 *   4. POST /manufacture         — 制造傀儡（需鉴权）
 *   5. POST /:id/battle          — 设置出战（需鉴权）
 *   6. POST /:id/guard           — 设置护法（需鉴权）
 *   7. POST /:id/unset           — 取消出战/护法（需鉴权）
 *   8. POST /:id/quench          — 淬炼升级（需鉴权）
 *   9. POST /:id/repair          — 维修耐久（需鉴权）
 *  10. GET  /:id/recycle-preview — 回收预览（需鉴权）
 *  11. POST /:id/recycle         — 确认回收（需鉴权）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const PuppetService = require('../game/services/PuppetService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 1. 获取傀儡工坊配置（无需鉴权）
 * 供前端展示规则说明与傀儡类型详情
 */
router.get('/config', (req, res, next) => {
    try {
        const config = PuppetService.getConfig();
        if (!config) {
            return res.status(500).json({ code: 500, message: '傀儡工坊配置未加载' });
        }
        res.json({ code: 200, data: config });
    } catch (err) {
        next(err);
    }
});

/**
 * 2. 查看傀儡工坊（需鉴权）
 * 返回：玩家所有傀儡 + 已学图谱 + 可制造列表 + 大衍诀层数
 */
router.get('/workshop', auth, async (req, res, next) => {
    try {
        const result = await PuppetService.getWorkshop(req.player.id);
        if (result.success) {
            res.json({ code: 200, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 3. 参悟图谱（需鉴权）
 * 消耗背包中的图谱物品，解锁对应傀儡的制造权限
 * @body {string} blueprint_key - 图谱key
 */
router.post('/blueprint/learn', auth, async (req, res, next) => {
    try {
        const { blueprint_key } = req.body;
        if (!blueprint_key) {
            return res.status(400).json({ code: 400, message: '缺少参数 blueprint_key' });
        }
        const result = await PuppetService.learnBlueprint(req.player.id, blueprint_key);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 4. 制造傀儡（需鉴权）
 * 校验大衍诀层数 + 图谱 + 灵石 + 材料，消耗后创建傀儡
 * @body {string} puppet_type - 傀儡类型key
 */
router.post('/manufacture', auth, async (req, res, next) => {
    try {
        const { puppet_type } = req.body;
        if (!puppet_type) {
            return res.status(400).json({ code: 400, message: '缺少参数 puppet_type' });
        }
        const result = await PuppetService.manufacture(req.player.id, puppet_type);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 5. 设置出战傀儡（需鉴权）
 * 出战傀儡在 PVP/PVE 战斗中提供属性加成（battle_stat_ratio × 傀儡属性）
 */
router.post('/:id/battle', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.setBattle(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 6. 设置护法傀儡（需鉴权）
 * 护法傀儡在闭关被袭击时自动反击（guard_counter_ratio × 傀儡攻击力）
 */
router.post('/:id/guard', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.setGuard(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 7. 取消出战/护法（需鉴权）
 * 将傀儡状态设为闲置
 */
router.post('/:id/unset', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.unsetRole(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 8. 淬炼傀儡（需鉴权）
 * 消耗灵石+机关核心，提升等级与属性，成功率随等级递减
 */
router.post('/:id/quench', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.quench(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 9. 维修傀儡（需鉴权）
 * 消耗灵石+机关核心，恢复耐久度至满值
 */
router.post('/:id/repair', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.repair(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 10. 回收预览（需鉴权）
 * 计算回收可返还的材料与灵石，不实际执行
 */
router.get('/:id/recycle-preview', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.recyclePreview(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * 11. 确认回收（需鉴权）
 * 删除傀儡，返还部分材料与灵石（二步确认的第二步）
 */
router.post('/:id/recycle', auth, async (req, res, next) => {
    try {
        const puppetId = parseInt(req.params.id, 10);
        if (isNaN(puppetId) || puppetId <= 0) {
            return res.status(400).json({ code: 400, message: '傀儡ID无效' });
        }
        const result = await PuppetService.recycle(req.player.id, puppetId);
        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            res.status(400).json({ code: 400, message: result.message });
        }
    } catch (err) {
        next(err);
    }
});

module.exports = router;
