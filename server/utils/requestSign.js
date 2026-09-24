/**
 * 请求签名与防重放工具（客户端与冒烟脚本共用同一算法）。
 *
 * 目的：
 *   1. 防盲重放 —— 时间戳窗口 + 一次性 nonce，抓到的包过期或二次提交直接拒；
 *   2. 防改包   —— HMAC 覆盖 method/path/body，改一个字节签名就对不上；
 *   3. 不依赖额外共享密钥 —— 签名密钥 rk 写在 JWT 载荷里，登录时签发，
 *      持有合法令牌才能签名；服务端用 JWT_SECRET 校验令牌后再取出 rk 验签。
 *
 * 签名串（\n 连接，字段顺序固定，不得改动）：
 *   METHOD \n originalUrl \n timestamp \n nonce \n sha256hex(rawBody)
 * 签名：HMAC-SHA256(rk, 签名串) 的小写 hex。
 */
'use strict';

const crypto = require('crypto');

/** 时间戳允许的前后偏差（毫秒）。再宽会给重放留窗，再窄会误伤弱网重试。 */
const TIMESTAMP_TOLERANCE_MS = 90_000;

/** nonce 最短/最长长度（base64url / hex 都落在这个区间） */
const NONCE_MIN_LEN = 16;
const NONCE_MAX_LEN = 64;

/** body 哈希：空 body 用空串的 sha256，保证字段始终存在 */
function hashBody(rawBody) {
    const text = rawBody == null ? '' : String(rawBody);
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 拼签名串。客户端与服务端必须逐字节一致（含路径上的 query）。
 * @param {Object} parts
 * @param {string} parts.method      HTTP 方法大写
 * @param {string} parts.url         originalUrl（含 query）
 * @param {string|number} parts.timestamp 毫秒时间戳
 * @param {string} parts.nonce
 * @param {string} [parts.rawBody]
 */
function buildSignPayload({ method, url, timestamp, nonce, rawBody }) {
    return [
        String(method || '').toUpperCase(),
        String(url || ''),
        String(timestamp || ''),
        String(nonce || ''),
        hashBody(rawBody)
    ].join('\n');
}

/**
 * 用 rk 计算签名（小写 hex）。
 * @param {string} rk 登录 JWT 载荷里的请求密钥
 * @param {Object} parts 同 buildSignPayload
 */
function signRequest(rk, parts) {
    if (!rk || typeof rk !== 'string') {
        throw new Error('缺少请求签名密钥 rk');
    }
    const payload = buildSignPayload(parts);
    return crypto.createHmac('sha256', rk).update(payload, 'utf8').digest('hex');
}

/** 定长比较，避免签名比对时序侧信道 */
function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** 时间戳是否落在容忍窗口内 */
function isTimestampFresh(timestamp, now = Date.now()) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    // 允许秒或毫秒：小于 1e12 视为秒
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return Math.abs(now - ms) <= TIMESTAMP_TOLERANCE_MS;
}

/** nonce 形态是否合法 */
function isWellFormedNonce(nonce) {
    return typeof nonce === 'string'
        && nonce.length >= NONCE_MIN_LEN
        && nonce.length <= NONCE_MAX_LEN
        && /^[A-Za-z0-9_-]+$/.test(nonce);
}

/** 生成一次性 nonce（客户端/脚本用） */
function createNonce() {
    return crypto.randomBytes(18).toString('base64url'); // 24 字符
}

module.exports = {
    TIMESTAMP_TOLERANCE_MS,
    hashBody,
    buildSignPayload,
    signRequest,
    safeEqualHex,
    isTimestampFresh,
    isWellFormedNonce,
    createNonce
};
