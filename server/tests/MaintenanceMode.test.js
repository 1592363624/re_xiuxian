/**
 * 维护模式中间件测试
 *
 * 覆盖部署期最关键的行为契约：
 *   - flag 不存在 → 直通
 *   - flag 存在时 /api/health 放行（deploy.ps1 健康检查）
 *   - 其余 /api/* 与 /socket.io 回 503 code=MAINTENANCE
 *   - 页面请求回维护 HTML
 *   - flag 删除后恢复直通（/api/system/maintenance 可 200）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

describe('maintenance middleware', () => {
    let flagPath;
    let server;
    let baseUrl;
    let maintenanceMiddleware;

    function request(pathname) {
        return new Promise((resolve, reject) => {
            const req = http.request(`${baseUrl}${pathname}`, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({
                    status: res.statusCode,
                    body,
                    type: res.headers['content-type'] || '',
                }));
            });
            req.on('error', reject);
            req.end();
        });
    }

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-test-'));
        flagPath = path.join(tmp, 'maintenance.flag');
        process.env.MAINTENANCE_FLAG_PATH = flagPath;
        // 模块可能已被其它用例加载过；用绝对路径再 require 一次拿干净闭包不现实，
        // 这里依赖 getFlagPath() 每次读 env，TTL 缓存最多脏 2 秒，用例之间 sleep 掉。
        ({ maintenanceMiddleware } = require('../middleware/maintenance'));

        const express = require('express');
        const app = express();
        app.use(maintenanceMiddleware);
        app.get('/api/health', (req, res) => res.json({ code: 200, status: 'ok' }));
        app.get('/api/system/maintenance', (req, res) => res.json({ code: 200, data: { maintenance: false } }));
        app.get('/api/player', (req, res) => res.json({ code: 200, secret: true }));

        await new Promise((resolve) => {
            server = app.listen(0, () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    afterAll(async () => {
        if (server) await new Promise((r) => server.close(r));
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
    });

    /** 等待中间件 TTL 缓存过期（2s），保证 flag 开关立刻反映到请求上 */
    async function settleFlagCache() {
        await new Promise((r) => setTimeout(r, 2100));
    }

    test('无 flag 时直通游戏 API', async () => {
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        await settleFlagCache();
        const res = await request('/api/player');
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).secret).toBe(true);
    });

    test('有 flag 时 health 放行、游戏 API 503、页面回维护 HTML', async () => {
        fs.writeFileSync(flagPath, new Date().toISOString());
        await settleFlagCache();

        const health = await request('/api/health');
        expect(health.status).toBe(200);

        const player = await request('/api/player');
        expect(player.status).toBe(503);
        expect(JSON.parse(player.body).code).toBe('MAINTENANCE');

        const socket = await request('/socket.io/?EIO=4&transport=polling');
        expect(socket.status).toBe(503);

        const page = await request('/');
        expect(page.status).toBe(200);
        expect(page.type).toContain('text/html');
        expect(page.body).toContain('系统维护中');
    });

    test('删除 flag 后恢复：探测接口 200，游戏 API 再次直通', async () => {
        fs.unlinkSync(flagPath);
        await settleFlagCache();

        const probe = await request('/api/system/maintenance');
        expect(probe.status).toBe(200);
        expect(JSON.parse(probe.body).data.maintenance).toBe(false);

        const player = await request('/api/player');
        expect(player.status).toBe(200);
    });
});
