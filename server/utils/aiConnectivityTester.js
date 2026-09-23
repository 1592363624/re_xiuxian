/**
 * AI 连接测试工具
 *
 * 供两个场景共用（保证行为一致、错误信息一致）：
 *   1. GM 后台：测试已保存/未保存的 AI 配置（routes/admin_ai.js）
 *   2. 玩家个人：测试自己填写的 AI 配置（routes/user_ai_config.js）
 *
 * 设计要点：
 *   - 永不抛出异常：所有失败（参数缺失、网络错误、HTTP 错误、配置错误）
 *     都以 { status: 'failed', message, detail } 形式返回，避免被全局错误
 *     中间件吞成一句笼统的"服务器错误"，前端拿不到任何排查线索
 *   - 错误信息尽量详细：透出 HTTP 状态码、第三方 API 返回的错误正文片段、
 *     网络错误码（ENOTFOUND/ECONNREFUSED 等），但绝不回显 API Key
 */
const axios = require('axios');
const { infrastructure } = require('../modules');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取连接测试相关配置项（ai_config.json -> connectivityTest）
 * 全部带兜底值：配置文件缺失/字段缺失时仍可工作
 * @returns {Object} 测试参数配置
 */
function getTestConfig() {
    const conf = configLoader.getConfig('ai_config')?.connectivityTest || {};
    return {
        // 测试提示词：越短越省 token
        testPrompt: conf.testPrompt || '你好',
        // 测试请求 max_tokens：不宜过小，推理型模型会把预算花在推理上导致正文为空
        maxTokens: conf.maxTokens || 32,
        // 超时钳制下限：保证慢接口不被误杀
        minTimeoutMs: conf.minTimeoutMs || 10000,
        // 超时钳制上限：保证后端一定先于前端（120s）返回，失败时前端能拿到具体原因
        maxTimeoutMs: conf.maxTimeoutMs || 90000,
        // 第三方错误正文片段的最大长度（避免把超长 HTML 错误页整段塞给前端）
        maxDetailLength: conf.maxDetailLength || 300
    };
}

/**
 * 清理第三方返回的错误正文：压平空白并截断，防止超长内容刷屏
 * @param {string} text - 原始错误正文
 * @param {number} maxLen - 最大长度
 * @returns {string} 清理后的正文
 */
function cleanSnippet(text, maxLen) {
    if (!text) return '';
    return String(text).replace(/\s+/g, ' ').trim().substring(0, maxLen);
}

/**
 * 从 axios 错误中提取详细失败原因（不含 API Key，不暴露完整 URL query）
 * @param {Error} err - axios 抛出的错误
 * @param {number} maxDetailLength - 错误正文截断长度
 * @returns {{message: string, detail: string}} 单行摘要 + 详细信息
 */
function extractFailure(err, maxDetailLength) {
    // 有 HTTP 响应：第三方 API 明确拒绝了请求（Key 无效 / 模型不存在 / 额度不足等）
    if (err.response) {
        const data = err.response.data;
        let apiMsg = '';
        // OpenAI 兼容接口的标准错误结构：{ error: { message } }
        if (data && typeof data === 'object' && data.error?.message) {
            apiMsg = data.error.message;
        } else if (data && typeof data === 'object' && data.message) {
            apiMsg = data.message;
        } else if (typeof data === 'string') {
            apiMsg = data;
        } else {
            // 未知结构：序列化后取片段，至少能让用户看到第三方到底返回了什么
            try { apiMsg = JSON.stringify(data); } catch (e) { apiMsg = ''; }
        }
        const snippet = cleanSnippet(apiMsg, maxDetailLength);
        return {
            message: `API 返回错误：HTTP ${err.response.status}${snippet ? ' - ' + snippet : ''}`,
            detail: `目标服务已响应但拒绝请求。HTTP 状态码 ${err.response.status}。` +
                (snippet ? `错误正文：${snippet}` : '响应体为空或无法解析。') +
                ' 常见原因：API Key 无效/过期、模型名不存在、账户额度不足、Base URL 路径不对。'
        };
    }

    // 请求已发出但没等到响应：网络层问题
    if (err.code === 'ECONNABORTED') {
        return {
            message: '连接超时',
            detail: `请求在超时时间内未收到任何响应。可能是网络不通、目标服务宕机或地域访问受限（可检查服务器能否直接访问该 Base URL）。`
        };
    }
    if (err.code === 'ENOTFOUND') {
        return {
            message: '域名无法解析（ENOTFOUND）',
            detail: 'Base URL 的域名不存在或拼写错误，请检查协议头（https://）与域名是否正确。'
        };
    }
    if (err.code === 'ECONNREFUSED') {
        return {
            message: '连接被拒绝（ECONNREFUSED）',
            detail: '目标地址拒绝了连接：端口错误、服务未启动，或被防火墙拦截。'
        };
    }
    if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate/i.test(err.message || '')) {
        return {
            message: `HTTPS 证书异常（${err.code || '证书错误'}）`,
            detail: '目标服务的 HTTPS 证书无效或过期，服务端无法与之建立安全连接。'
        };
    }

    // 兜底：把 axios 原始 message 和错误码都带出来
    return {
        message: `请求失败：${err.message || '未知错误'}`,
        detail: `错误码：${err.code || '无'}。请检查 Base URL 是否可达（可先在浏览器/本机 curl 验证）。`
    };
}

/**
 * 对一组 AI 配置执行连接性测试（发一条最小请求验证 URL/Key/模型可用）
 *
 * @param {Object} params - 测试参数
 * @param {string} params.baseUrl - API 基础地址（含版本路径，如 https://api.deepseek.com/v1）
 * @param {string} params.model - 模型名
 * @param {string} params.apiKey - 明文 API Key（仅在后端内存中使用，绝不写入日志/响应）
 * @param {number} [params.timeout] - 请求超时毫秒数（会被钳制到配置允许的区间）
 * @returns {Promise<{status: 'success'|'failed', message: string, detail: string, http_status: number|null, tested_at: string}>}
 *          永不抛异常：任何失败都返回 status='failed' 与可读的原因说明
 */
async function runAiConnectivityTest({ baseUrl, model, apiKey, timeout }) {
    const conf = getTestConfig();
    const testedAt = new Date().toISOString();
    const fail = (message, detail) => ({ status: 'failed', message, detail, http_status: null, tested_at: testedAt });

    try {
        // 参数前置校验：缺哪项就明确说哪项，不让用户猜
        if (!baseUrl || !String(baseUrl).trim()) return fail('缺少 Base URL', '请填写 API 基础地址（含版本路径，如 https://api.deepseek.com/v1）');
        if (!model || !String(model).trim()) return fail('缺少模型名称', '请填写模型名（如 deepseek-chat、gemini-2.5-flash）');
        if (!apiKey) return fail('缺少 API Key', '请填写 API Key 后再测试');

        // 与 AIService.getEndpoint 同一规则：baseUrl 已含 /chat/completions 则不再拼接
        const normalizedBase = String(baseUrl).trim().replace(/\/$/, '');
        const endpoint = normalizedBase.endsWith('/chat/completions') ? normalizedBase : `${normalizedBase}/chat/completions`;

        // 超时钳制：下限防误杀慢接口，上限保证前端（120s 超时）总能先收到后端结论
        const effectiveTimeout = Math.min(Math.max(Number(timeout) || conf.minTimeoutMs, conf.minTimeoutMs), conf.maxTimeoutMs);

        const response = await axios.post(endpoint, {
            model: String(model).trim(),
            messages: [{ role: 'user', content: conf.testPrompt }],
            max_tokens: conf.maxTokens,
            temperature: 0
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: effectiveTimeout,
            // 不跟随第三方错误页重定向，避免把错误页当成功
            maxRedirects: 0,
            // 只接受 JSON 响应，HTML 错误页会在这里直接抛错并进入下方失败分支
            validateStatus: null
        });

        // 判定成功只看"是否返回了 OpenAI 兼容的 choices 结构"。
        // 不再要求正文非空：推理型模型在 max_tokens 很小时 content 可能为空，但连接与鉴权已通过。
        const choices = response.data?.choices;
        if (response.status === 200 && Array.isArray(choices) && choices.length > 0) {
            const text = choices[0]?.message?.content;
            return {
                status: 'success',
                message: text
                    ? `连接成功，模型响应正常（HTTP 200）`
                    : `连接成功（HTTP 200，本次正文为空，通常是 max_tokens 偏小或推理型模型）`,
                detail: `端点：${endpoint} ｜ 模型：${model} ｜ 用时正常，鉴权与模型调用均通过。`,
                http_status: response.status,
                tested_at: testedAt
            };
        }

        // HTTP 200 但结构不对 / 非 200 状态被 validateStatus 放行到这里
        const snippet = cleanSnippet(
            typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? ''),
            conf.maxDetailLength
        );
        return {
            status: 'failed',
            message: `响应异常：HTTP ${response.status}，未返回 OpenAI 兼容的 choices 结构`,
            detail: `端点：${endpoint}。响应片段：${snippet || '（空）'}。通常是 Base URL 指向了非 OpenAI 兼容服务，或路径少了/多了版本段。`,
            http_status: response.status,
            tested_at: testedAt
        };
    } catch (err) {
        // axios 抛错（HTTP 4xx/5xx、网络错误等）→ 转成详细失败说明
        if (err.isAxiosError) {
            const { message, detail } = extractFailure(err, conf.maxDetailLength);
            return { status: 'failed', message, detail, http_status: err.response?.status ?? null, tested_at: testedAt };
        }
        // 非网络类异常（编程错误等）也要给出一句话原因，而不是 500 服务器错误
        return fail(`测试执行异常：${err.message}`, `错误码：${err.code || '无'}。请把该信息反馈给开发者。`);
    }
}

module.exports = { runAiConnectivityTest };
