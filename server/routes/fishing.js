/**
 * 灵溪垂钓系统路由
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *
 * 接口清单（18个）：
 *   1. GET  /config            — 获取配置（无需鉴权）
 *   2. GET  /profile           — 钓鱼档案（需鉴权）
 *   3. GET  /shop              — 钓具商店与鱼塘解锁（需鉴权）
 *   4. POST /rod/buy           — 购买青竹钓竿（需鉴权）
 *   5. POST /rod/upgrade       — 升级钓竿（需鉴权）
 *   6. POST /bait/buy          — 购买鱼饵（需鉴权）
 *   7. POST /bait/craft        — 制作鱼饵（需鉴权）
 *   8. POST /scale-talisman    — 炼制鳞符（需鉴权）
 *   9. POST /cast              — 抛竿（需鉴权）
 *  10. GET  /status            — 会话状态（需鉴权）
 *  11. POST /nibble            — 试探咬饵（需鉴权）
 *  12. POST /reel              — 提竿结算（需鉴权）
 *  13. POST /give-up           — 放弃收竿（需鉴权）
 *  14. GET  /creel             — 鱼篓（需鉴权）
 *  15. GET  /album             — 鱼谱图鉴（需鉴权）
 *  16. POST /fillet            — 剖鱼（需鉴权）
 *  17. POST /cook              — 烹鱼换修为（需鉴权）
 *  18. GET  /ranking           — 排行榜（需鉴权）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const FishingService = require('../game/services/FishingService');

// ============================================================
// 通用响应包装：统一处理 { success, message?, data } 的返回模式
// 成功返回 200 + { code:200, message?, data }
// 失败返回 400 + { code:400, message }
// ============================================================
function wrap(res, result) {
    if (result.success) {
        const body = { code: 200 };
        if (result.message) body.message = result.message;
        if (result.data !== undefined) body.data = result.data;
        return res.json(body);
    }
    return res.status(400).json({ code: 400, message: result.message || '操作失败' });
}

/**
 * 1. 获取灵溪垂钓配置（无需鉴权）
 * 供前端展示鱼塘/钓竿/鱼饵规则说明与解锁条件
 */
router.get('/config', (req, res, next) => {
    try {
        const config = FishingService.getConfig();
        if (!config) {
            return res.status(500).json({ code: 500, message: '灵溪垂钓配置未加载' });
        }
        res.json({ code: 200, data: config });
    } catch (err) {
        next(err);
    }
});

/**
 * 2. 钓鱼档案（需鉴权）
 * 返回：钓竿等级/熟练度/今日已用竿数/今日已获灵石/LDC/最大鱼获/最稀有品质/总成功次数
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await FishingService.getProfile(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 3. 钓具商店（需鉴权）
 * 返回：今日天象/幸运修正/鱼塘列表（含解锁状态）/鱼饵列表/熟练度/钓竿等级
 */
router.get('/shop', auth, async (req, res, next) => {
    try {
        const result = await FishingService.getShop(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 4. 购买青竹钓竿（需鉴权）
 * 消耗 30 LDC，获得初始 1 级钓竿（每日 5 竿）
 */
router.post('/rod/buy', auth, async (req, res, next) => {
    try {
        const result = await FishingService.buyRod(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 5. 升级钓竿（需鉴权）
 * 1→2 银竹：法则碎片·雷 ×30 + 天雷竹 ×1
 * 2→3 金竹：法则碎片·雷 ×80 + 天雷竹 ×3
 * 3→4 金雷竹：法则碎片·雷 ×200 + 天雷竹 ×10
 */
router.post('/rod/upgrade', auth, async (req, res, next) => {
    try {
        const result = await FishingService.upgradeRod(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 6. 购买鱼饵（需鉴权）
 * @body {string} bait_key - 鱼饵key（diworm蚯蚓/spirit_worm灵虫饵/heaven_spirit天灵饵）
 * @body {number} quantity - 数量（1-100）
 */
router.post('/bait/buy', auth, async (req, res, next) => {
    try {
        const { bait_key, quantity } = req.body;
        if (!bait_key) {
            return res.status(400).json({ code: 400, message: '缺少参数 bait_key' });
        }
        const qty = parseInt(quantity, 10);
        if (isNaN(qty) || qty <= 0 || qty > 100) {
            return res.status(400).json({ code: 400, message: '数量无效（1-100）' });
        }
        const result = await FishingService.buyBait(req.player.id, bait_key, qty);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 7. 制作鱼饵（需鉴权）
 * 消耗灵鱼肉/灵鱼鳞/水草团制作自制灵饵（handmade），每日有制作上限
 * @body {string} bait_key - 鱼饵key（仅 handmade 可制作）
 * @body {number} batches - 批次（1-50）
 */
router.post('/bait/craft', auth, async (req, res, next) => {
    try {
        const { bait_key, batches } = req.body;
        if (!bait_key) {
            return res.status(400).json({ code: 400, message: '缺少参数 bait_key' });
        }
        const n = parseInt(batches, 10);
        if (isNaN(n) || n <= 0 || n > 50) {
            return res.status(400).json({ code: 400, message: '批次无效（1-50）' });
        }
        const result = await FishingService.craftBait(req.player.id, bait_key, n);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 8. 炼制鳞符（需鉴权）
 * 消耗灵鱼鳞 ×10，获得 3 竿提竿窗口延长 + 珍稀鱼概率提升 buff
 */
router.post('/scale-talisman', auth, async (req, res, next) => {
    try {
        const result = await FishingService.craftScaleTalisman(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 9. 抛竿（需鉴权）
 * 校验钓竿/鱼饵/日竿数/鱼塘解锁，创建活跃会话，预选鱼类
 * @body {string} pond_id - 鱼塘key（qingyun_stream青云溪/bibo_pool碧波潭/lingquan_lake灵泉湖/luanxing_reef乱星海礁）
 */
router.post('/cast', auth, async (req, res, next) => {
    try {
        const { pond_id } = req.body;
        if (!pond_id) {
            return res.status(400).json({ code: 400, message: '缺少参数 pond_id' });
        }
        const result = await FishingService.cast(req.player.id, pond_id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 10. 会话状态（需鉴权）
 * 返回：当前活跃会话的进度（等待鱼讯/咬饵窗口/试探次数等）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const result = await FishingService.getStatus(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 11. 试探咬饵（需鉴权）
 * 在 nibble_at 之后、reel_deadline 之前可调用，增加珍稀鱼概率
 * 每次试探会缩短提竿窗口，最多 3 次试探
 */
router.post('/nibble', auth, async (req, res, next) => {
    try {
        const result = await FishingService.nibble(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 12. 提竿结算（需鉴权）
 * 在 nibble_at 之后、reel_deadline 之前调用，根据时机判定成功/失败
 */
router.post('/reel', auth, async (req, res, next) => {
    try {
        const result = await FishingService.reel(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 13. 放弃收竿（需鉴权）
 * 主动放弃当前会话，不返还鱼饵与日竿数
 */
router.post('/give-up', auth, async (req, res, next) => {
    try {
        const result = await FishingService.giveUp(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 14. 鱼篓（需鉴权）
 * 分页查询玩家鱼获记录，支持按未剖/已剖过滤
 * @query {number} page - 页码（默认1）
 * @query {number} page_size - 每页数量（默认20，最大50）
 * @query {string} filter - 过滤：all/unfilleted/filleted
 */
router.get('/creel', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 20));
        const filter = ['all', 'unfilleted', 'filleted'].includes(req.query.filter) ? req.query.filter : 'all';
        const result = await FishingService.getCreel(req.player.id, page, pageSize, filter);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 15. 鱼谱图鉴（需鉴权）
 * 返回：所有已发现鱼类 + 发现率 + 每种鱼首次钓获时间/总数/最大重量
 */
router.get('/album', auth, async (req, res, next) => {
    try {
        const result = await FishingService.getAlbum(req.player.id);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 16. 剖鱼（需鉴权）
 * 消耗鱼获记录，产出灵鱼肉/灵鱼鳞/水草团 + 灵石/修为/LDC（有日上限）
 * @body {number} catch_id - 鱼获记录ID
 * @body {number} quantity - 剖鱼数量（1-100）
 */
router.post('/fillet', auth, async (req, res, next) => {
    try {
        const { catch_id, quantity } = req.body;
        const catchId = parseInt(catch_id, 10);
        if (isNaN(catchId) || catchId <= 0) {
            return res.status(400).json({ code: 400, message: '鱼获记录ID无效' });
        }
        const qty = parseInt(quantity, 10) || 1;
        const result = await FishingService.fillet(req.player.id, catchId, qty);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 17. 烹鱼换修为（需鉴权）
 * 消耗灵鱼肉，按 cooking.exp_per_filet 比例获得修为
 * @body {number} quantity - 灵鱼肉数量（1-100）
 */
router.post('/cook', auth, async (req, res, next) => {
    try {
        const { quantity } = req.body;
        const qty = parseInt(quantity, 10);
        if (isNaN(qty) || qty <= 0) {
            return res.status(400).json({ code: 400, message: '数量无效' });
        }
        const result = await FishingService.cook(req.player.id, qty);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 18. 排行榜（需鉴权）
 * @query {string} category - 类别：skill_level/biggest_catch_kg/rarest_catch_quality/total_success
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        const category = req.query.category || 'skill_level';
        const result = await FishingService.getRanking(category);
        wrap(res, result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
