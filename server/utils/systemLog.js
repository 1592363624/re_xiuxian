/**
 * 后台日志读取工具（GM 后台「后台日志」页 + 错误日志告警共用）
 *
 * 为什么单独抽一层：日志文件有两个消费方 —— 后台查看接口（routes/admin_system_logs.js）与
 * 错误告警服务（game/services/LogAlertService.js）。两边都必须对"哪一行算 error"给出**同一答案**，
 * 否则会出现"页面看着是错误、告警却不发"这种最费解的组合。级别判定、路径校验、
 * 按字节增量读文件这些共用逻辑因此收在这里，只有一份。
 *
 * 安全边界（两个消费方一致）：
 *   1. 文件只按 config/system_log_viewer.json 的 sources 白名单里的 id 取，不接受任何路径参数；
 *   2. 解析出的绝对路径必须落在项目根目录内，且后缀在 allowed_extensions（默认仅 .log）里。
 *
 * 配置缺失时全部字段有兜底：ConfigLoader 是异步初始化的，而"看日志/报错告警"恰恰是
 * 启动期最需要能用的功能，不能因为配置没就绪就 500 或静默不告警。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { infrastructure } = require('../modules');

const CONFIG_NAME = 'system_log_viewer';
/** 日志文件根目录固定为项目根（本机日志在 logs/，PM2 日志在 server/logs/） */
const LOG_ROOT = path.resolve(__dirname, '..', '..');

/** 配置缺失/未加载时的兜底配置（形状与 config/system_log_viewer.json 完全一致） */
const DEFAULT_CONFIG = {
    enabled: true,
    allowed_extensions: ['.log'],
    sources: [
        { id: 'startup_backend', name: '后端启动日志', file: 'logs/startup_backend.log', description: 'run-server.bat 抓下来的后端控制台全文' }
    ],
    limits: {
        tail_default_lines: 200,
        tail_max_lines: 2000,
        line_options: [100, 200, 500, 1000, 2000],
        max_read_bytes: 2 * 1024 * 1024,
        max_line_length: 2000,
        max_keyword_length: 100
    },
    live: {
        default_interval_ms: 5000,
        interval_options_ms: [2000, 5000, 10000, 30000],
        max_buffer_lines: 5000
    },
    levels: {
        order: ['error', 'warn', 'debug', 'info'],
        labels: { all: '全部', error: '错误', warn: '警告', info: '信息', debug: '调试' },
        patterns: { error: [], warn: [], debug: [], info: [] }
    },
    highlight: { rules: [] },
    alert: {
        enabled: false,
        levels: ['error'],
        sources: [],
        webhook_env: 'FEISHU_LOG_ALERT_WEBHOOK',
        webhook_url: '',
        poll_interval_ms: 15000,
        startup_lookback_bytes: 32768,
        max_read_bytes_per_poll: 1048576,
        batch_window_ms: 8000,
        min_interval_ms: 60000,
        dedupe_window_ms: 300000,
        max_lines_per_alert: 5,
        max_line_length: 500,
        max_alerts_per_hour: 20,
        ignore_patterns: []
    }
};

/**
 * 读取生效配置（逐段兜底）
 * @returns {Object}
 */
function getConfig() {
    let loaded = null;
    try {
        loaded = infrastructure.ConfigLoader?.peekConfig(CONFIG_NAME);
    } catch (e) {
        console.warn('[后台日志] 配置读取失败，使用兜底配置:', e.message);
    }
    if (!loaded || typeof loaded !== 'object') return DEFAULT_CONFIG;

    return {
        enabled: loaded.enabled !== false,
        // 配置里写成空数组时回退默认值，避免出现"没有任何文件可读/可告警"的假象
        allowed_extensions: Array.isArray(loaded.allowed_extensions) && loaded.allowed_extensions.length > 0
            ? loaded.allowed_extensions
            : DEFAULT_CONFIG.allowed_extensions,
        sources: Array.isArray(loaded.sources) && loaded.sources.length > 0 ? loaded.sources : DEFAULT_CONFIG.sources,
        limits: { ...DEFAULT_CONFIG.limits, ...(loaded.limits || {}) },
        live: { ...DEFAULT_CONFIG.live, ...(loaded.live || {}) },
        // levels 整段以配置为准（patterns 是安全相关的判定规则，不做半截合并）
        levels: {
            order: Array.isArray(loaded.levels?.order) ? loaded.levels.order : DEFAULT_CONFIG.levels.order,
            labels: loaded.levels?.labels && typeof loaded.levels.labels === 'object'
                ? loaded.levels.labels
                : DEFAULT_CONFIG.levels.labels,
            patterns: loaded.levels?.patterns && typeof loaded.levels.patterns === 'object'
                ? loaded.levels.patterns
                : DEFAULT_CONFIG.levels.patterns
        },
        // 彩色输出的分词规则：整段以配置为准（顺序即优先级），前端只负责把 kind 映射成颜色
        highlight: {
            rules: Array.isArray(loaded.highlight?.rules) ? loaded.highlight.rules : DEFAULT_CONFIG.highlight.rules
        },
        alert: { ...DEFAULT_CONFIG.alert, ...(loaded.alert || {}) }
    };
}

/**
 * 按 id 找到日志源，找不到即报错（而不是静默回退到某个文件）
 * @param {Object} config
 * @param {string} sourceId
 * @returns {Object} 日志源条目
 */
function findSource(config, sourceId) {
    const entry = config.sources.find((s) => s && s.id === sourceId);
    if (!entry) {
        const error = new Error(`未知的日志源: ${sourceId || '(空)'}`);
        error.statusCode = 400;
        error.errorCode = 'VALIDATION_ERROR';
        error.isOperational = true;
        throw error;
    }
    return entry;
}

/**
 * 把配置里的日志源解析成受信任的绝对路径
 * 两道校验缺一不可：路径不越出项目根 + 后缀在白名单内
 * @param {Object} entry - 配置中的日志源条目
 * @param {Object} config - 生效配置（取 allowed_extensions）
 * @returns {string} 绝对路径
 */
function resolveSourcePath(entry, config) {
    const raw = String(entry.file || '');
    const abs = path.resolve(LOG_ROOT, raw);
    if (!abs.startsWith(LOG_ROOT + path.sep)) {
        const error = new Error(`日志源路径越界：只允许读取项目目录内的文件（${raw}）`);
        error.statusCode = 400;
        error.errorCode = 'VALIDATION_ERROR';
        error.isOperational = true;
        throw error;
    }

    const extensions = config.allowed_extensions || DEFAULT_CONFIG.allowed_extensions;
    const ext = path.extname(abs).toLowerCase();
    if (!extensions.some((item) => String(item).toLowerCase() === ext)) {
        const error = new Error(`日志源后缀不在白名单内（${raw}）：只允许 ${extensions.join(' / ')}`);
        error.statusCode = 400;
        error.errorCode = 'VALIDATION_ERROR';
        error.isOperational = true;
        throw error;
    }

    return abs;
}

/**
 * 列出一个日志源的当前状态
 * 文件不存在不算错误：PM2 还没写过 error.log 是很正常的状态
 * @param {Object} entry
 * @param {Object} config
 * @returns {{id:string,name:string,file:string,description:string,exists:boolean,size:number,modified_at:string|null,error:string|null,misconfigured:boolean}}
 */
function describeSource(entry, config) {
    const base = {
        id: entry.id,
        name: entry.name || entry.id,
        file: entry.file,
        description: entry.description || '',
        exists: false,
        size: 0,
        modified_at: null,
        error: null,
        // misconfigured 与"文件还没生成"是两种性质：前者要 GM 去改配置，后者只需等运行
        misconfigured: false
    };

    let abs;
    try {
        abs = resolveSourcePath(entry, config);
    } catch (e) {
        // 配置写错不能让整页 500：把原因带回前端，GM 自己就能看出来
        return { ...base, error: e.message, misconfigured: true };
    }

    try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
            base.exists = true;
            base.size = stat.size;
            base.modified_at = stat.mtime.toISOString();
        } else {
            base.error = '目标不是一个文件';
        }
    } catch (e) {
        // ENOENT / EACCES 都按"当前不可读"呈现，前端给出提示即可
        base.error = `当前不可读：${e.code || e.message}`;
    }

    return base;
}

/** 级别匹配器缓存：patterns 未变就不重复编译正则 */
let levelMatcherCache = null;

/**
 * 编译行级别匹配器（带缓存）
 * @param {Object} config
 * @returns {Array<{level: string, regex: RegExp}>}
 */
function getLevelMatchers(config) {
    const signature = JSON.stringify(config.levels);
    if (levelMatcherCache && levelMatcherCache.signature === signature) {
        return levelMatcherCache.matchers;
    }

    const matchers = [];
    for (const level of config.levels.order) {
        const patterns = config.levels.patterns?.[level] || [];
        for (const pattern of patterns) {
            try {
                matchers.push({ level, regex: new RegExp(pattern) });
            } catch (e) {
                // 配置里写坏一条正则不应该让整个页面打不开，跳过并留下告警
                console.warn(`[后台日志] 级别正则无效（level=${level}, pattern=${pattern}）:`, e.message);
            }
        }
    }

    levelMatcherCache = { signature, matchers };
    return matchers;
}

/**
 * 判定单行日志的级别
 * @param {string} text
 * @param {Array} matchers
 * @returns {string} error / warn / debug / info
 */
function classifyLine(text, matchers) {
    for (const matcher of matchers) {
        if (matcher.regex.test(text)) return matcher.level;
    }
    return 'info';
}

/**
 * 从文件指定位置读取一段字节
 * 用 openSync + readSync 而不是 readFileSync：日志文件可能很大，只读关心的那段
 * @param {string} abs - 绝对路径
 * @param {number} start - 起始字节偏移
 * @param {number} length - 期望读取字节数
 * @returns {Buffer}
 */
function readRangeBuffer(abs, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    const fd = fs.openSync(abs, 'r');
    try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        return buf.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * 按行切分文本
 * 末尾因换行产生的空串会被丢掉，中间的空行保留（日志里的空行往往是分段信号）
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * 读文件末尾一段（快照模式）
 * 返回的内容一定以换行结尾；末尾未写完的半行单独放在 pending 里，
 * offset 停在半行开头 —— 下次从 offset 读就能拿到完整的整行。
 * @param {string} abs
 * @param {number} size
 * @param {number} maxBytes
 * @returns {{text: string, pending: string, offset: number}}
 */
function readTailSnapshot(abs, size, maxBytes) {
    const start = Math.max(0, size - maxBytes);
    const buf = readRangeBuffer(abs, start, size - start);

    // 从中间截断时丢掉第一行残片
    let begin = 0;
    if (start > 0) {
        const firstNewline = buf.indexOf(0x0A);
        begin = firstNewline >= 0 ? firstNewline + 1 : buf.length;
    }

    const slice = buf.subarray(begin);
    const lastNewline = slice.lastIndexOf(0x0A);
    const complete = lastNewline >= 0 ? slice.subarray(0, lastNewline + 1) : Buffer.alloc(0);

    return {
        text: complete.toString('utf8'),
        pending: slice.subarray(lastNewline + 1).toString('utf8'),
        offset: start + begin + complete.length
    };
}

/**
 * 从 offset 起读取新增内容（增量模式）
 * @param {string} abs
 * @param {number} size
 * @param {number} fromOffset
 * @param {number} maxBytes - 单次最多读多少字节（积压时分多次轮询慢慢追）
 * @returns {{text: string, pending: string, offset: number, rotated: boolean}}
 */
function readIncrement(abs, size, fromOffset, maxBytes) {
    let position = fromOffset;
    let rotated = false;
    // 偏移量大于当前体积 → 文件被清空或被替换过，从头重新跟随
    if (position > size) {
        rotated = true;
        position = 0;
    }

    const chunks = [];
    let readBytes = 0;
    while (position < size && readBytes < maxBytes) {
        const want = Math.min(maxBytes - readBytes, size - position);
        const buf = readRangeBuffer(abs, position, want);
        if (buf.length === 0) break;
        chunks.push(buf);
        readBytes += buf.length;
        position += buf.length;
    }

    const merged = Buffer.concat(chunks);
    const lastNewline = merged.lastIndexOf(0x0A);
    const complete = lastNewline >= 0 ? merged.subarray(0, lastNewline + 1) : Buffer.alloc(0);

    return {
        text: complete.toString('utf8'),
        pending: merged.subarray(lastNewline + 1).toString('utf8'),
        offset: (rotated ? 0 : fromOffset) + complete.length,
        rotated
    };
}

/**
 * 过滤 + 裁剪行，并转成前端需要的结构
 * @param {string[]} rawLines - 原始行（时间顺序）
 * @param {Object} options - { level, keyword, limit, matchers, maxLineLength }
 * @returns {{ lines: Array<{level: string, text: string}>, matched: number }}
 */
function filterLines(rawLines, options) {
    const { level, keyword, limit, matchers, maxLineLength } = options;
    const matched = [];

    for (const line of rawLines) {
        if (level && level !== 'all' && classifyLine(line, matchers) !== level) continue;
        if (keyword && !line.toLowerCase().includes(keyword)) continue;
        matched.push(line);
    }

    // 只回传时间上最近的 limit 行：排障看的是"刚刚发生了什么"
    const picked = matched.slice(-limit);
    return {
        lines: picked.map((line) => ({
            level: classifyLine(line, matchers),
            text: line.length > maxLineLength ? `${line.slice(0, maxLineLength)} …(本行已截断)` : line
        })),
        matched: matched.length
    };
}

/**
 * 截断单行，避免把超长行（如整段堆栈/序列化对象）塞进告警消息
 * @param {string} line
 * @param {number} maxLength
 * @returns {string}
 */
function truncateLine(line, maxLength) {
    return line.length > maxLength ? `${line.slice(0, maxLength)} …(已截断)` : line;
}

/**
 * 取飞书告警的 webhook 地址
 * 优先读环境变量（server/.env 里的 FEISHU_LOG_ALERT_WEBHOOK —— webhook 属于凭据，
 * 不该跟着配置文件进版本库），配置里的 webhook_url 只作为本地调试的兜底。
 * @param {Object} alertConfig - config.alert
 * @returns {string} 未配置时返回空串
 */
function getWebhookUrl(alertConfig) {
    const envName = String(alertConfig?.webhook_env || '').trim();
    const fromEnv = envName ? String(process.env[envName] || '').trim() : '';
    return fromEnv || String(alertConfig?.webhook_url || '').trim();
}

/**
 * 汇总告警状态（供 GM 后台显示：开了没、webhook 配了没、节奏多快）
 * @param {Object} config - getConfig() 结果
 * @returns {Object}
 */
function describeAlert(config) {
    const alert = config.alert || DEFAULT_CONFIG.alert;
    return {
        enabled: !!alert.enabled,
        levels: alert.levels || [],
        sources: alert.sources || [],
        webhook_configured: !!getWebhookUrl(alert),
        webhook_env: alert.webhook_env || '',
        poll_interval_ms: alert.poll_interval_ms,
        min_interval_ms: alert.min_interval_ms,
        dedupe_window_ms: alert.dedupe_window_ms,
        max_lines_per_alert: alert.max_lines_per_alert,
        max_alerts_per_hour: alert.max_alerts_per_hour
    };
}

module.exports = {
    CONFIG_NAME,
    LOG_ROOT,
    DEFAULT_CONFIG,
    getConfig,
    findSource,
    resolveSourcePath,
    describeSource,
    getLevelMatchers,
    classifyLine,
    readRangeBuffer,
    splitLines,
    readTailSnapshot,
    readIncrement,
    filterLines,
    truncateLine,
    getWebhookUrl,
    describeAlert
};
