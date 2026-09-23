/**
 * 玩家个人 AI 配置路由
 *
 * 玩家可在游戏设置里填写自己的 OpenAI 兼容接口（Base URL / 模型 / API Key），
 * 启用后其触发的大模型调用（历练事件、副本剧情等）优先走自己的接口与额度，
 * 避免消耗服务器公共配置的额度。
 *
 * 提供以下接口：
 *   1. GET    /api/user/ai-config       - 获取自己的 AI 配置（API Key 脱敏）
 *   2. PUT    /api/user/ai-config       - 保存/更新自己的 AI 配置（Key 加密入库）
 *   3. DELETE /api/user/ai-config       - 删除自己的 AI 配置
 *   4. POST   /api/user/ai-config/test  - 测试连接（支持未保存的表单值，返回详细错误）
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证，只能操作自己的配置
 *   - API Key 使用 AES-256-CBC 加密入库，接口返回时脱敏（仅显示后4位）
 *   - 测试连接在后端组装请求，不向前端下发 Key
 *   - 功能总开关、参数校验区间由 config/ai_config.json 的 userCustom 节点配置
 */

const express = require('express');
const router = express.Router();

const UserAiConfig = require('../models/user_ai_config');
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { infrastructure } = require('../modules');
const cryptoHelper = require('../utils/cryptoHelper');
const { runAiConnectivityTest } = require('../utils/aiConnectivityTester');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取玩家个人 AI 配置的功能开关与校验区间（ai_config.json -> userCustom）
 * 所有阈值均可在配置文件中调整，无需改代码
 * @returns {Object} 配置项（含兜底默认值）
 */
function getUserCustomConfig() {
    const conf = configLoader.getConfig('ai_config')?.userCustom || {};
    return {
        // 功能总开关：关闭后所有接口返回 FEATURE_DISABLED，前端隐藏入口
        enabled: conf.enabled !== false,
        // AIService 侧个人配置缓存 TTL（毫秒）
        overrideCacheTtlMs: conf.overrideCacheTtlMs || 60000,
        // 校验区间
        temperatureMin: conf.temperatureMin ?? 0,
        temperatureMax: conf.temperatureMax ?? 2,
        maxTokensMin: conf.maxTokensMin ?? 16,
        maxTokensMax: conf.maxTokensMax ?? 8192,
        timeoutMinMs: conf.timeoutMinMs ?? 5000,
        timeoutMaxMs: conf.timeoutMaxMs ?? 120000,
        defaultTimeoutMs: conf.defaultTimeoutMs ?? 30000
    };
}

/**
 * 将数据库记录转为前端可用的配置对象（API Key 脱敏）
 * @param {Object} record - UserAiConfig 数据库记录
 * @returns {Object} 脱敏后的配置对象
 */
function toSafeDTO(record) {
    if (!record) return null;
    // 解密后脱敏；解密失败不影响接口，给占位符提示重存 Key
    let maskedKey = '';
    if (record.encrypted_api_key) {
        try {
            maskedKey = cryptoHelper.mask(cryptoHelper.decrypt(record.encrypted_api_key));
        } catch (e) {
            maskedKey = '****（解密失败，请重新保存 Key）';
        }
    }
    return {
        base_url: record.base_url,
        model: record.model,
        api_key_masked: maskedKey,
        has_api_key: !!record.encrypted_api_key,
        temperature: record.temperature !== null ? parseFloat(record.temperature) : null,
        max_tokens: record.max_tokens,
        timeout: record.timeout,
        enabled: record.enabled,
        updatedAt: record.updatedAt
    };
}

/**
 * 校验并规范化玩家提交的配置参数
 * @param {Object} body - 请求体
 * @param {Object} limits - getUserCustomConfig() 返回的校验区间
 * @returns {Object} { base_url, model, temperature, max_tokens, timeout }
 * @throws {AppError} 参数不合法时抛业务错误（message 明确指出哪项不合法）
 */
function validateAndNormalize(body, limits) {
    const baseUrl = String(body.base_url || '').trim();
    const model = String(body.model || '').trim();

    if (!baseUrl) throw new AppError('请填写 Base URL（含版本路径，如 https://api.deepseek.com/v1）', 400, ErrorCodes.VALIDATION_ERROR);
    if (baseUrl.length > 255) throw new AppError('Base URL 过长（最多 255 字符）', 400, ErrorCodes.VALIDATION_ERROR);
    // 必须是 http(s) 地址，防止填入其他协议或注入
    if (!/^https?:\/\//i.test(baseUrl)) throw new AppError('Base URL 必须以 http:// 或 https:// 开头', 400, ErrorCodes.VALIDATION_ERROR);
    if (!model) throw new AppError('请填写模型名称（如 deepseek-chat）', 400, ErrorCodes.VALIDATION_ERROR);
    if (model.length > 100) throw new AppError('模型名称过长（最多 100 字符）', 400, ErrorCodes.VALIDATION_ERROR);

    // 可选采样参数：传了就必须在配置区间内，没传存 null（继承全局）
    let temperature = null;
    if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
        temperature = Number(body.temperature);
        if (!Number.isFinite(temperature) || temperature < limits.temperatureMin || temperature > limits.temperatureMax) {
            throw new AppError(`采样温度须在 ${limits.temperatureMin} - ${limits.temperatureMax} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
    }

    let maxTokens = null;
    if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
        maxTokens = Math.floor(Number(body.max_tokens));
        if (!Number.isFinite(maxTokens) || maxTokens < limits.maxTokensMin || maxTokens > limits.maxTokensMax) {
            throw new AppError(`最大 token 数须在 ${limits.maxTokensMin} - ${limits.maxTokensMax} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
    }

    let timeout = null;
    if (body.timeout !== undefined && body.timeout !== null && body.timeout !== '') {
        timeout = Math.floor(Number(body.timeout));
        if (!Number.isFinite(timeout) || timeout < limits.timeoutMinMs || timeout > limits.timeoutMaxMs) {
            throw new AppError(`超时时间须在 ${limits.timeoutMinMs} - ${limits.timeoutMaxMs} 毫秒之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
    }

    return { base_url: baseUrl, model, temperature, max_tokens: maxTokens, timeout };
}

/**
 * GET /api/user/ai-config
 * 获取当前玩家自己的 AI 配置（未配置时返回 null，前端据此显示空表单）
 */
router.get('/', auth, async (req, res, next) => {
    try {
        const limits = getUserCustomConfig();
        // 功能被关闭时也允许读取（前端据此隐藏编辑入口），只是不能改
        const record = await UserAiConfig.findOne({ where: { player_id: req.player.id } });
        res.json({
            code: 200,
            message: 'success',
            data: {
                feature_enabled: limits.enabled,
                config: toSafeDTO(record)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/user/ai-config
 * 保存/更新当前玩家的 AI 配置（不存在则创建，一人一条）
 * 请求体：{ base_url, model, api_key, temperature?, max_tokens?, timeout?, enabled? }
 * 注意：api_key 留空表示保留旧 Key（不覆盖）
 */
router.put('/', auth, async (req, res, next) => {
    try {
        const limits = getUserCustomConfig();
        // 功能总开关：GM 可在配置里一键关闭玩家自定义 AI
        if (!limits.enabled) {
            throw new AppError('服务器已关闭自定义 AI 功能', 403, ErrorCodes.FEATURE_DISABLED);
        }

        const normalized = validateAndNormalize(req.body, limits);
        const enabled = req.body.enabled === undefined ? true : !!req.body.enabled;

        // 已有配置则更新，否则创建（player_id 唯一，一人一条）
        const record = await UserAiConfig.findOne({ where: { player_id: req.player.id } });
        if (record) {
            // API Key 处理：传了新 Key 才覆盖；空串/未传保留旧值
            const updates = { ...normalized, enabled };
            if (req.body.api_key !== undefined && req.body.api_key !== '') {
                updates.encrypted_api_key = cryptoHelper.encrypt(req.body.api_key);
            }
            await record.update(updates);
        } else {
            // 首次保存必须提供 Key，否则启用后无法调用
            if (!req.body.api_key) {
                throw new AppError('首次配置请填写 API Key', 400, ErrorCodes.VALIDATION_ERROR);
            }
            await UserAiConfig.create({
                player_id: req.player.id,
                ...normalized,
                enabled,
                encrypted_api_key: cryptoHelper.encrypt(req.body.api_key)
            });
        }

        const updated = await UserAiConfig.findOne({ where: { player_id: req.player.id } });

        // 清除 AIService 的个人配置缓存，让新配置立即生效（不用等 TTL 过期）
        try {
            const AIService = require('../game/services/AIService');
            AIService.clearUserOverrideCache(req.player.id);
        } catch (e) {
            console.warn('[user_ai_config] 清除个人配置缓存失败（不影响保存）:', e.message);
        }

        res.json({
            code: 200,
            message: 'AI 配置已保存',
            data: toSafeDTO(updated)
        });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/user/ai-config
 * 删除当前玩家的 AI 配置（回到使用服务器公共配置的状态）
 */
router.delete('/', auth, async (req, res, next) => {
    try {
        const deleted = await UserAiConfig.destroy({ where: { player_id: req.player.id } });
        // 删除后同样清缓存，立即回落到公共配置
        try {
            const AIService = require('../game/services/AIService');
            AIService.clearUserOverrideCache(req.player.id);
        } catch (e) {
            console.warn('[user_ai_config] 清除个人配置缓存失败（不影响删除）:', e.message);
        }
        res.json({
            code: 200,
            message: deleted > 0 ? 'AI 配置已清除，将使用服务器公共配置' : '尚未配置自定义 AI'
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/user/ai-config/test
 * 测试 AI 连接（保存前即可测试，不必先保存）
 *
 * 请求体（均可选）：{ base_url?, model?, api_key?, timeout? }
 * 逻辑：表单里没填的字段自动用已保存的值补齐 —— 这样编辑已保存配置时
 * 不用重新输入 Key 也能测试新改的 URL / 模型。
 * 本接口永不返回 5xx：所有失败都以 code=200 + status='failed' + 详细原因返回，
 * 避免被全局错误中间件吞成一句"服务器错误"。
 */
router.post('/test', auth, async (req, res, next) => {
    try {
        const limits = getUserCustomConfig();
        if (!limits.enabled) {
            throw new AppError('服务器已关闭自定义 AI 功能', 403, ErrorCodes.FEATURE_DISABLED);
        }

        // 表单值与已保存值合并：表单优先，未填的用已保存的补
        const record = await UserAiConfig.findOne({ where: { player_id: req.player.id } });
        const baseUrl = String(req.body.base_url || '').trim() || record?.base_url || '';
        const model = String(req.body.model || '').trim() || record?.model || '';
        const timeout = req.body.timeout || record?.timeout || limits.defaultTimeoutMs;
        // Key：表单填了用表单的；否则用已保存的（解密在内存中完成，不回传前端）
        let apiKey = req.body.api_key || '';
        if (!apiKey && record?.encrypted_api_key) {
            try {
                apiKey = cryptoHelper.decrypt(record.encrypted_api_key);
            } catch (e) {
                // 解密失败：明确告诉用户 Key 坏了需要重存，而不是笼统报错
                return res.json({
                    code: 200,
                    message: '测试失败',
                    data: {
                        status: 'failed',
                        message: '已保存的 API Key 解密失败',
                        detail: '服务器加密密钥可能已变更，请重新填写并保存 API Key 后再测试。',
                        http_status: null,
                        tested_at: new Date().toISOString()
                    }
                });
            }
        }

        const result = await runAiConnectivityTest({ baseUrl, model, apiKey, timeout });

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
