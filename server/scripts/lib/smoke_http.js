/**
 * 冒烟探针共用工具：把真实 app 拉起来、等路由挂全、发真实 HTTP 请求、签玩家 token。
 *
 * 单独抽出来的原因：连库探针有两个（只读面 GET 全量、写入面并发），
 * 它们对"什么时候才算启动完成"的判断必须一致，否则一个能跑一个假绿。
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signRequest, createNonce } = require('../../utils/requestSign');

const BACKSLASH = '\\';
/** app.use 挂载（end:false）的固定尾巴：\/?(?=\/|$) */
const MOUNT_TAIL = `${BACKSLASH}/?(?=${BACKSLASH}/|$)`;

/**
 * 挂载前缀。express 4 只在匹配时才写 layer.path，注册期只有 regexp，
 * 所以从 source 反解：^\/api\/player\/?(?=\/|$) → /api/player
 * 解不出来（正则/通配挂载）就返回 null 跳过，宁可少测也别测错。
 */
function mountOf(layer) {
    if (typeof layer.path === 'string') return layer.path === '/' ? '' : layer.path;
    const src = layer.regexp && layer.regexp.source;
    if (!src || !src.startsWith('^')) return null;
    const body = src.slice(1);
    if (!body.endsWith(MOUNT_TAIL)) return null;
    const prefix = body.slice(0, -MOUNT_TAIL.length).split(BACKSLASH + '/').join('/');
    return prefix === '/' ? '' : prefix;
}

/** 收集 app 上注册的全部路径（含挂载点前缀） */
function collectRoutes(stack, prefix = '', methods = null) {
    const out = [];
    for (const layer of stack || []) {
        if (layer.route) {
            const list = methods
                ? Object.keys(layer.route.methods).filter(m => methods.includes(m))
                : Object.keys(layer.route.methods);
            for (const method of list) out.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
            continue;
        }
        if (!layer.handle || !layer.handle.stack) continue;
        const mount = mountOf(layer);
        if (mount === null) continue;
        out.push(...collectRoutes(layer.handle.stack, `${prefix}${mount}`.replace(/\/+$/, ''), methods));
    }
    return out;
}

/**
 * 拉起真实 app 并等路由挂完。
 * index.js 的启动流程是异步的（配置 → 内容层 → 调度器 → 路由），
 * 所以轮询到能看到足够多的路由为止，而不是拍一个固定 sleep。
 */
async function bootApp(app, { port, minRoutes = 20 } = {}) {
    for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const stack = (app._router || app.router)?.stack || [];
        if (collectRoutes(stack, '', ['get']).length >= minRoutes) return;
    }
    throw new Error('路由没挂全（express 版本或挂载方式变了，需要更新 mountOf）');
}

/** 从 JWT 载荷取 rk（与前端 extractRequestKey 同源数据） */
function extractRkFromToken(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.rk === 'string' && payload.rk ? payload.rk : null;
    } catch (_) {
        return null;
    }
}

function request({ port, method = 'GET', path, token, body, requestKey }) {
    return new Promise((resolve) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        };

        // 写操作按 requestGuard 要求补签名头（GET/auth 自动跳过）
        // rk 优先用显式 requestKey，否则从 token 载荷取（mintToken 已写入）
        const upperMethod = String(method || 'GET').toUpperCase();
        const rk = requestKey || (token ? extractRkFromToken(token) : null);
        const needsSign = rk
            && upperMethod !== 'GET'
            && upperMethod !== 'HEAD'
            && upperMethod !== 'OPTIONS'
            && !String(path || '').startsWith('/api/auth');
        if (needsSign) {
            const timestamp = String(Date.now());
            const nonce = createNonce();
            headers['X-Request-Timestamp'] = timestamp;
            headers['X-Request-Nonce'] = nonce;
            headers['X-Request-Signature'] = signRequest(rk, {
                method: upperMethod,
                url: path,
                timestamp,
                nonce,
                rawBody: payload || ''
            });
        }

        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
            method,
            headers,
            timeout: 20000
        }, (res) => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* 非 JSON 响应保留原文 */ }
                resolve({ status: res.statusCode, body: parsed, raw: text });
            });
        });
        req.on('error', (error) => resolve({ status: 0, body: null, raw: error.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, raw: 'timeout' }); });
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * 本地签一个玩家 token：探针不该依赖注册/验证码流程，也不自增 token_version 去踢掉别的会话。
 * 载荷带 rk，request() 写操作会自动取出用于签名 —— 调用方仍只拿 token 字符串，兼容旧脚本。
 */
function mintToken(player, { expiresIn = '1h' } = {}) {
    const rk = crypto.randomBytes(32).toString('base64url');
    return jwt.sign(
        { id: player.id, username: player.username, v: player.token_version || 0, rk },
        process.env.JWT_SECRET,
        { expiresIn }
    );
}

module.exports = { bootApp, collectRoutes, request, mintToken, extractRkFromToken };
