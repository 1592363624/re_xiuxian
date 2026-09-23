/**
 * OpenAPI 文档增量更新脚本 - 后台日志查看器（GM 后台「后台日志」页）
 *
 * 功能：
 *   1. 新增「管理员-后台日志」标签
 *   2. 新增 3 个 GM 后台接口：
 *      - GET  /api/admin/system-logs/sources     日志源列表 / 前端选项 / 彩色分词规则 / 告警状态
 *      - GET  /api/admin/system-logs/tail        尾部抓取 / offset 增量跟随
 *      - POST /api/admin/system-logs/alert/test  发送飞书测试告警
 *
 * 执行：node scripts/update_openapi_system_logs.js
 * 幂等：重复执行不会重复添加路径，仅覆盖
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.resolve(__dirname, '..', 'docs', 'openapi.json');

if (!fs.existsSync(openapiPath)) {
    console.error(`[错误] OpenAPI 文档不存在: ${openapiPath}`);
    process.exit(1);
}

// 读取现有文档
const doc = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
console.log(`[信息] 已加载 OpenAPI 文档，当前路径数: ${Object.keys(doc.paths || {}).length}`);

// 1. 添加标签
if (!Array.isArray(doc.tags)) doc.tags = [];
const existingTagNames = new Set(doc.tags.map(t => t.name));

if (!existingTagNames.has('管理员-后台日志')) {
    doc.tags.push({
        name: '管理员-后台日志',
        description: 'GM 后台服务器日志查看与告警 - 只读读取 PM2 / tee 落盘的 .log 文件，支持尾部快照、级别/关键词过滤、offset 增量跟随，以及错误行飞书告警'
    });
    console.log('[信息] 已添加 管理员-后台日志 标签');
}

// 安全方案引用
const securityBearer = [{ bearerAuth: [] }];

// 2. 定义新接口
const newPaths = {
    '/api/admin/system-logs/sources': {
        get: {
            tags: ['管理员-后台日志'],
            summary: '获取日志源列表、查看器选项与告警状态',
            description: '返回 config/system_log_viewer.json 中登记的日志源（是否可读、体积、最后修改时间、是否配置有误）以及前端渲染所需的全部选项：默认/最大行数、行数选项、级别枚举（含中文名）、轮询间隔选项、缓冲区上限、彩色输出分词规则（highlight_rules）、错误日志飞书告警状态（alert）。前端据此渲染筛选栏与告警条，不硬编码任何阈值或文案。可读范围受白名单与 allowed_extensions（默认仅 .log）双重限制。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '日志源、选项与告警状态',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    sources: [
                                        {
                                            id: 'startup_backend',
                                            name: '后端启动日志',
                                            file: 'logs/startup_backend.log',
                                            description: 'scripts/run-server.bat 用 tee.js 抓下来的后端控制台全文（本机开发默认看这个）',
                                            exists: true,
                                            size: 99514,
                                            modified_at: '2026-09-23T10:00:00.000Z',
                                            error: null,
                                            misconfigured: false
                                        },
                                        {
                                            id: 'pm2_out',
                                            name: 'PM2 标准输出',
                                            file: 'server/logs/out.log',
                                            description: '生产环境 PM2 采集的 console.log 输出（ecosystem.config.js 的 out_file）',
                                            exists: false,
                                            size: 0,
                                            modified_at: null,
                                            error: '当前不可读：ENOENT',
                                            misconfigured: false
                                        }
                                    ],
                                    tail_default_lines: 200,
                                    tail_max_lines: 2000,
                                    line_options: [100, 200, 500, 1000, 2000],
                                    max_keyword_length: 100,
                                    refresh_default_interval_ms: 5000,
                                    refresh_interval_options_ms: [2000, 5000, 10000, 30000],
                                    max_buffer_lines: 5000,
                                    levels: [
                                        { value: 'all', label: '全部' },
                                        { value: 'error', label: '错误' },
                                        { value: 'warn', label: '警告' },
                                        { value: 'debug', label: '调试' },
                                        { value: 'info', label: '信息' }
                                    ],
                                    highlight_rules: [
                                        { kind: 'prefix', pattern: '^\\d+\\|[^|]*\\|\\s*' },
                                        { kind: 'time', pattern: '\\d{4}[-/]\\d{2}[-/]\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}' },
                                        { kind: 'error', flags: 'gi', pattern: '\\[ERROR\\]|[A-Za-z]*(?:Error|Exception)\\b|失败' },
                                        { kind: 'success', flags: 'gi', pattern: '\\bready\\b|成功|完成' },
                                        { kind: 'url', pattern: 'https?://[^\\s"\']+' },
                                        { kind: 'number', pattern: '\\b\\d+(?:\\.\\d+)?\\b' }
                                    ],
                                    alert: {
                                        enabled: true,
                                        levels: ['error'],
                                        sources: ['startup_backend', 'pm2_out', 'pm2_error'],
                                        webhook_configured: true,
                                        webhook_env: 'FEISHU_LOG_ALERT_WEBHOOK',
                                        poll_interval_ms: 15000,
                                        min_interval_ms: 60000,
                                        dedupe_window_ms: 300000,
                                        max_lines_per_alert: 5,
                                        max_alerts_per_hour: 20
                                    }
                                }
                            }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': {
                    description: '权限不足（需要管理员权限）/ 功能已在配置中关闭',
                    content: {
                        'application/json': {
                            example: { code: 403, error_code: 'FEATURE_DISABLED', message: '后台日志查看功能已在配置中关闭（system_log_viewer.enabled）' }
                        }
                    }
                }
            }
        }
    },

    '/api/admin/system-logs/tail': {
        get: {
            tags: ['管理员-后台日志'],
            summary: '抓取日志尾部内容（快照 / 增量跟随）',
            description: '只读读取指定日志源的尾部内容（绝不修改/清空日志文件）。不传 offset 时为快照模式：回扫文件末尾若干字节（上限 max_read_bytes），按级别/关键词过滤后返回最近 lines 行。传 offset 时为增量模式：只返回该偏移之后的新增内容，用于实时跟随。返回的 offset 永远停在某个换行之后，可直接作为下次轮询入参；pending 是尚未以换行结尾的临时行（可能正在写入），下次轮询会被完整行替换；rotated 表示文件被清空/轮转，已自动从头跟随。source 只接受 /sources 列出的 id，不接受任意路径；文件必须位于项目目录内且后缀为 .log。',
            security: securityBearer,
            parameters: [
                {
                    name: 'source',
                    in: 'query',
                    required: true,
                    schema: { type: 'string' },
                    description: '日志源 id（取值见 /sources 接口）'
                },
                {
                    name: 'lines',
                    in: 'query',
                    schema: { type: 'integer', default: 200, minimum: 1 },
                    description: '返回行数上限（默认取配置 tail_default_lines，超过 tail_max_lines 会被夹到上限）'
                },
                {
                    name: 'level',
                    in: 'query',
                    schema: { type: 'string', enum: ['all', 'error', 'warn', 'info', 'debug'], default: 'all' },
                    description: '按行级别过滤，判定规则来自配置 system_log_viewer.levels'
                },
                {
                    name: 'keyword',
                    in: 'query',
                    schema: { type: 'string', maxLength: 100 },
                    description: '关键词过滤（不区分大小写，长度上限 max_keyword_length）'
                },
                {
                    name: 'offset',
                    in: 'query',
                    schema: { type: 'integer', minimum: 0 },
                    description: '字节偏移（上次响应返回的 offset）。传了即按增量模式，只返回新增内容'
                }
            ],
            responses: {
                '200': {
                    description: '日志内容',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    source: 'startup_backend',
                                    file: 'logs/startup_backend.log',
                                    size: 99514,
                                    offset: 99514,
                                    rotated: false,
                                    scanned: 200,
                                    matched: 12,
                                    returned: 12,
                                    truncated: false,
                                    modified_at: '2026-09-23T10:00:00.000Z',
                                    pending: '',
                                    lines: [
                                        { level: 'info', text: '[SectWarService] 状态转移日志检查完成，检查 12 个玩家，修复 0 个异常' },
                                        { level: 'error', text: '[CultivationService] 结算失败: Error: 玩家状态已变更' }
                                    ]
                                }
                            }
                        }
                    }
                },
                '400': {
                    description: '参数错误（未知日志源 / 路径越界 / 后缀不在白名单 / 目标不是文件）',
                    content: {
                        'application/json': {
                            example: { code: 400, error_code: 'VALIDATION_ERROR', message: '未知的日志源: foo' }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '404': {
                    description: '日志文件当前不可读（不存在或无权限）',
                    content: {
                        'application/json': {
                            example: { code: 404, error_code: 'NOT_FOUND', message: '日志文件当前不可读（server/logs/error.log）：ENOENT' }
                        }
                    }
                }
            }
        }
    },

    '/api/admin/system-logs/alert/test': {
        post: {
            tags: ['管理员-后台日志'],
            summary: '发送飞书测试告警',
            description: '往 config/system_log_viewer.json 的 alert 段所配的飞书机器人 webhook 发一条测试卡片，用于确认告警通道真的通（告警平时不出声，等出事才发现 webhook 写错就晚了）。webhook 地址优先取环境变量（alert.webhook_env，默认 FEISHU_LOG_ALERT_WEBHOOK，建议放 server/.env），配置里的 alert.webhook_url 仅作本地调试兜底。发送成功会记一条管理员操作日志 test_log_alert。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '测试告警已发送',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '测试告警已发送到飞书，请查看群消息',
                                data: { sent: true, webhook_configured: true, message: '测试告警已发送到飞书，请查看群消息' }
                            }
                        }
                    }
                },
                '400': {
                    description: '未配置 webhook',
                    content: {
                        'application/json': {
                            example: {
                                code: 400,
                                error_code: 'CONFIG_ERROR',
                                message: '未配置飞书 webhook：请设置环境变量 FEISHU_LOG_ALERT_WEBHOOK（推荐，见 server/.env）或配置 system_log_viewer.alert.webhook_url'
                            }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '502': {
                    description: '飞书接口拒绝了这条消息（webhook 失效 / 机器人被移除 / 触发频率限制）',
                    content: {
                        'application/json': {
                            example: { code: 502, error_code: 'SERVICE_UNAVAILABLE', message: '飞书告警发送失败：sign match fail or timestamp is not within one hour from current time' }
                        }
                    }
                }
            }
        }
    }
};

// 3. 合并新接口到 paths
if (!doc.paths) doc.paths = {};
let addedCount = 0;
let updatedCount = 0;
for (const [pathKey, pathDef] of Object.entries(newPaths)) {
    if (doc.paths[pathKey]) {
        updatedCount++;
    } else {
        addedCount++;
    }
    doc.paths[pathKey] = pathDef;
}

console.log(`[信息] 已添加 ${addedCount} 个新路径，更新 ${updatedCount} 个已有路径`);

// 4. 写回文件
const output = JSON.stringify(doc, null, 2);
fs.writeFileSync(openapiPath, output, 'utf8');

console.log(`[完成] OpenAPI 文档已更新，当前路径总数: ${Object.keys(doc.paths).length}`);
console.log(`[完成] 标签总数: ${doc.tags.length}`);
