/**
 * 写请求防重放 + 签名校验（不连库、不起服务）
 *
 * 钉住四件事：
 *   1) 缺签名头 → 拒
 *   2) 时间戳过期 / nonce 重放 → 拒
 *   3) 改 body 后旧签名 → 拒
 *   4) 合法签名放行；GET/auth 路径免签
 */
'use strict';

const jwt = require('jsonwebtoken');
const {
    signRequest,
    createNonce,
    hashBody
} = require('../utils/requestSign');
const {
    requestGuard,
    resetNoncePool,
    claimNonce
} = require('../middleware/requestGuard');

const JWT_SECRET = 'test-request-guard-secret';
process.env.JWT_SECRET = JWT_SECRET;
// 显式 enforce：覆盖「Jest 默认 off」，本文件要测拦截分支
process.env.REQUEST_GUARD = 'enforce';

function mintToken(rk = 'rk-test-key-0123456789abcdef') {
    return {
        token: jwt.sign({ id: 1, username: 'tester', v: 1, rk }, JWT_SECRET, { expiresIn: '1h' }),
        rk
    };
}

function mockReq({ method = 'POST', path = '/api/gift/stones', body = {}, token, headers = {}, rawBody } = {}) {
    const payload = rawBody !== undefined ? rawBody : (body === null ? '' : JSON.stringify(body));
    const req = {
        method,
        path,
        originalUrl: path,
        rawBody: payload,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers
        },
        header(name) {
            const key = String(name).toLowerCase();
            return this.headers[key];
        }
    };
    return req;
}

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    return res;
}

function run(req) {
    const res = mockRes();
    let advanced = false;
    requestGuard(req, res, () => { advanced = true; });
    return { res, advanced };
}

function signedHeaders(rk, { method, path, rawBody, timestamp, nonce }) {
    const ts = timestamp ?? String(Date.now());
    const n = nonce ?? createNonce();
    const sig = signRequest(rk, { method, url: path, timestamp: ts, nonce: n, rawBody });
    return {
        'x-request-timestamp': ts,
        'x-request-nonce': n,
        'x-request-signature': sig
    };
}

beforeEach(() => {
    resetNoncePool();
    process.env.REQUEST_GUARD = 'enforce';
});

afterAll(() => {
    process.env.REQUEST_GUARD = 'off';
});

describe('requestGuard 拒绝非法写请求', () => {
    test('缺签名头 → 401', () => {
        const { token } = mintToken();
        const { advanced, res } = run(mockReq({ token }));
        expect(advanced).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(res.body.error_code).toBe('REQUEST_SIGN_MISSING');
    });

    test('时间戳过期 → 401', () => {
        const { token, rk } = mintToken();
        const rawBody = JSON.stringify({ amount: 1 });
        const headers = signedHeaders(rk, {
            method: 'POST',
            path: '/api/gift/stones',
            rawBody,
            timestamp: String(Date.now() - 10 * 60 * 1000)
        });
        const { advanced, res } = run(mockReq({ token, rawBody, headers }));
        expect(advanced).toBe(false);
        expect(res.body.error_code).toBe('REQUEST_STALE');
    });

    test('同一 nonce 二次提交 → 401 重放', () => {
        const { token, rk } = mintToken();
        const rawBody = JSON.stringify({ amount: 1 });
        const headers = signedHeaders(rk, { method: 'POST', path: '/api/gift/stones', rawBody });

        const first = run(mockReq({ token, rawBody, headers }));
        expect(first.advanced).toBe(true);

        const replay = run(mockReq({ token, rawBody, headers }));
        expect(replay.advanced).toBe(false);
        expect(replay.res.body.error_code).toBe('REQUEST_REPLAYED');
    });

    test('改 body 后旧签名 → 400', () => {
        const { token, rk } = mintToken();
        const original = JSON.stringify({ amount: 1 });
        const tampered = JSON.stringify({ amount: 999999 });
        const headers = signedHeaders(rk, { method: 'POST', path: '/api/gift/stones', rawBody: original });

        const { advanced, res } = run(mockReq({ token, rawBody: tampered, headers }));
        expect(advanced).toBe(false);
        expect(res.body.error_code).toBe('REQUEST_SIGN_INVALID');
    });

    test('旧令牌无 rk → 401 强制重登', () => {
        const token = jwt.sign({ id: 1, username: 'tester', v: 1 }, JWT_SECRET, { expiresIn: '1h' });
        const headers = signedHeaders('whatever', { method: 'POST', path: '/api/gift/stones', rawBody: '{}' });
        const { advanced, res } = run(mockReq({ token, rawBody: '{}', headers }));
        expect(advanced).toBe(false);
        expect(res.statusCode).toBe(401);
        expect(res.body.error_code).toBe('REQUEST_KEY_MISSING');
    });
});

describe('requestGuard 放行合法请求', () => {
    test('正确签名 + 新 nonce → 放行', () => {
        const { token, rk } = mintToken();
        const rawBody = JSON.stringify({ amount: 1, target_player_id: 2 });
        const headers = signedHeaders(rk, { method: 'POST', path: '/api/gift/stones', rawBody });
        const { advanced, res } = run(mockReq({ token, rawBody, headers }));
        expect(advanced).toBe(true);
        expect(res.body).toBeNull();
    });

    test('GET 与 /api/auth/login 免签', () => {
        const get = run(mockReq({ method: 'GET', path: '/api/player/me' }));
        expect(get.advanced).toBe(true);

        const login = run(mockReq({ method: 'POST', path: '/api/auth/login', body: { username: 'a', password: 'b' } }));
        expect(login.advanced).toBe(true);
    });

    test('挂在 /api 下时 req.path 被剥前缀，登录仍须免签（回归：卡登录页）', () => {
        // 模拟 app.use('/api', requestGuard)：originalUrl 带 /api，path 不带
        const req = {
            method: 'POST',
            path: '/auth/login',
            originalUrl: '/api/auth/login',
            rawBody: JSON.stringify({ username: 'a', password: 'b' }),
            headers: {},
            header(name) { return this.headers[String(name).toLowerCase()]; }
        };
        const { advanced } = run(req);
        expect(advanced).toBe(true);

        const register = {
            method: 'POST',
            path: '/auth/register',
            originalUrl: '/api/auth/register',
            rawBody: '{}',
            headers: {},
            header(name) { return this.headers[String(name).toLowerCase()]; }
        };
        expect(run(register).advanced).toBe(true);
    });

    test('空 body 的 POST 也要签名，且哈希为空串', () => {
        const { token, rk } = mintToken();
        const path = '/api/seclusion/end';
        const headers = signedHeaders(rk, { method: 'POST', path, rawBody: '' });
        expect(hashBody('')).toHaveLength(64);
        const { advanced } = run(mockReq({ token, path, rawBody: '', headers }));
        expect(advanced).toBe(true);
    });
});

describe('nonce 池', () => {
    test('claimNonce 首次 true、二次 false', () => {
        expect(claimNonce('n-abcdefghijklmnop')).toBe(true);
        expect(claimNonce('n-abcdefghijklmnop')).toBe(false);
    });
});

describe('log 模式只观测不拦截', () => {
    test('违规请求仍放行', () => {
        process.env.REQUEST_GUARD = 'log';
        const { token } = mintToken();
        const { advanced } = run(mockReq({ token }));
        expect(advanced).toBe(true);
    });
});
