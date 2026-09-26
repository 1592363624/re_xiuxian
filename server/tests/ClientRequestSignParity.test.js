/**
 * 客户端 requestSign 与 Node crypto / 服务端 signRequest 对拍
 *
 * 背景：crypto.subtle 只在 HTTPS / localhost 可用。官网 http:// 部署下 subtle 为
 * undefined，客户端必须走纯 JS SHA-256 / HMAC-SHA256，且结果要与服务端逐字节一致，
 * 否则所有写请求（卸下装备等）会在签名阶段失败。
 *
 * client/src/utils/requestSign.js 是 ESM，Jest 默认跑在 CJS 下不能直接 import。
 * 这里用子进程 `node --input-type=module` 加载客户端模块，拿回纯函数结果与
 * Node 自带 crypto 对拍，并把客户端签名头交给服务端 signRequest 验签。
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { signRequest, hashBody, buildSignPayload } = require('../utils/requestSign');

const CLIENT_SIGN_PATH = path.join(__dirname, '../../client/src/utils/requestSign.js');

function nodeSha256Hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nodeHmacHex(key, message) {
    return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * 在子进程里加载客户端 ESM 模块并执行一小段脚本，返回 JSON。
 * @param {string} body 不含 import 的函数体，可使用 `client` 与 `payload`
 */
function runWithClientModule(body) {
    const script = `
import * as client from ${JSON.stringify(pathToFileURL(CLIENT_SIGN_PATH).href)};
import { buildSignPayload, hashBody } from ${JSON.stringify(pathToFileURL(path.join(__dirname, '../utils/requestSign.js')).href)};
const payload = { buildSignPayload, hashBody };
${body}
`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..')
    });
    return JSON.parse(out);
}

describe('客户端纯 JS 摘要 / HMAC 与 Node crypto 一致', () => {
    test('sha256HexSync 对拍空串 / ASCII / 中文 / 长文本', () => {
        const samples = [
            '',
            'a',
            'The quick brown fox jumps over the lazy dog',
            'POST\n/api/equipment/unequip\n1710000000000\nabc\n{}',
            '卸下装备：大五行幻世轮',
            'x'.repeat(1000)
        ];
        const { digests } = runWithClientModule(`
const samples = ${JSON.stringify(samples)};
process.stdout.write(JSON.stringify({ digests: samples.map(s => client.sha256HexSync(s)) }));
`);
        samples.forEach((s, i) => {
            expect(digests[i]).toBe(nodeSha256Hex(s));
        });
    });

    test('hmacSha256HexSync 对拍（含短 key / 超过 64 字节的长 key）', () => {
        const cases = [
            ['key', 'The quick brown fox jumps over the lazy dog'],
            ['', ''],
            ['rk-test-key-0123456789abcdef', 'POST\n/api/equipment/unequip\n1\nn\n' + nodeSha256Hex('{"slot":"dharma"}')],
            ['k'.repeat(100), 'long-key']
        ];
        const { macs } = runWithClientModule(`
const cases = ${JSON.stringify(cases)};
process.stdout.write(JSON.stringify({ macs: cases.map(([k, m]) => client.hmacSha256HexSync(k, m)) }));
`);
        cases.forEach(([k, m], i) => {
            expect(macs[i]).toBe(nodeHmacHex(k, m));
        });
    });

    test('RFC 4231 test case 2：key="Jefe" message="what do ya want for nothing?"', () => {
        const { mac } = runWithClientModule(`
process.stdout.write(JSON.stringify({ mac: client.hmacSha256HexSync('Jefe', 'what do ya want for nothing?') }));
`);
        expect(mac).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });

    test('拔掉 crypto.subtle 后 signRequestHeaders 仍可签名，且服务端能验过', () => {
        const rk = 'rk-test-key-0123456789abcdef';
        const method = 'POST';
        const url = '/api/equipment/unequip';
        const rawBody = JSON.stringify({ slot: 'dharma' });

        const { headers } = runWithClientModule(`
if (globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true, writable: true });
}
const headers = await client.signRequestHeaders(${JSON.stringify(rk)}, {
  method: ${JSON.stringify(method)},
  url: ${JSON.stringify(url)},
  rawBody: ${JSON.stringify(rawBody)}
});
process.stdout.write(JSON.stringify({ headers }));
`);

        expect(headers['X-Request-Timestamp']).toBeTruthy();
        expect(headers['X-Request-Nonce']).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(headers['X-Request-Signature']).toMatch(/^[0-9a-f]{64}$/);

        // 服务端用同一算法重算：payload 必须与客户端一致，HMAC 必须相同
        const expected = signRequest(rk, {
            method,
            url,
            timestamp: headers['X-Request-Timestamp'],
            nonce: headers['X-Request-Nonce'],
            rawBody
        });
        expect(headers['X-Request-Signature']).toBe(expected);

        // 反向：改 body 后签名必不等（防改包）
        const tampered = signRequest(rk, {
            method,
            url,
            timestamp: headers['X-Request-Timestamp'],
            nonce: headers['X-Request-Nonce'],
            rawBody: JSON.stringify({ slot: 'weapon' })
        });
        expect(tampered).not.toBe(headers['X-Request-Signature']);
    });

    test('纯 JS HMAC 与 Node HMAC 对同一 payload 一致，且 body 哈希同服务端 hashBody', () => {
        const rk = 'rk-parity';
        const rawBody = '{"slot":"dharma"}';
        const built = buildSignPayload({
            method: 'POST',
            url: '/api/equipment/unequip',
            timestamp: '1',
            nonce: 'n',
            rawBody
        });
        const { mac, bodyHash } = runWithClientModule(`
process.stdout.write(JSON.stringify({
  mac: client.hmacSha256HexSync(${JSON.stringify(rk)}, ${JSON.stringify(built)}),
  bodyHash: client.sha256HexSync(${JSON.stringify(rawBody)})
}));
`);
        expect(mac).toBe(nodeHmacHex(rk, built));
        expect(bodyHash).toBe(hashBody(rawBody));
        expect(bodyHash).toBe(nodeSha256Hex(rawBody));
    });

    test('extractRequestKey：无 rk / 坏 token 返回 null，有 rk 则取出', () => {
        const payloadNoRk = Buffer.from(JSON.stringify({ id: 1, username: 'a', v: 1 })).toString('base64url');
        const payloadWithRk = Buffer.from(JSON.stringify({ id: 1, username: 'a', v: 1, rk: 'hello-rk' })).toString('base64url');
        const fake = (p) => `eyJhbGciOiJIUzI1NiJ9.${p}.sig`;
        const tokenNoRk = fake(payloadNoRk);
        const tokenWithRk = fake(payloadWithRk);

        const result = runWithClientModule(`
process.stdout.write(JSON.stringify({
  noRk: client.extractRequestKey(${JSON.stringify(tokenNoRk)}),
  withRk: client.extractRequestKey(${JSON.stringify(tokenWithRk)}),
  bad: client.extractRequestKey('not-a-jwt'),
  empty: client.extractRequestKey(null)
}));
`);
        expect(result.noRk).toBeNull();
        expect(result.withRk).toBe('hello-rk');
        expect(result.bad).toBeNull();
        expect(result.empty).toBeNull();
    });
});
