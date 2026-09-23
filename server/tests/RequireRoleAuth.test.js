/**
 * InterfaceGateway.requireRole 的权限口径（不连库、不起服务）
 *
 * 钉的是一件事：角色必须以数据库（req.player.role）为准。
 *
 * JWT 载荷由 LoginSession.issueLoginToken 签发，只有 { id, username, v }，
 * 根本不含 role。原先 requireRole 读 req.user.role，对所有合法 token 都拿到
 * undefined，于是公告配图上传（POST /api/uploads/announcement-image）等
 * requireRole 接口对真正的管理员也永远 403（前端表现为 Ctrl+V 粘贴截图后
 * 弹「没有权限执行此操作」）。各 adminCheck 一直读的是 req.player.role，
 * 这里对齐同一口径，避免两套鉴权结果分叉。
 */
'use strict';

const interfaceGateway = require('../modules/application/InterfaceGateway');

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
    return res;
}

function runMiddleware(middleware, req) {
    const res = mockRes();
    let advanced = false;
    middleware(req, res, () => {
        advanced = true;
    });
    return { res, advanced };
}

describe('InterfaceGateway.requireRole', () => {
    test('未登录（无 req.user）返回 401', () => {
        const { res, advanced } = runMiddleware(interfaceGateway.requireRole('admin'), {});
        expect(advanced).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    test('JWT 不含 role 时，以数据库 req.player.role 放行管理员', () => {
        // 复现线上 JWT 载荷形状：LoginSession 只签 { id, username, v }
        const req = {
            user: { id: 1, username: 'gm', v: 3 },
            player: { id: 1, username: 'gm', role: 'admin' }
        };
        const { advanced } = runMiddleware(interfaceGateway.requireRole('admin'), req);
        expect(advanced).toBe(true);
    });

    test('JWT 不含 role、数据库也不是 admin 时拒绝（403）', () => {
        const req = {
            user: { id: 2, username: 'player', v: 1 },
            player: { id: 2, username: 'player', role: 'player' }
        };
        const { res, advanced } = runMiddleware(interfaceGateway.requireRole('admin'), req);
        expect(advanced).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('权限不足');
    });

    test('数据库缺 player 时退回 JWT role（兼容只挂 decoded 的调用方）', () => {
        const req = {
            user: { id: 3, username: 'gm', v: 0, role: 'admin' }
        };
        const { advanced } = runMiddleware(interfaceGateway.requireRole('admin'), req);
        expect(advanced).toBe(true);
    });

    test('角色变更后以数据库最新值为准，不采信 JWT 里的旧 role', () => {
        const req = {
            // token 还是升管理前签的
            user: { id: 4, username: 'gm', v: 2, role: 'player' },
            // 数据库已升为 admin
            player: { id: 4, username: 'gm', role: 'admin' }
        };
        const { advanced } = runMiddleware(interfaceGateway.requireRole('admin'), req);
        expect(advanced).toBe(true);
    });
});
