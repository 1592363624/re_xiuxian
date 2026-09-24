/**
 * 客户端请求签名（Web Crypto HMAC-SHA256）
 *
 * 与 server/utils/requestSign.js 算法逐字节对齐：
 *   payload = METHOD \n originalUrl \n timestamp \n nonce \n sha256hex(rawBody)
 *   signature = HMAC-SHA256(rk, payload) 的小写 hex
 *
 * rk 来自登录 JWT 载荷（base64url 解码即可读，无需服务端私钥）。
 * 旧令牌没有 rk 时返回 null，由 api/index.ts 判定并提示重新登录。
 */

/** base64url → UTF-8 字符串 */
function base64UrlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 从 JWT 取出请求密钥 rk
 * @param {string|null|undefined} token
 * @returns {string|null}
 */
export function extractRequestKey(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return typeof payload?.rk === 'string' && payload.rk ? payload.rk : null;
  } catch {
    return null;
  }
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 为一次写请求生成签名头
 * @param {string} rk
 * @param {{ method: string, url: string, rawBody?: string }} req
 * @returns {Promise<{ 'X-Request-Timestamp': string, 'X-Request-Nonce': string, 'X-Request-Signature': string }>}
 */
export async function signRequestHeaders(rk, { method, url, rawBody = '' }) {
  const timestamp = String(Date.now());
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const bodyHash = await sha256Hex(rawBody ?? '');
  const payload = [
    String(method || '').toUpperCase(),
    String(url || ''),
    timestamp,
    nonce,
    bodyHash
  ].join('\n');
  const signature = await hmacSha256Hex(rk, payload);
  return {
    'X-Request-Timestamp': timestamp,
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature
  };
}

/** 写操作才需要签名 */
export function needsRequestSign(method) {
  const m = String(method || 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}
