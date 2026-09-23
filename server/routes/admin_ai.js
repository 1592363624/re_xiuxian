/**
 * AI 配置管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /api/admin/ai-config        - 获取所有 AI 配置列表（API Key 脱敏）
 *   2. POST   /api/admin/ai-config        - 新增 AI 配置（API Key 加密入库）
 *   3. PUT    /api/admin/ai-config/:id    - 更新 AI 配置（支持部分更新）
 *   4. DELETE /api/admin/ai-config/:id    - 删除 AI 配置
 *   5. POST   /api/admin/ai-config/:id/activate - 激活指定配置（其他自动停用）
 *   6. POST   /api/admin/ai-config/:id/test     - 测试已保存配置的连接性（不下发 Key 到前端）
 *   7. GET    /api/admin/ai-config/providers    - 获取可选接口列表（现仅含单一 OpenAI 兼容接口）
 *   8. POST   /api/admin/ai-config/test         - 测试"未保存"的表单配置（编辑弹窗保存前即可测试；
 *                                               api_key 留空时可用 config_id 复用已存 Key）
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

// 数据模型与中间件
const AiConfig = require('../models/ai_config');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { infrastructure } = require('../modules');

// 工具：API Key 加解密与脱敏
const cryptoHelper = require('../utils/cryptoHelper');
// 工具：AI 连接测试（与玩家个人配置路由共用，保证行为与错误信息一致）
const { runAiConnectivityTest } = require('../utils/aiConnectivityTester');

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
 * 获取可选接口列表（从 ai_config.json 读取，现仅含单一 OpenAI 兼容接口）
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
 * 测试"已保存"AI 配置的连接性
 *
 * 实现逻辑：
 *   1. 从数据库读取配置并解密 API Key（后端组装请求，不下发前端）
 *   2. 调用共享测试工具向目标 API 发送一条最小请求（详见 utils/aiConnectivityTester.js）
 *   3. 记录测试结果到 last_test_status / last_test_message
 *   4. 返回测试结果与详细失败原因（不包含完整响应内容，避免泄露）
 *
 * 注意：本接口永不返回 5xx —— 连接失败属于正常业务结果，
 * 以 code=200 + status='failed' + 详细原因返回，前端能直接展示排查线索；
 * 只有 Key 解密失败这类环境问题会抛 AppError（带明确 message，不会变成"服务器错误"）。
 */
router.post('/:id/test', auth, adminCheck, async (req, res, next) => {
    try {
        const { id } = req.params;
        const config = await AiConfig.findByPk(id);
        if (!config) {
            throw new AppError('AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 解密 API Key：解密失败（密钥变更等）单独给出明确原因，不笼统报错
        if (!config.encrypted_api_key) {
            throw new AppError('该配置未设置 API Key，无法测试', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        let apiKey;
        try {
            apiKey = cryptoHelper.decrypt(config.encrypted_api_key);
        } catch (e) {
            throw new AppError(`API Key 解密失败：${e.message}（请重新保存 Key）`, 400, ErrorCodes.CONFIG_ERROR);
        }

        // 调用共享测试工具（永不抛异常，失败时返回详细原因）
        const result = await runAiConnectivityTest({
            baseUrl: config.base_url,
            model: config.model,
            apiKey,
            timeout: config.timeout
        });

        // 更新测试结果到数据库（仅存单行摘要，详细信息实时返回给前端）
        await config.update({
            last_tested_at: result.tested_at,
            last_test_status: result.status,
            last_test_message: result.message
        });

        await logAdminAction({
            adminId: req.player.id,
            action: 'ai_config_test',
            targetId: id,
            detail: `测试 AI 配置: ${config.display_name}, 结果: ${result.status}${result.status === 'failed' ? ` (${result.message})` : ''}`
        });

        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/ai-config/test
 * 测试"未保存"的表单配置（新增/编辑弹窗里点"测试连接"用，保存前即可验证）
 *
 * 请求体：{ base_url, model, api_key?, timeout?, config_id? }
 *   - api_key 留空且传了 config_id：复用该条已保存配置的 Key（编辑时不想重输 Key 的场景）
 *   - 不写库、不记 AdminLog（尚未落库的草稿没有可审计的对象）
 * 与 /:id/test 一样永不返回 5xx，失败时返回详细原因
 */
router.post('/test', auth, adminCheck, async (req, res, next) => {
    try {
        const { base_url, model, api_key, timeout, config_id } = req.body;

        // 表单未填 Key 且指定了已保存配置 → 复用该配置的 Key（仅在内存中解密，不回传）
        let apiKey = api_key || '';
        if (!apiKey && config_id) {
            const saved = await AiConfig.findByPk(config_id);
            if (!saved) {
                throw new AppError('config_id 对应的 AI 配置不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (saved.encrypted_api_key) {
                try {
                    apiKey = cryptoHelper.decrypt(saved.encrypted_api_key);
                } catch (e) {
                    throw new AppError(`已保存的 API Key 解密失败：${e.message}（请直接输入新 Key 测试）`, 400, ErrorCodes.CONFIG_ERROR);
                }
            }
        }

        const result = await runAiConnectivityTest({ baseUrl: base_url, model, apiKey, timeout });

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
