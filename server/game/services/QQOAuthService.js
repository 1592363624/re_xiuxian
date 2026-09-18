/**
 * QQ 互联 OAuth2.0 服务
 *
 * 凭据来自 .env：QQ_APP_ID（AppID）/ QQ_APP_KEY（AppKey）/ QQ_REDIRECT_URI（回调地址）
 * 回调地址的域名必须与 QQ 互联后台备案登记的域名一致，否则 QQ 会直接拒绝授权。
 *
 * QQ 这三个接口都不走标准 OAuth2.0 约定，实现时容易踩，故在此集中处理：
 *   1. token 接口返回 text/plain 的 querystring，不是 JSON
 *   2. /me 接口返回 JSONP 包裹体 `callback( {...} );`，需剥壳后再解析
 *   3. get_user_info 需要额外带 oauth_consumer_key（即 AppID），且新审核应用常拿不到
 *      昵称头像（ret != 0），因此资料获取按"尽力而为"处理，不阻断登录
 */
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

const ENDPOINTS = {
    authorize: 'https://connect.qq.com/authorize',
    token: 'https://graph.qq.com/oauth2.0/token',
    openid: 'https://graph.qq.com/oauth2.0/me',
    userInfo: 'https://graph.qq.com/user/get_user_info'
};

/** QQ 接口偶发慢响应，10 秒后放弃并提示玩家重试，避免请求堆积 */
const QQ_HTTP_TIMEOUT_MS = 10000;

/** QQ 侧拒绝授权 / 令牌失效等错误时返回的提示文案 */
class QQAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QQAuthError';
    }
}

function getQQConfig() {
    return {
        appId: process.env.QQ_APP_ID || '',
        appKey: process.env.QQ_APP_KEY || '',
        redirectUri: process.env.QQ_REDIRECT_URI || ''
    };
}

/**
 * 三项凭据齐备才认为 QQ 登录可用；未配置时前端隐藏入口、后端拒绝发起授权
 */
function isConfigured() {
    const { appId, appKey, redirectUri } = getQQConfig();
    return Boolean(appId && appKey && redirectUri);
}

/**
 * 生成跳转到 QQ 授权页的地址
 * @param {string} state - 由调用方签发并暂存的 CSRF state，QQ 原样回传
 */
function buildAuthorizeUrl(state) {
    const { appId, redirectUri } = getQQConfig();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: appId,
        redirect_uri: redirectUri,
        state,
        scope: 'get_user_info'
    });
    return `${ENDPOINTS.authorize}?${params.toString()}`;
}

/**
 * 用授权码换取 QQ 用户身份
 *
 * @param {string} code - QQ 回调携带的授权码（一次性，约 10 分钟内有效）
 * @returns {Promise<{openId:string, unionId:?string, nickname:?string, avatarUrl:?string}>}
 * @throws {QQAuthError} 授权码无效、已使用或 QQ 接口异常
 */
async function exchangeCode(code) {
    const { appId, appKey, redirectUri } = getQQConfig();

    // 1) code -> access_token：响应是 urlencoded 文本，禁用 axios 的自动 JSON 解析
    const tokenRes = await axios.get(ENDPOINTS.token, {
        params: {
            grant_type: 'authorization_code',
            client_id: appId,
            client_secret: appKey,
            code,
            redirect_uri: redirectUri
        },
        timeout: QQ_HTTP_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: [data => data]
    });

    const tokenData = querystring.parse(String(tokenRes.data));
    if (!tokenData.access_token) {
        throw new QQAuthError('QQ 授权失败，请重新扫码');
    }

    // 2) access_token -> openid：响应被 `callback( ... );` 包裹，取出花括号片段再解析
    const meRes = await axios.get(ENDPOINTS.openid, {
        params: { access_token: tokenData.access_token },
        timeout: QQ_HTTP_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: [data => data]
    });

    const payloadMatch = String(meRes.data).match(/\{[^{}]*\}/);
    if (!payloadMatch) {
        throw new QQAuthError('QQ 身份校验失败，请重新扫码');
    }

    const me = JSON.parse(payloadMatch[0]);
    // 回传的 client_id 与本机配置不符，说明令牌不是发给本应用的
    if (me.client_id && String(me.client_id) !== String(appId)) {
        throw new QQAuthError('QQ 身份校验失败，请重新扫码');
    }
    if (!me.openid) {
        throw new QQAuthError('QQ 未返回有效身份，请重新扫码');
    }

    const profile = {
        openId: me.openid,
        unionId: me.unionid || null,
        nickname: null,
        avatarUrl: null
    };

    // 3) 昵称与头像仅用于展示，取不到不影响登录
    try {
        const infoRes = await axios.get(ENDPOINTS.userInfo, {
            params: {
                access_token: tokenData.access_token,
                oauth_consumer_key: appId,
                openid: me.openid
            },
            timeout: QQ_HTTP_TIMEOUT_MS
        });
        if (infoRes.data?.ret === 0) {
            profile.nickname = infoRes.data.nickname || null;
            profile.avatarUrl = infoRes.data.figureurl_qq_2 || infoRes.data.figureurl_qq_1 || null;
        }
    } catch (err) {
        console.warn('[QQ] 获取用户资料失败（不影响登录）:', err.message);
    }

    return profile;
}

/**
 * 分钟级一次性暂存，用于 OAuth state、登录票据、待绑定票据
 *
 * 不落库是因为这三类数据生命周期都在分钟级、且必须一次性消费；服务重启只会让进行中
 * 的授权流程失效（玩家重点一次 QQ 登录即可），不会破坏已完成的绑定关系。
 * 本服务为单进程部署（node index.js），进程内 Map 即为唯一事实来源。
 */
function createTtlStore(ttlMs) {
    const entries = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= now) entries.delete(key);
        }
    }, Math.max(ttlMs, 30_000));
    // 不阻止进程退出
    sweep.unref();

    return {
        /** 存入并返回随机 key（可直接作为 state 或票据） */
        put(value) {
            const key = crypto.randomBytes(16).toString('hex');
            entries.set(key, { value, expiresAt: Date.now() + ttlMs });
            return key;
        },
        /** 读取但不消费，用于展示后再提交 */
        peek(key) {
            const entry = entries.get(key);
            if (!entry) return null;
            if (entry.expiresAt <= Date.now()) {
                entries.delete(key);
                return null;
            }
            return entry.value;
        },
        /** 取出即失效，保证票据一次性，防止重放 */
        take(key) {
            const entry = entries.get(key);
            if (!entry) return null;
            entries.delete(key);
            return entry.expiresAt > Date.now() ? entry.value : null;
        }
    };
}

module.exports = {
    QQAuthError,
    getQQConfig,
    isConfigured,
    buildAuthorizeUrl,
    exchangeCode,
    createTtlStore
};
