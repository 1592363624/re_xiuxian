/**
 * 错误日志飞书告警服务
 *
 * 干什么：持续增量读取配置里登记的日志源，把级别命中 alert.levels（默认 error）的行聚合起来，
 * 通过飞书自定义机器人 webhook 推一条卡片消息。这样服务端一出错，群里立刻能看到，
 * 不必等人去后台翻日志。
 *
 * 为什么读文件而不是拦截 console.error：
 *   - 进程内的 console.error 只在"进程活着"时有效，启动期崩溃（配置错、端口占用、依赖缺失）
 *     恰恰是 P0 事故，而那时候进程已经没了 —— 这些线索只会留在日志文件里；
 *   - 页面（routes/admin_system_logs.js）与告警看的是同一份文件、同一套级别判定
 *     （都来自 utils/systemLog.js），不会出现"页面是红的、告警却没发"。
 *
 * 防打扰机制（缺一个都会被自己的告警淹没）：
 *   1. 聚合窗口 batch_window_ms：突发几十条错误合并成一条消息；
 *   2. 内容去重 dedupe_window_ms：同一条错误在此期间只发一次（崩溃循环里的栈顶都是同一行）；
 *   3. 全局节流 min_interval_ms：两条告警之间至少隔这么久；
 *   4. 小时上限 max_alerts_per_hour：真出事也不会把群里刷爆；
 *   5. ignore_patterns + 自身标记：告警自己的失败日志不会再触发告警（否则就是自激循环）。
 */
'use strict';

const fs = require('fs');
const axios = require('axios');
const systemLog = require('../../utils/systemLog');

/**
 * 本服务所有日志统一带这个标记，并且明确跳过带标记的行：
 * 告警发送失败 → 写一条 console.error → 落进同一个日志文件 → 被自己识别成 error → 再发一次告警，
 * 这个环一旦转起来，群里的消息量会跟着网络抖动指数增长。
 */
const SELF_TAG = '[日志告警]';

/** 待发送队列上限：长时间被节流/限流时不能无上限堆积 */
const MAX_PENDING_LINES = 200;

/** 飞书 webhook 请求超时（毫秒）：告警不值得为一个慢接口挂住轮询 */
const WEBHOOK_TIMEOUT_MS = 8000;

/** 上一批还在发送时，下一批的重试间隔（毫秒） */
const BUSY_RETRY_MS = 500;

/**
 * 构造一个"可预期的业务错误"，与 middleware/errorHandler 的 AppError 同形状
 * （服务层不直接依赖 middleware，避免层次倒置）
 * @param {string} message
 * @param {number} statusCode
 * @param {string} errorCode
 * @returns {Error}
 */
function operationalError(message, statusCode = 400, errorCode = 'VALIDATION_ERROR') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.errorCode = errorCode;
    error.isOperational = true;
    return error;
}

class LogAlertService {
    constructor() {
        /** 轮询定时器 */
        this.timer = null;
        /** 聚合发送定时器 */
        this.flushTimer = null;
        /** 各日志源已读到的字节偏移 */
        this.offsets = new Map();
        /** 待聚合发送的错误行 */
        this.pendingLines = [];
        /** 内容去重表：规范化后的行 → 上次告警时间戳 */
        this.recentSeen = new Map();
        /** 已发送消息的时间戳（用于小时上限） */
        this.sentTimestamps = [];
        /** 上次发送时间（用于全局节流） */
        this.lastSentAt = 0;
        /** 防重入：上一轮还没读完就跳过 */
        this.running = false;
        /** 防重入：正在发送（await 网络请求期间定时器可能又触发 flush） */
        this.flushing = false;
        /** 忽略规则编译缓存 */
        this.ignoreMatchers = null;
    }

    /**
     * 读取生效配置（每次现读，热更新即时生效）
     * @returns {Object}
     */
    getConfig() {
        return systemLog.getConfig();
    }

    /**
     * 取飞书 webhook 地址
     * @param {Object} config
     * @returns {string} 未配置时为空串
     */
    getWebhookUrl(config) {
        return systemLog.getWebhookUrl(config.alert);
    }

    /**
     * 编译忽略规则（带缓存）
     * @param {Object} alert
     * @returns {RegExp[]}
     */
    getIgnoreMatchers(alert) {
        const signature = JSON.stringify(alert.ignore_patterns || []);
        if (this.ignoreMatchers && this.ignoreMatchers.signature === signature) {
            return this.ignoreMatchers.matchers;
        }
        const matchers = [];
        for (const pattern of alert.ignore_patterns || []) {
            try {
                matchers.push(new RegExp(pattern));
            } catch (e) {
                console.warn(`${SELF_TAG} 忽略规则无效（${pattern}）:`, e.message);
            }
        }
        this.ignoreMatchers = { signature, matchers };
        return matchers;
    }

    /**
     * 启动轮询（幂等：重复调用不会起第二个定时器）
     * @returns {boolean} 是否真的启动了
     */
    start() {
        if (this.timer) return false;

        const config = this.getConfig();
        if (!config.alert.enabled) {
            console.log(`${SELF_TAG} 配置关闭（system_log_viewer.alert.enabled），未启动`);
            return false;
        }

        const webhookUrl = this.getWebhookUrl(config);
        if (!webhookUrl) {
            // 仍要启动：地址可能稍后通过 .env 补上，轮询本身也很便宜；
            // 但必须把原因喊出来，否则 GM 会以为"开着就会响"
            console.warn(`${SELF_TAG} 未配置飞书 webhook（环境变量 ${config.alert.webhook_env} 或 alert.webhook_url），告警不会发出`);
        }

        this.timer = setInterval(() => {
            this.pollOnce().catch((err) => console.error(`${SELF_TAG} 轮询失败:`, err.message));
        }, config.alert.poll_interval_ms);

        // 首轮不等一个间隔：进程刚崩过又起来时，崩溃现场就在文件末尾，别等下一轮才看见
        setImmediate(() => {
            this.pollOnce().catch((err) => console.error(`${SELF_TAG} 首轮执行失败:`, err.message));
        });

        console.log(`${SELF_TAG} 已启动（每 ${config.alert.poll_interval_ms}ms 检查一次，级别：${(config.alert.levels || []).join('/') || '-'}）`);
        return true;
    }

    /**
     * 停止轮询（便于测试与优雅停机）
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * 跑一轮：把配置内所有存在的日志源的新增行读出来，挑出错误行入队
     * @returns {Promise<{scanned: number, collected: number, skipped: boolean}>}
     */
    async pollOnce() {
        const config = this.getConfig();
        if (!config.alert.enabled) return { scanned: 0, collected: 0, skipped: true };

        // 上一轮没跑完就跳过，避免两轮读到同一段内容（偏移量会互相覆盖）
        if (this.running) return { scanned: 0, collected: 0, skipped: true };
        this.running = true;

        try {
            const matchers = systemLog.getLevelMatchers(config);
            const ignoreMatchers = this.getIgnoreMatchers(config.alert);
            const levels = new Set(config.alert.levels || ['error']);
            const maxBytesPerPoll = config.alert.max_read_bytes_per_poll;
            let scanned = 0;
            let collected = 0;

            for (const sourceId of config.alert.sources || []) {
                let entry;
                let abs;
                try {
                    entry = systemLog.findSource(config, sourceId);
                    abs = systemLog.resolveSourcePath(entry, config);
                } catch (e) {
                    console.warn(`${SELF_TAG} 跳过无效日志源 ${sourceId}: ${e.message}`);
                    continue;
                }

                let stat;
                try {
                    stat = fs.statSync(abs);
                } catch (e) {
                    continue; // 文件还没生成（PM2 尚未写过 error.log）不是错误
                }
                if (!stat.isFile()) continue;

                const size = stat.size;
                let offset = this.offsets.get(sourceId);
                // 首次见到这个文件时只回扫末尾一小段：既能捞到刚崩溃的现场，又不会把历史错误全翻出来。
                // 这一类行会在消息里标成"回扫"，让人一眼看出它不是此刻刚发生的
                const isStartupScan = offset === undefined;
                if (isStartupScan) offset = Math.max(0, size - config.alert.startup_lookback_bytes);
                // 偏移量大于体积 → 文件被清空或轮转过，从头跟
                if (offset > size) offset = 0;
                if (offset >= size) {
                    this.offsets.set(sourceId, offset);
                    continue;
                }

                const chunk = systemLog.readIncrement(abs, size, offset, maxBytesPerPoll);
                this.offsets.set(sourceId, chunk.offset);

                const lines = systemLog.splitLines(chunk.text);
                scanned += lines.length;

                for (const line of lines) {
                    if (!line.trim()) continue;
                    // 自身标记直接跳过：这是"告警自己出问题"的日志，报它只会自激
                    if (line.includes(SELF_TAG)) continue;
                    if (ignoreMatchers.some((regex) => regex.test(line))) continue;
                    const level = systemLog.classifyLine(line, matchers);
                    if (!levels.has(level)) continue;

                    this.pendingLines.push({
                        source_id: sourceId,
                        source_name: entry.name || sourceId,
                        file: entry.file,
                        level,
                        startup_scan: isStartupScan,
                        text: systemLog.truncateLine(line, config.alert.max_line_length)
                    });
                    collected += 1;
                }
            }

            if (this.pendingLines.length > MAX_PENDING_LINES) {
                // 只保留最新的：排障关心的是"最近的错误"，被丢掉的老行在页面上仍然看得到
                this.pendingLines = this.pendingLines.slice(-MAX_PENDING_LINES);
            }

            if (collected > 0) this.scheduleFlush(config.alert.batch_window_ms);
            return { scanned, collected, skipped: false };
        } finally {
            this.running = false;
        }
    }

    /**
     * 安排一次聚合发送（重复调用只保留最近一次计时）
     * @param {number} delayMs
     */
    scheduleFlush(delayMs) {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flush().catch((err) => console.error(`${SELF_TAG} 发送失败:`, err.message));
        }, Math.max(0, delayMs));
    }

    /**
     * 发送聚合告警
     * 顺序：去重筛查 → 节流 → 小时上限 → 发送 → 记入去重表。
     *
     * 两个顺序上的讲究：
     *   1. 被节流时必须把这一批放回队列（不丢内容），因此"记入去重表"只能在**确认发送**之后做 ——
     *      否则回队的那批会在下一轮被自己的去重表判成重复，错误就被静默吞掉了；
     *   2. 发送失败也不记去重表，让它在下一批重试（节流会兜住重试频率）。
     * @returns {Promise<{sent: boolean, reason?: string, count?: number}>}
     */
    async flush() {
        this.flushTimer = null;

        // 防重入：本方法内部 await 网络请求，期间定时器可能又触发一次
        // 撞上时重新排一次（否则这批内容会一直卡在队列里，直到下次采集到新错误才被带走）
        if (this.flushing) {
            this.scheduleFlush(BUSY_RETRY_MS);
            return { sent: false, reason: 'busy' };
        }
        this.flushing = true;

        try {
            const config = this.getConfig();
            const alert = config.alert;
            if (!alert.enabled) return { sent: false, reason: 'disabled' };

            const batch = this.pendingLines;
            if (batch.length === 0) return { sent: false, reason: 'empty' };
            this.pendingLines = [];

            const now = Date.now();
            const dedupeWindow = alert.dedupe_window_ms;

            // 去重表顺带清理：长期运行不能让它无限增长
            for (const [key, seenAt] of this.recentSeen) {
                if (now - seenAt > dedupeWindow) this.recentSeen.delete(key);
            }

            // 只筛查、不写入：真正发出去之后再登记，被节流回队的那批才能重发
            const fresh = batch.filter((item) => {
                const seenAt = this.recentSeen.get(this.normalizeKey(item.text));
                return !(seenAt && now - seenAt < dedupeWindow);
            });

            if (fresh.length === 0) return { sent: false, reason: 'duplicated' };

            // 全局节流：把这一批放回去，等间隔到了再发（不丢内容）
            const elapsed = now - this.lastSentAt;
            if (this.lastSentAt && elapsed < alert.min_interval_ms) {
                this.pendingLines = [...fresh, ...this.pendingLines].slice(-MAX_PENDING_LINES);
                this.scheduleFlush(alert.min_interval_ms - elapsed + 100);
                return { sent: false, reason: 'throttled' };
            }

            // 小时上限：这是最后一道闸，超了就明确丢弃并记录，避免把群刷爆
            this.sentTimestamps = this.sentTimestamps.filter((ts) => now - ts < 3600 * 1000);
            if (this.sentTimestamps.length >= alert.max_alerts_per_hour) {
                console.warn(`${SELF_TAG} 本小时已发送 ${this.sentTimestamps.length} 条告警，超过上限 ${alert.max_alerts_per_hour}，本次 ${fresh.length} 行错误被抑制`);
                return { sent: false, reason: 'hourly_cap', count: fresh.length };
            }

            const webhookUrl = this.getWebhookUrl(config);
            if (!webhookUrl) {
                // 未配置地址时把内容放回队列：等 .env 补上之后（下一次轮询）还能发出去
                this.pendingLines = [...fresh, ...this.pendingLines].slice(-MAX_PENDING_LINES);
                console.warn(`${SELF_TAG} 未配置飞书 webhook，${fresh.length} 行错误暂存未发出（配置项 alert.webhook_env / alert.webhook_url）`);
                return { sent: false, reason: 'no_webhook', count: fresh.length };
            }

            const payload = this.buildAlertCard(fresh, alert);
            await this.postToFeishu(webhookUrl, payload);

            // 发送成功才记入去重表与小时计数
            this.lastSentAt = Date.now();
            this.sentTimestamps.push(this.lastSentAt);
            for (const item of fresh) this.recentSeen.set(this.normalizeKey(item.text), this.lastSentAt);

            console.log(`${SELF_TAG} 已推送告警：${fresh.length} 行（${[...new Set(fresh.map((i) => i.source_id))].join(', ')}）`);
            return { sent: true, count: fresh.length };
        } finally {
            this.flushing = false;
        }
    }

    /**
     * 规范化一行用于去重：去掉时间戳/数字这类每次都变的前缀片段
     * 崩溃循环里同一行错误的时间戳每次都不同，不去掉就会绕过所有去重
     * @param {string} text
     * @returns {string}
     */
    normalizeKey(text) {
        return text
            .replace(/\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, '')
            .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);
    }

    /**
     * 构造飞书卡片消息体（interactive 卡片比纯文本更容易一眼看清是"出事了"）
     * @param {Array} lines - 待告警的错误行
     * @param {Object} alert - 告警配置
     * @returns {Object} webhook 请求体
     */
    buildAlertCard(lines, alert) {
        const groups = new Map();
        for (const item of lines) {
            if (!groups.has(item.file)) groups.set(item.file, []);
            groups.get(item.file).push(item);
        }

        const shown = lines.slice(0, alert.max_lines_per_alert);
        const bodyLines = shown.map((item) => item.text).join('\n');
        const omitted = lines.length - shown.length;

        const parts = [];
        parts.push(`**捕获时间**：${this.formatBeijingNow()}`);
        parts.push(`**错误行数**：${lines.length}`);
        for (const [file, items] of groups) {
            parts.push(`**来源**：${items[0].source_name}（\`${file}\`）× ${items.length}`);
        }
        parts.push('');
        parts.push('```\n' + bodyLines + '\n```');
        if (omitted > 0) parts.push(`（还有 ${omitted} 行未展示，完整内容见 GM 后台「后台日志」页）`);
        // 回扫来的行是"进程启动前就写进文件的历史内容"，标出来免得被误读成刚发生的故障
        if (lines.some((item) => item.startup_scan)) {
            parts.push('（含进程启动时回扫到的历史行，用于捕捉启动期崩溃现场）');
        }

        return {
            msg_type: 'interactive',
            card: {
                config: { wide_screen_mode: true },
                header: {
                    template: 'red',
                    title: { tag: 'plain_text', content: '⚠️ 服务端错误日志告警' }
                },
                elements: [
                    { tag: 'div', text: { tag: 'lark_md', content: parts.join('\n') } },
                    { tag: 'hr' },
                    {
                        tag: 'note',
                        elements: [{
                            tag: 'plain_text',
                            content: `由 xiuxian-server 日志告警自动发出 · 规则见 config/system_log_viewer.json 的 alert 段`
                        }]
                    }
                ]
            }
        };
    }

    /**
     * 北京时间字符串（日志与告警统一按 UTC+8 呈现，与后台其它页面一致）
     * @returns {string}
     */
    formatBeijingNow() {
        const now = new Date(Date.now() + 8 * 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    }

    /**
     * 发送消息到飞书 webhook
     * @param {string} webhookUrl
     * @param {Object} payload
     * @returns {Promise<Object>} 飞书响应体
     */
    async postToFeishu(webhookUrl, payload) {
        const res = await axios.post(webhookUrl, payload, {
            timeout: WEBHOOK_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json' }
        });

        // 飞书自定义机器人成功返回 {"code":0,...}（新版）或 {"StatusCode":0,...}（旧版），失败时带 msg
        const body = res.data || {};
        const failed = body.code !== undefined ? body.code !== 0 : body.StatusCode !== 0;
        if (failed) {
            throw operationalError(`飞书告警发送失败：${body.msg || body.StatusMessage || JSON.stringify(body)}`, 502, 'SERVICE_UNAVAILABLE');
        }
        return body;
    }

    /**
     * 发一条测试告警（GM 后台点一下就能确认 webhook 通不通）
     * @param {Object} [config] - 可不传，默认现读配置
     * @returns {Promise<{sent: boolean, webhook_configured: boolean, message: string}>}
     */
    async sendTestAlert(config = null) {
        const effective = config || this.getConfig();
        const webhookUrl = this.getWebhookUrl(effective);
        if (!webhookUrl) {
            throw operationalError(
                `未配置飞书 webhook：请设置环境变量 ${effective.alert.webhook_env}（推荐，见 server/.env）或配置 system_log_viewer.alert.webhook_url`,
                400,
                'CONFIG_ERROR'
            );
        }

        const alert = effective.alert;
        const payload = {
            msg_type: 'interactive',
            card: {
                config: { wide_screen_mode: true },
                header: {
                    template: 'blue',
                    title: { tag: 'plain_text', content: '🔔 日志告警测试' }
                },
                elements: [
                    {
                        tag: 'div',
                        text: {
                            tag: 'lark_md',
                            content: [
                                '**这是一条来自 GM 后台的测试消息**，说明日志告警通道已打通。',
                                `**触发时间**：${this.formatBeijingNow()}`,
                                `**监控级别**：${(alert.levels || []).join(' / ') || '-'}`,
                                `**监控日志源**：${(alert.sources || []).join(' / ') || '-'}`,
                                `**检查间隔**：${alert.poll_interval_ms}ms　**相同错误静默**：${alert.dedupe_window_ms}ms`
                            ].join('\n')
                        }
                    },
                    {
                        tag: 'note',
                        elements: [{ tag: 'plain_text', content: '真正触发时标题为红色「服务端错误日志告警」' }]
                    }
                ]
            }
        };

        await this.postToFeishu(webhookUrl, payload);
        return { sent: true, webhook_configured: true, message: '测试告警已发送到飞书，请查看群消息' };
    }

    /**
     * 当前运行状态（供排查"告警到底在跑没有"）
     * @returns {Object}
     */
    getStatus() {
        const config = this.getConfig();
        return {
            running: !!this.timer,
            enabled: !!config.alert.enabled,
            webhook_configured: !!this.getWebhookUrl(config),
            pending_lines: this.pendingLines.length,
            offsets: Object.fromEntries(this.offsets),
            last_sent_at: this.lastSentAt ? new Date(this.lastSentAt).toISOString() : null,
            sent_last_hour: this.sentTimestamps.filter((ts) => Date.now() - ts < 3600 * 1000).length
        };
    }
}

module.exports = new LogAlertService();
// 测试里需要独立实例（互不共享偏移量与去重表）
module.exports.LogAlertService = LogAlertService;
