/**
 * 后台日志文件查看路由（GM 后台「后台日志」页）
 *
 * 背景：后端进程的 console.log / console.error 分别落在两处 —— 生产环境由 PM2 收进
 * server/logs/out.log 与 server/logs/error.log，本机开发由 scripts/run-server.bat 用 tee.js
 * 抓进 logs/startup_backend.log。原先排障必须 SSH 上机 tail -f，手机/平板上根本看不了。
 * 这里把"读日志文件"这一件事收进后台：
 *   GET  /api/admin/system-logs/sources    列出配置里登记的日志源（可读性、体积、最后修改时间）+ 前端选项
 *   GET  /api/admin/system-logs/tail       尾部抓取（快照）或从 offset 增量拉取（实时跟随）
 *   POST /api/admin/system-logs/alert/test 往飞书发一条测试告警，用于确认 webhook 配通了
 *
 * 设计要点：
 *   1. 只读文件，绝不修改/删除/清空日志 —— 排障工具不能成为新的故障源。
 *   2. 可读范围受白名单 + 后缀白名单双重限制，具体见 utils/systemLog.js（与告警服务共用同一套校验）。
 *   3. 单次读取字节数、返回行数、单行长度都有上限（见配置 limits）：日志涨到几百 MB 时，
 *      不能把 Node 进程内存和前端渲染一起拖垮。
 *   4. 返回的 offset 永远停在某个 '\n' 之后：前端按 offset 增量轮询时既不会丢半个字符，
 *      也不会把同一行读两遍。
 *   5. 行的级别判定与彩色分词规则全部由配置下发（levels / highlight）：
 *      页面与飞书告警必须对"哪一行是 error"给出同一答案，判定逻辑只存在于 utils/systemLog.js 一份。
 */
const express = require('express');
const fs = require('fs');
const router = express.Router();
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const systemLog = require('../utils/systemLog');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 管理员权限中间件（与其它 admin_*.js 保持同一口径）
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, error_code: ErrorCodes.UNAUTHORIZED, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection.remoteAddress
        });
    } catch (error) {
        console.error('记录管理员日志失败:', error);
    }
}

/**
 * 日志源列表 + 前端渲染所需的选项（行数、轮询间隔、级别、彩色分词规则、告警状态）
 * GET /api/admin/system-logs/sources
 */
router.get('/sources', auth, adminCheck, (req, res, next) => {
    try {
        const config = systemLog.getConfig();
        if (!config.enabled) {
            throw new AppError('后台日志查看功能已在配置中关闭（system_log_viewer.enabled）', 403, ErrorCodes.FEATURE_DISABLED);
        }

        res.json({
            code: 200,
            data: {
                sources: config.sources.map((entry) => systemLog.describeSource(entry, config)),
                tail_default_lines: config.limits.tail_default_lines,
                tail_max_lines: config.limits.tail_max_lines,
                line_options: config.limits.line_options,
                max_keyword_length: config.limits.max_keyword_length,
                refresh_default_interval_ms: config.live.default_interval_ms,
                refresh_interval_options_ms: config.live.interval_options_ms,
                max_buffer_lines: config.live.max_buffer_lines,
                // 级别的显示名也由配置下发：中文文案只维护在 system_log_viewer.json 一处
                levels: ['all', ...config.levels.order].map((value) => ({
                    value,
                    label: config.levels.labels?.[value] || value
                })),
                // 彩色输出规则：服务端只给"什么字符算哪一类"，具体配色留给前端主题
                highlight_rules: config.highlight.rules,
                alert: systemLog.describeAlert(config)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 抓取日志尾部内容
 * GET /api/admin/system-logs/tail
 *
 * query:
 *   source  日志源 id（必填，取值见 /sources）
 *   lines   返回行数（默认取配置 tail_default_lines，上限 tail_max_lines）
 *   level   all | error | warn | debug | info（默认 all）
 *   keyword 关键词（不区分大小写，长度上限 max_keyword_length）
 *   offset  字节偏移；传了就按"增量跟随"处理 —— 只返回该偏移之后的新增内容
 */
router.get('/tail', auth, adminCheck, (req, res, next) => {
    try {
        const config = systemLog.getConfig();
        if (!config.enabled) {
            throw new AppError('后台日志查看功能已在配置中关闭（system_log_viewer.enabled）', 403, ErrorCodes.FEATURE_DISABLED);
        }

        const { limits } = config;
        const entry = systemLog.findSource(config, String(req.query.source || ''));
        const abs = systemLog.resolveSourcePath(entry, config);

        // 行数：先夹到 [1, tail_max_lines]，避免前端传个 1000000 把内存打满
        const requestedLines = parseInt(req.query.lines, 10);
        const limit = Number.isFinite(requestedLines) && requestedLines > 0
            ? Math.min(requestedLines, limits.tail_max_lines)
            : limits.tail_default_lines;

        // 关键词：截断到上限，统一转小写做不区分大小写匹配
        const keyword = String(req.query.keyword || '').slice(0, limits.max_keyword_length).trim().toLowerCase();
        const level = String(req.query.level || 'all');

        let stat;
        try {
            stat = fs.statSync(abs);
        } catch (e) {
            throw new AppError(`日志文件当前不可读（${entry.file}）：${e.code || e.message}`, 404, ErrorCodes.NOT_FOUND);
        }
        if (!stat.isFile()) {
            throw new AppError(`日志源不是文件：${entry.file}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const size = stat.size;
        const matchers = systemLog.getLevelMatchers(config);
        const maxBytes = limits.max_read_bytes;

        // offset 存在即代表前端在"实时跟随"模式下轮询
        const rawOffset = parseInt(req.query.offset, 10);
        const isIncremental = Number.isFinite(rawOffset) && rawOffset >= 0;

        const chunk = isIncremental
            ? systemLog.readIncrement(abs, size, rawOffset, maxBytes)
            : systemLog.readTailSnapshot(abs, size, maxBytes);

        const rawLines = systemLog.splitLines(chunk.text);
        const filtered = systemLog.filterLines(rawLines, {
            level,
            keyword,
            limit,
            matchers,
            maxLineLength: limits.max_line_length
        });

        res.json({
            code: 200,
            data: {
                source: entry.id,
                file: entry.file,
                size,
                offset: chunk.offset,
                rotated: !!chunk.rotated,
                scanned: rawLines.length,
                matched: filtered.matched,
                returned: filtered.lines.length,
                truncated: filtered.matched > filtered.lines.length,
                modified_at: stat.mtime.toISOString(),
                // 临时行：最后一行还没写完整（未见换行），前端以暗淡样式渲染并在下次轮询时被替换
                pending: systemLog.truncateLine(chunk.pending, limits.max_line_length),
                lines: filtered.lines
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 发一条测试告警到飞书，确认 webhook 与告警配置真的通
 * POST /api/admin/system-logs/alert/test
 *
 * 为什么需要它：告警是"平时不出声"的功能，等到真出事才发现 webhook 写错了就太晚了。
 * 这里让 GM 在后台点一下就能收到一条测试消息。
 */
router.post('/alert/test', auth, adminCheck, async (req, res, next) => {
    try {
        const config = systemLog.getConfig();
        // 懒加载：告警服务会读 fs/axios，本模块加载期不碰它，避免拖慢路由挂载
        const LogAlertService = require('../game/services/LogAlertService');
        const result = await LogAlertService.sendTestAlert(config);

        await logAdminAction(req.player.id, 'test_log_alert', {
            target: 'system_log_viewer.alert',
            webhook_configured: result.webhook_configured
        }, req);

        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
