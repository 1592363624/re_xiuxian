/**
 * 客户端请求签名（HMAC-SHA256）
 *
 * 与 server/utils/requestSign.js 算法逐字节对齐：
 *   payload = METHOD \n originalUrl \n timestamp \n nonce \n sha256hex(rawBody)
 *   signature = HMAC-SHA256(rk, payload) 的小写 hex
 *
 * rk 来自登录 JWT 载荷（base64url 解码即可读，无需服务端私钥）。
 * 旧令牌没有 rk 时返回 null，由 api/index.ts 判定并提示重新登录。
 *
 * Web Crypto（crypto.subtle）只在安全上下文（HTTPS / localhost）可用。
 * 官网是 http:// 时 subtle 为 undefined，写请求会在这里抛 TypeError，
 * 最后被 API 层吞成「请求配置错误」。因此 subtle 不可用时走纯 JS 实现，
 * 算法与 Node crypto / subtle 同一套 SHA-256 与 HMAC-SHA256。
 */

/** base64url → UTF-8 字符串 */
function base64UrlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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

// —— 纯 JS SHA-256 / HMAC-SHA256（FIPS 180-4 / RFC 2104）——
// 只在 crypto.subtle 不可用时使用；导出以便用 Node crypto 对拍。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** @param {Uint8Array} message @returns {Uint8Array} 32-byte digest */
export function sha256Bytes(message) {
  const len = message.length;
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len << 3) >>> 0;
  const withOne = len + 1;
  const padLen = (withOne % 64 <= 56) ? (56 - (withOne % 64)) : (120 - (withOne % 64));
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(message);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLenHi);
  dv.setUint32(total - 4, bitLenLo);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3);
  odv.setUint32(16, h4); odv.setUint32(20, h5); odv.setUint32(24, h6); odv.setUint32(28, h7);
  return out;
}

/** @param {Uint8Array} key @param {Uint8Array} message @returns {Uint8Array} */
export function hmacSha256Bytes(key, message) {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256Bytes(k);
  const padKey = new Uint8Array(blockSize);
  padKey.set(k);
  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padKey[i] ^ 0x36;
    outer[i] = padKey[i] ^ 0x5c;
  }
  inner.set(message, blockSize);
  outer.set(sha256Bytes(inner), blockSize);
  return sha256Bytes(outer);
}

/** 纯 JS：文本 → sha256 小写 hex */
export function sha256HexSync(text) {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(text)));
}

/** 纯 JS：HMAC-SHA256 小写 hex */
export function hmacSha256HexSync(key, message) {
  return bytesToHex(hmacSha256Bytes(
    new TextEncoder().encode(key),
    new TextEncoder().encode(message)
  ));
}

function subtleAvailable() {
  return typeof globalThis.crypto?.subtle?.digest === 'function';
}

async function sha256Hex(text) {
  if (!subtleAvailable()) return sha256HexSync(text);
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(key, message) {
  if (!subtleAvailable()) return hmacSha256HexSync(key, message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * 为一次写请求生成签名头
 * @param {string} rk
 * @param {{ method: string, url: string, rawBody?: string }} req
 * @returns {Promise<{ 'X-Request-Timestamp': string, 'X-Request-Nonce': string, 'X-Request-Signature': string }>}
 */
export async function signRequestHeaders(rk, { method, url, rawBody = '' }) {
  if (!rk || typeof rk !== 'string') {
    throw new Error('缺少请求签名密钥 rk');
  }
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
