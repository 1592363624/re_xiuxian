/**
 * QQ 登录与账号绑定路由
 *
 * 设计前提：QQ 只是"第二种登录凭证"，游戏账号仍以注册流程产生的 players 记录为主体。
 * 因此本文件不创建玩家，只负责把 QQ 身份挂到已有账号上，以及凭挂载关系放行登录。
 *
 * 完整链路（intent=login）：
 *   前端 GET /authorize-url → 跳转 QQ 授权页 → QQ 回调 GET /callback（浏览器顶层跳转）
 *   → 后端换取 openid 并查绑定
 *     · 已绑定：签发 JWT，换成 60 秒一次性票据后 302 回前端 ?qq_ticket=
 *     · 未绑定：302 回前端 ?qq_pending=，前端引导玩家登录/注册后 POST /bind 完成绑定
 *
 * 票据走一次性 ticket 而非把 JWT 直接拼进 URL，是因为 URL 会留在浏览器历史与
 * Referer 头里，等同于把 7 天有效的登录凭证长期暴露。
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const PlayerOAuthBinding = require('../models/playerOAuthBinding');
const QQOAuthService = require('../game/services/QQOAuthService');
const LoginSession = require('../game/core/LoginSession');
const authMiddleware = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const PROVIDER = 'qq';

/** OAuth state 与待绑定票据的有效期：QQ 授权页停留时间不会超过这个量级 */
const STATE_TTL_MS = 10 * 60 * 1000;
/** 登录票据有效期：只需撑过 302 回前端到前端发起兑换的一次往返 */
const TICKET_TTL_MS = 60 * 1000;

const oauthStates = QQOAuthService.createTtlStore(STATE_TTL_MS);
const loginTickets = QQOAuthService.createTtlStore(TICKET_TTL_MS);
const pendingBinds = QQOAuthService.createTtlStore(STATE_TTL_MS);

/**
 * 回调后 302 回前端的地址。
 *
 * 默认留空走相对路径：QQ 回调命中的是哪个 origin，就把票据回跳到哪个 origin 的根目录。
 * 前端 apiClient 的 baseURL 本来就是 '/api'，说明部署形态已假定前后端同源（或由网关
 * 代理 /api），此时相对跳转在开发（vite proxy）和生产（nginx）下都正确。
 * 仅当前后端确实分处不同主机时才需要配置 QQ_FRONTEND_URL。
 */
function getFrontendUrl() {
    return (process.env.QQ_FRONTEND_URL || '').replace(/\/+$/, '');
}

function redirectToFrontend(res, params) {
    const query = new URLSearchParams(params).toString();
    const base = getFrontendUrl();
    res.redirect(base ? `${base}/?${query}` : `/?${query}`);
}

function toBindingPayload(binding) {
    if (!binding) return null;
    return {
        nickname: binding.nickname,
        avatarUrl: binding.avatar_url,
        boundAt: binding.createdAt,
        lastLoginAt: binding.last_login_at
    };
}

// 前端据此决定是否展示 QQ 登录入口
router.get('/config', (req, res) => {
    res.json({ code: 200, enabled: QQOAuthService.isConfigured() });
});

/**
 * 取 QQ 授权页跳转地址
 * intent=login 匿名可发起；intent=bind 必须已登录，且该账号尚未绑定 QQ
 */
router.get('/authorize-url', (req, res, next) => {
    if (req.query.intent !== 'bind') return next();
    return authMiddleware(req, res, next);
}, async (req, res, next) => {
    try {
        if (!QQOAuthService.isConfigured()) {
            throw new AppError('QQ 登录尚未开放', 400, ErrorCodes.FEATURE_DISABLED);
        }

        const intent = req.query.intent === 'bind' ? 'bind' : 'login';
        let playerId = null;

        if (intent === 'bind') {
            playerId = req.user.id;
            const existing = await PlayerOAuthBinding.findOne({
                where: { provider: PROVIDER, player_id: playerId }
            });
            if (existing) {
                throw new AppError('该账号已绑定 QQ，请先解绑后再换绑', 400, ErrorCodes.ALREADY_EXISTS);
            }
        }

        const state = oauthStates.put({ intent, playerId });
        res.json({ code: 200, url: QQOAuthService.buildAuthorizeUrl(state) });
    } catch (error) {
        next(error);
    }
});

/**
 * QQ 授权回调（浏览器顶层跳转，非 XHR）
 *
 * 此处的失败一律 302 回前端并用 qq_error 携带提示，不能走 JSON 错误处理，
 * 否则玩家会在浏览器里看到一坨接口报文。
 *
 * 未加 authLimiter：state 是 128 位随机一次性值，非法请求在内存查不到就直接回跳，
 * 不触达数据库和 QQ 接口，没有可刷的东西；而登录/注册限流桶本就紧张，再挤进来
 * 一次回调会让网吧等共享出口 IP 的玩家被误伤。
 */
router.get('/callback', async (req, res, next) => {
    const stateData = oauthStates.take(req.query.state);

    const fail = (message) => redirectToFrontend(res, { qq_error: message });

    try {
        // state 缺失/过期/已被使用，视同 CSRF 尝试或上一次流程的残留回调
        if (!stateData) {
            return fail('授权流程已过期，请重新发起 QQ 登录');
        }
        // 玩家在 QQ 授权页点了拒绝
        if (req.query.error || !req.query.code) {
            return fail('已取消 QQ 授权');
        }

        const profile = await QQOAuthService.exchangeCode(req.query.code);

        if (stateData.intent === 'bind') {
            return await completeBind(res, stateData.playerId, profile);
        }
        return await completeLogin(res, req, profile);
    } catch (error) {
        if (error instanceof QQOAuthService.QQAuthError) {
            return fail(error.message);
        }
        return next(error);
    }
});

/** 已绑定 → 发登录票据；未绑定 → 发待绑定票据，由前端引导登录/注册 */
async function completeLogin(res, req, profile) {
    const binding = await PlayerOAuthBinding.findOne({
        where: { provider: PROVIDER, open_id: profile.openId }
    });

    if (!binding) {
        const pendingTicket = pendingBinds.put(profile);
        return redirectToFrontend(res, { qq_pending: pendingTicket });
    }

    const player = await Player.findByPk(binding.player_id);
    if (!player) {
        // 账号已被删除但绑定残留，清掉后让玩家重新绑定
        await binding.destroy();
        return fail('绑定的账号已不存在，请重新绑定');
    }

    const token = await LoginSession.issueLoginToken(player, req);
    binding.last_login_at = new Date();
    // 借每次登录刷新资料：玩家换了 QQ 头像能跟上，绑定时 get_user_info 失败的也能补上
    if (profile.nickname) binding.nickname = profile.nickname;
    if (profile.avatarUrl) binding.avatar_url = profile.avatarUrl;
    await binding.save();

    return redirectToFrontend(res, { qq_ticket: loginTickets.put(token) });
}

/** 设置面板发起的绑定：playerId 来自签发 state 时的已登录会话 */
async function completeBind(res, playerId, profile) {
    const occupiedBy = await PlayerOAuthBinding.findOne({
        where: { provider: PROVIDER, open_id: profile.openId }
    });
    if (occupiedBy && String(occupiedBy.player_id) !== String(playerId)) {
        return redirectToFrontend(res, { qq_error: '该 QQ 已绑定其他账号，请先在原账号解绑' });
    }

    if (occupiedBy) {
        await occupiedBy.update({
            nickname: profile.nickname,
            avatar_url: profile.avatarUrl
        });
    } else {
        await PlayerOAuthBinding.create({
            provider: PROVIDER,
            open_id: profile.openId,
            union_id: profile.unionId,
            player_id: playerId,
            nickname: profile.nickname,
            avatar_url: profile.avatarUrl
        });
    }

    return redirectToFrontend(res, { qq_bind: 'success' });
}

/** 一次性登录票据换正式 JWT（票据随机且取出即失效，无法暴力猜测或重放） */
router.post('/exchange', (req, res, next) => {
    try {
        const token = loginTickets.take(req.body?.ticket);
        if (!token) {
            throw new AppError('登录凭证已失效，请重新扫码', 400, ErrorCodes.VALIDATION_ERROR);
        }
        res.json({ code: 200, message: 'QQ 登录成功', token });
    } catch (error) {
        next(error);
    }
});

/** 展示未绑定 QQ 的资料，供登录页提示"即将绑定到哪个 QQ" */
router.get('/pending', (req, res, next) => {
    try {
        const profile = pendingBinds.peek(req.query.ticket);
        if (!profile) {
            throw new AppError('绑定会话已过期，请重新发起 QQ 登录', 400, ErrorCodes.VALIDATION_ERROR);
        }
        res.json({
            code: 200,
            profile: { nickname: profile.nickname, avatarUrl: profile.avatarUrl }
        });
    } catch (error) {
        next(error);
    }
});

/** 登录/注册完成后，把待绑定的 QQ 挂到当前账号 */
router.post('/bind', authMiddleware, async (req, res, next) => {
    try {
        const profile = pendingBinds.take(req.body?.pendingTicket);
        if (!profile) {
            throw new AppError('绑定会话已过期，请重新发起 QQ 登录', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.user.id;

        const existingForPlayer = await PlayerOAuthBinding.findOne({
            where: { provider: PROVIDER, player_id: playerId }
        });
        if (existingForPlayer) {
            throw new AppError('该账号已绑定 QQ，请先解绑后再换绑', 400, ErrorCodes.ALREADY_EXISTS);
        }

        const existingForQQ = await PlayerOAuthBinding.findOne({
            where: { provider: PROVIDER, open_id: profile.openId }
        });
        if (existingForQQ) {
            throw new AppError('该 QQ 已绑定其他账号，请先在原账号解绑', 400, ErrorCodes.ALREADY_EXISTS);
        }

        const binding = await PlayerOAuthBinding.create({
            provider: PROVIDER,
            open_id: profile.openId,
            union_id: profile.unionId,
            player_id: playerId,
            nickname: profile.nickname,
            avatar_url: profile.avatarUrl
        });

        res.json({ code: 200, message: 'QQ 绑定成功', binding: toBindingPayload(binding) });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return next(new AppError('该 QQ 或账号已完成绑定', 400, ErrorCodes.ALREADY_EXISTS));
        }
        next(error);
    }
});

router.get('/binding', authMiddleware, async (req, res, next) => {
    try {
        const binding = await PlayerOAuthBinding.findOne({
            where: { provider: PROVIDER, player_id: req.user.id }
        });
        res.json({
            code: 200,
            enabled: QQOAuthService.isConfigured(),
            binding: toBindingPayload(binding)
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 解绑。解绑后该 QQ 不能再登录，但账号本身仍可用账号密码登录——
 * 玩家如果同时忘了密码就会失去账号，因此前端需要二次确认。
 */
router.delete('/binding', authMiddleware, async (req, res, next) => {
    try {
        const binding = await PlayerOAuthBinding.findOne({
            where: { provider: PROVIDER, player_id: req.user.id }
        });
        if (!binding) {
            throw new AppError('该账号尚未绑定 QQ', 404, ErrorCodes.NOT_FOUND);
        }
        await binding.destroy();
        res.json({ code: 200, message: '已解除 QQ 绑定' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
