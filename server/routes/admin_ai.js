/**
 * AI 配置管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /api/admin/ai-config        - 获取所有 AI 配置列表（API Key 脱敏）
 *   2. POST   /api/admin/ai-config        - 新增 AI 配置（API Key 加密入库）
 *   3. PUT    /api/admin/ai-config/:id    - 更新 AI 配置（支持部分更新）
 *   4. DELETE /api/admin/ai-config/:id    - 删除 AI 配置
 *   5. POST   /api/admin/ai-config/:id/activate - 激活指定配置（其他自动停用）
 *   6. POST   /api/admin/ai-config/:id/test     - 测试连接性（不下发 Key 到前端）
 *   7. GET    /api/admin/ai-config/providers    - 获取可选提供商列表（从 ai_config.json 读取）
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限
 *   - API Key 入库前使用 AES-256-CBC 加密
 *   - 接口返回时 API Key 脱敏（仅显示后4位）
 *   - 测试连接接口在后端组装完整请求，不向前端下发 Key
 *   - 所有操作记录到 AdminLog
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

// 数据模型与中间件
const AiConfig = require('../models/ai_config');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { infrastructure } = require('../modules');

// 工具：API Key 加解密与脱敏
const cryptoHelper = require('../utils/cryptoHelper');

// ConfigLoader：用于读取 ai_config.json 中的 providers 列表
const configLoader = infrastructure.ConfigLoader;

/**
 * GM 权限校验中间件
 * 复用 admin.js 中的 adminCheck 逻辑：检查 req.player.role === 'admin'
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 将数据库记录转为前端可用的配置对象
 * 关键：API Key 脱敏，仅返回 mask 后的字符串
 * @param {Object} record - AiConfig 数据库记录
 * @returns {Object} 脱敏后的配置对象
 */
function toSafeDTO(record) {
    if (!record) return null;
    // 解密 API Key 后进行脱敏（不入库、不返回完整 Key）
    let maskedKey = '';
    if (record.encrypted_api_key) {
        try {
            const plainKey = cryptoHelper.decrypt(record.encrypted_api_key);
            maskedKey = cryptoHelper.mask(plainKey);
        } catch (e) {
            // 解密失败时返回占位符，避免接口报错
            maskedKey = '****（解密失败）';
        }
    }
    return {
        id: record.id,
        provider: record.provider,
        display_name: record.display_name,
        base_url: record.base_url,
        model: record.model,
        api_key_masked: maskedKey,    // 脱敏后的 API Key
        has_api_key: !!record.encrypted_api_key,  // 是否已配置 Key
        protocol: record.protocol,
        temperature: parseFloat(record.temperature),
        max_tokens: record.max_tokens,
        timeout: record.timeout,
        is_active: record.is_active,
        last_tested_at: record.last_tested_at,
        last_test_status: record.last_test_status,
        last_test_message: record.last_test_message,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
    };
}

/**
 * 写入管理员操作日志（封装，避免代码重复）
 * @param {Object} params - { adminId, action, targetId, detail }
 */
async function logAdminAction({ adminId, action, targetId = null, detail = '' }) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action: action,
            target_id: targetId ? String(targetId) : null,
            detail: detail
        });
    } catch (e) {
        console.error('[admin_ai] 写入操作日志失败:', e.message);
    }
}

/**
 * GET /api/admin/ai-config
 * 获取所有 AI 配置列表（API Key 脱敏）
 */
router.get('/', auth, adminCheck, async (req, res, next) => {
    try {
        const configs = await AiConfig.findAll({
            order: [['is_active', 'DESC'], ['createdAt', 'ASC']]
        });
        res.json({
            code: 200,
            message: 'success',
            data: configs.map(toSafeDTO)
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/ai-config/providers
 * 获取可选的提供商列表（从 ai_config.json 读取，供前端下拉选择）
 * 注意：不返回 apiKey 等敏感字段
 */
router.get('/providers', auth, adminCheck, async (req, res, next) => {
    try {
        const aiConfigJson = configLoader.getConfig('ai_config');
        const providers = aiConfigJson?.providers || {};

        // 转为前端可用的数组结构，过滤敏感字段
        const providerList = Object.entries(providers).map(([key, conf]) => ({
            provider: key,
            name: conf.name || key,
            models: conf.models || [],
            default_endpoint: conf.endpoint || '',
            compatible_with: conf.compatibleWith || 'openai',
            description: conf.description || ''
        }));

        res.json({
            code: 200,
            message: 'success',
            data: providerList
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/ai-config
 * 新增 AI 配置
 * 请求体：{ provider, display_name, base_url, model, api_key, protocol, temperature, max_tokens, timeout, is_active }
 */
router.post('/', auth, adminCheck, async (req, res, next) => {
    try {
        const {
            provider, display_name, base_url, model,
            api_key = '', protocol = 'openai',
            temperature = 0.7, max_tokens = 1000, timeout = 30000,
            is_active = false
        } = req.body;

        // 参数校验
        if (!provider || !display_name || !base_url || !model) {
            throw new AppError('缺少必要参数：provider, display_name, base_url, model', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 检查 provider 是否重复
        const existing = await AiConfig.findOne({ where: { provider } });
        if (existing) {
            throw new AppError(`提供商 ${provider} 的配置已存在，请使用更新接口`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 加密 API Key
        const encryptedKey = api_key ? cryptoHelper.encrypt(api_key) : null;

        // 若设为启用，先将其他配置停用（保证同一时间仅一条启用）
        if (is_active) {
            await AiConfig.update({ is_active: false }, { where: { is_active: true } });
        }

        const newConfig = await AiConfig.create({
            provider, display_name, base_url, model,
            encrypted_api_key: encryptedKey,
            protocol, temperature, max_tokens, timeout,
            is_active
        });

        // 记录操作日志（不记录完整 API Key）
        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_create',
            targetId: newConfig.id,
            detail: `新增 AI 配置: ${display_name} (${provider}), 模型: ${model}`
        });

        res.json({
            code: 200,
            message: 'AI 配置创建成功',
            data: toSafeDTO(newConfig)
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/ai-config/:id
 * 更新 AI 配置（支持部分更新）
 * 请求体：可包含 display_name, base_url, model, api_key, protocol, temperature, max_tokens, timeout
 * 注意：is_active 字段不通过此接口修改，请使用 /activate 接口
 */
router.put('/:id', auth, adminCheck, async (req, res, next) => {
    try {
        const { id } = req.params;
        const config = await AiConfig.findByPk(id);
        if (!config) {
            throw new AppError('AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 字段白名单：仅允许更新这些字段，防止越权修改其他字段
        const allowedFields = ['display_name', 'base_url', 'model', 'protocol', 'temperature', 'max_tokens', 'timeout'];
        const updates = {};
        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        });

        // API Key 单独处理：若传入新 Key 则加密后更新
        if (req.body.api_key !== undefined) {
            // 空字符串表示清空 Key
            updates.encrypted_api_key = req.body.api_key ? cryptoHelper.encrypt(req.body.api_key) : null;
        }

        if (Object.keys(updates).length === 0) {
            throw new AppError('未提供需要更新的字段', 400, ErrorCodes.VALIDATION_ERROR);
        }

        await AiConfig.update(updates, { where: { id } });

        // 记录操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_update',
            targetId: id,
            detail: `更新 AI 配置: ${config.display_name} (${config.provider}), 修改字段: ${Object.keys(updates).join(', ')}`
        });

        // 重新查询返回最新数据
        const updated = await AiConfig.findByPk(id);
        res.json({
            code: 200,
            message: 'AI 配置更新成功',
            data: toSafeDTO(updated)
        });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/admin/ai-config/:id
 * 删除 AI 配置
 */
router.delete('/:id', auth, adminCheck, async (req, res, next) => {
    try {
        const { id } = req.params;
        const config = await AiConfig.findByPk(id);
        if (!config) {
            throw new AppError('AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 不允许删除当前启用的配置，避免 AI 服务突然失效
        if (config.is_active) {
            throw new AppError('不允许删除当前启用的 AI 配置，请先切换到其他配置', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        await config.destroy();

        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_delete',
            targetId: id,
            detail: `删除 AI 配置: ${config.display_name} (${config.provider})`
        });

        res.json({
            code: 200,
            message: 'AI 配置已删除'
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/ai-config/:id/activate
 * 激活指定的 AI 配置（其他配置自动停用）
 * 激活后会触发 AIService 热重载，立即生效
 */
router.post('/:id/activate', auth, adminCheck, async (req, res, next) => {
    try {
        const { id } = req.params;
        const config = await AiConfig.findByPk(id);
        if (!config) {
            throw new AppError('AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 事务：先将所有配置停用，再激活指定配置
        const t = await require('../config/database').transaction();
        try {
            await AiConfig.update({ is_active: false }, { where: {}, transaction: t });
            await config.update({ is_active: true }, { transaction: t });
            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        // 触发 AIService 热重载（从数据库读取最新配置并替换实例）
        const AIService = require('../game/services/AIService');
        await AIService.reloadFromDatabase();

        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_activate',
            targetId: id,
            detail: `激活 AI 配置: ${config.display_name} (${config.provider}), 模型: ${config.model}`
        });

        res.json({
            code: 200,
            message: `已激活配置：${config.display_name}`,
            data: toSafeDTO(await AiConfig.findByPk(id))
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/ai-config/:id/test
 * 测试 AI 配置的连接性
 *
 * 实现逻辑：
 *   1. 从数据库读取配置并解密 API Key（后端组装请求，不下发前端）
 *   2. 向目标 API 发送一个简短的测试请求（"你好"）
 *   3. 记录测试结果到 last_test_status / last_test_message
 *   4. 返回测试结果（不包含完整响应内容，避免泄露）
 */
router.post('/:id/test', auth, adminCheck, async (req, res, next) => {
    try {
        const { id } = req.params;
        const config = await AiConfig.findByPk(id);
        if (!config) {
            throw new AppError('AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 解密 API Key
        if (!config.encrypted_api_key) {
            throw new AppError('该配置未设置 API Key，无法测试', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const apiKey = cryptoHelper.decrypt(config.encrypted_api_key);

        // 构造测试请求（最小 token 消耗）
        const baseUrl = config.base_url.replace(/\/$/, '');
        let endpoint;
        const headers = { 'Content-Type': 'application/json' };

        if (config.protocol === 'anthropic') {
            endpoint = `${baseUrl}/messages`;
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            // OpenAI 兼容协议
            endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const requestBody = {
            model: config.model,
            messages: [{ role: 'user', content: '你好' }],
            max_tokens: 10,    // 极小 token 数，降低测试成本
            temperature: 0
        };

        // 记录测试时间
        const testedAt = new Date();
        let testStatus, testMessage;

        try {
            const response = await axios.post(endpoint, requestBody, {
                headers,
                timeout: Math.max(config.timeout, 10000)
            });

            // 判断响应是否正常
            if (response.status === 200 && (response.data?.choices?.[0]?.message?.content || response.data?.content?.[0]?.text)) {
                testStatus = 'success';
                testMessage = `连接成功，模型响应正常（HTTP ${response.status}）`;
            } else {
                testStatus = 'failed';
                testMessage = `响应异常：HTTP ${response.status}，响应结构不符合预期`;
            }
        } catch (err) {
            testStatus = 'failed';
            // 提取关键错误信息，不暴露完整 URL（含潜在 query 参数）
            if (err.response) {
                const apiErr = err.response.data?.error?.message || err.response.data?.message || JSON.stringify(err.response.data).substring(0, 200);
                testMessage = `API 返回错误：HTTP ${err.response.status} - ${apiErr}`;
            } else if (err.code === 'ECONNABORTED') {
                testMessage = `连接超时（超过 ${config.timeout}ms）`;
            } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                testMessage = `无法连接到服务器：${err.code}（请检查 base_url 是否正确）`;
            } else {
                testMessage = `请求失败：${err.message}`;
            }
        }

        // 更新测试结果到数据库
        await config.update({
            last_tested_at: testedAt,
            last_test_status: testStatus,
            last_test_message: testMessage
        });

        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_test',
            targetId: id,
            detail: `测试 AI 配置: ${config.display_name}, 结果: ${testStatus}`
        });

        res.json({
            code: 200,
            message: testMessage,
            data: {
                status: testStatus,
                message: testMessage,
                tested_at: testedAt
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
