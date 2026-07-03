/**
 * 修炼配置管理路由（管理员专用）
 *
 * 用途：
 *   - 提供 GM 后台对闭关（常规/深度）与历练（时长分级）参数的可视化编辑入口
 *   - 修改后自动写回 JSON 配置文件并触发热更新，无需重启服务
 *   - 全程双层权限校验（auth + adminCheck）+ 操作日志审计
 *
 * 涉及的配置文件：
 *   - server/config/seclusion.json（闭关双模式配置）
 *   - server/config/game_balance.json 的 adventure 段（历练配置）
 *
 * 安全设计：
 *   - API Key 不在此路由涉及（仅数值参数）
 *   - 字段白名单：仅允许预定义字段被更新，防止越权写入
 *   - 数值范围校验：所有数值参数均限定合理区间，避免恶意写入异常值
 *   - 操作日志：所有修改操作记录到 AdminLog，含修改前后值
 *   - 配置备份：写文件前先备份原配置到 server/config/backup/ 目录
 *
 * 接口列表：
 *   GET    /api/admin/cultivation/config    获取闭关+历练配置
 *   POST   /api/admin/cultivation/seclusion 更新闭关配置（双模式整体替换）
 *   POST   /api/admin/cultivation/adventure 更新历练配置（时长分级整体替换）
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
// 引入 WebSocket 通知服务，用于配置变更时推送全服广播
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');

// 配置文件路径
const SECLUSION_CONFIG_FILE = path.join(__dirname, '../config/seclusion.json');
const GAME_BALANCE_CONFIG_FILE = path.join(__dirname, '../config/game_balance.json');
const BACKUP_DIR = path.join(__dirname, '../config/backup');

// 字段白名单与数值范围定义
const NORMAL_SECLUSION_FIELDS = ['max_duration', 'daily_limit', 'cooldown', 'exp_rate'];
const DEEP_SECLUSION_FIELDS = ['min_duration', 'max_duration', 'daily_limit', 'cooldown', 'exp_rate', 'min_realm', 'forced_penalty'];
const DURATION_TYPE_FIELDS = ['duration', 'reward_multiplier', 'injury_chance', 'injury_hp_loss_rate', 'label'];
const VALID_DURATION_TYPES = ['short', 'medium', 'long'];

/**
 * 管理员权限中间件
 * 复用项目统一的 adminCheck 模式（与 admin.js/admin_ai.js/admin_sect.js 一致）
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
 * @param {number} adminId - 管理员玩家ID
 * @param {string} action - 操作类型
 * @param {object} details - 操作详情（含修改前后值）
 * @param {object} req - 请求对象（用于获取IP）
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
 * 备份配置文件到 backup 目录（带时间戳）
 * @param {string} filePath - 原配置文件路径
 * @returns {string|null} 备份文件路径，失败返回 null
 */
function backupConfigFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        // 确保 backup 目录存在
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        const basename = path.basename(filePath, '.json');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `${basename}_${timestamp}.json`);
        fs.copyFileSync(filePath, backupPath);
        return backupPath;
    } catch (err) {
        console.error(`备份配置文件失败 ${filePath}:`, err);
        return null;
    }
}

/**
 * 数值范围校验工具
 * @param {any} value - 待校验值
 * @param {object} rule - 校验规则 { min, max, type }
 * @returns {boolean} 是否通过
 */
function validateNumber(value, rule) {
    const num = Number(value);
    if (isNaN(num)) return false;
    if (rule.type === 'integer' && !Number.isInteger(num)) return false;
    if (rule.min !== undefined && num < rule.min) return false;
    if (rule.max !== undefined && num > rule.max) return false;
    return true;
}

/**
 * 校验常规闭关参数
 * @param {object} normal - 常规闭关配置对象
 * @throws {AppError} 校验失败时抛出业务错误
 */
function validateNormalSeclusion(normal) {
    if (!normal || typeof normal !== 'object') {
        throw new AppError('常规闭关配置格式错误', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(normal.max_duration, { min: 60, max: 7200, type: 'integer' })) {
        throw new AppError('常规闭关单次时长必须在 60-7200 秒之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(normal.daily_limit, { min: 1, max: 100, type: 'integer' })) {
        throw new AppError('常规闭关每日次数必须在 1-100 次之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(normal.cooldown, { min: 0, max: 86400, type: 'integer' })) {
        throw new AppError('常规闭关冷却时间必须在 0-86400 秒之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(normal.exp_rate, { min: 0.1, max: 100 })) {
        throw new AppError('常规闭关收益倍率必须在 0.1-100 之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
}

/**
 * 校验深度闭关参数
 * @param {object} deep - 深度闭关配置对象
 * @throws {AppError} 校验失败时抛出业务错误
 */
function validateDeepSeclusion(deep) {
    if (!deep || typeof deep !== 'object') {
        throw new AppError('深度闭关配置格式错误', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.min_duration, { min: 600, max: 86400, type: 'integer' })) {
        throw new AppError('深度闭关最短时长必须在 600-86400 秒之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.max_duration, { min: 600, max: 172800, type: 'integer' })) {
        throw new AppError('深度闭关最长时长必须在 600-172800 秒之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (deep.min_duration > deep.max_duration) {
        throw new AppError('深度闭关最短时长不能大于最长时长', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.daily_limit, { min: 1, max: 50, type: 'integer' })) {
        throw new AppError('深度闭关每日次数必须在 1-50 次之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.cooldown, { min: 0, max: 172800, type: 'integer' })) {
        throw new AppError('深度闭关冷却时间必须在 0-172800 秒之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.exp_rate, { min: 0.1, max: 100 })) {
        throw new AppError('深度闭关收益倍率必须在 0.1-100 之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!deep.min_realm || typeof deep.min_realm !== 'string') {
        throw new AppError('深度闭关境界要求必须是字符串', 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (!validateNumber(deep.forced_penalty, { min: 0, max: 1 })) {
        throw new AppError('深度闭关强行出关损失比例必须在 0-1 之间', 400, ErrorCodes.VALIDATION_ERROR);
    }
}

/**
 * 校验历练时长分级参数
 * @param {object} durationTypes - 时长分级配置 { short, medium, long }
 * @throws {AppError} 校验失败时抛出业务错误
 */
function validateDurationTypes(durationTypes) {
    if (!durationTypes || typeof durationTypes !== 'object') {
        throw new AppError('历练时长分级配置格式错误', 400, ErrorCodes.VALIDATION_ERROR);
    }
    for (const type of VALID_DURATION_TYPES) {
        const cfg = durationTypes[type];
        if (!cfg || typeof cfg !== 'object') {
            throw new AppError(`历练时长分级 ${type} 配置缺失或格式错误`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!validateNumber(cfg.duration, { min: 10, max: 3600, type: 'integer' })) {
            throw new AppError(`历练 ${type} 时长必须在 10-3600 秒之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!validateNumber(cfg.reward_multiplier, { min: 0.1, max: 10 })) {
            throw new AppError(`历练 ${type} 奖励倍率必须在 0.1-10 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!validateNumber(cfg.injury_chance, { min: 0, max: 1 })) {
            throw new AppError(`历练 ${type} 受伤概率必须在 0-1 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!validateNumber(cfg.injury_hp_loss_rate, { min: 0, max: 1 })) {
            throw new AppError(`历练 ${type} 气血损失比例必须在 0-1 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!cfg.label || typeof cfg.label !== 'string') {
            throw new AppError(`历练 ${type} 标签必须是字符串`, 400, ErrorCodes.VALIDATION_ERROR);
        }
    }
}

/**
 * 过滤字段白名单（防止越权写入）
 * @param {object} data - 原始数据
 * @param {string[]} allowedFields - 允许的字段列表
 * @returns {object} 过滤后的数据
 */
function filterFields(data, allowedFields) {
    const filtered = {};
    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            filtered[field] = data[field];
        }
    }
    return filtered;
}

/**
 * GET /api/admin/cultivation/config
 * 获取修炼配置（闭关双模式 + 历练时长分级）
 */
router.get('/config', auth, adminCheck, async (req, res, next) => {
    try {
        const seclusionConfig = configLoader.getConfig('seclusion');
        const gameBalanceConfig = configLoader.getConfig('game_balance');

        // 整理闭关配置（合并兼容字段，统一返回结构）
        const seclusionSettings = seclusionConfig?.settings || {};
        const normalSeclusion = seclusionSettings.normal_seclusion?.value || {
            max_duration: 1800, daily_limit: 3, cooldown: 300, exp_rate: 1
        };
        const deepSeclusion = seclusionSettings.deep_seclusion?.value || {
            min_duration: 14400, max_duration: 28800, daily_limit: 1, cooldown: 3600,
            exp_rate: 2, min_realm: '筑基期', forced_penalty: 0.5
        };
        const baseExpRate = seclusionSettings.seclusion_exp_rate?.value ?? 1;

        // 整理历练配置
        const adventureConfig = gameBalanceConfig?.adventure || {};

        res.json({
            code: 200,
            data: {
                seclusion: {
                    base_exp_rate: baseExpRate,
                    normal: normalSeclusion,
                    deep: deepSeclusion
                },
                adventure: {
                    duration_types: adventureConfig.duration_types || {},
                    default_duration_type: adventureConfig.default_duration_type || 'medium',
                    early_finish_penalty: adventureConfig.early_finish_penalty ?? 0.5
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/cultivation/seclusion
 * 更新闭关配置（双模式整体替换）
 *
 * 入参：
 *   { normal: {...}, deep: {...}, base_exp_rate: number }
 */
router.post('/seclusion', auth, adminCheck, async (req, res, next) => {
    try {
        const { normal, deep, base_exp_rate } = req.body || {};

        // 校验入参完整性
        if (!normal && !deep && base_exp_rate === undefined) {
            throw new AppError('请至少提供 normal、deep 或 base_exp_rate 中的一个字段', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 读取现有配置（先读取，便于合并后再校验，支持部分更新）
        const oldConfig = JSON.parse(fs.readFileSync(SECLUSION_CONFIG_FILE, 'utf-8'));

        // 字段白名单过滤
        const filteredNormal = normal ? filterFields(normal, NORMAL_SECLUSION_FIELDS) : null;
        const filteredDeep = deep ? filterFields(deep, DEEP_SECLUSION_FIELDS) : null;

        // 合并现有值后再校验，确保部分更新时仍满足完整性约束
        if (filteredNormal) {
            const merged = { ...oldConfig.settings.normal_seclusion.value, ...filteredNormal };
            validateNormalSeclusion(merged);
        }
        if (filteredDeep) {
            const merged = { ...oldConfig.settings.deep_seclusion.value, ...filteredDeep };
            validateDeepSeclusion(merged);
        }
        if (base_exp_rate !== undefined && !validateNumber(base_exp_rate, { min: 0.1, max: 100 })) {
            throw new AppError('闭关基础修为速率必须在 0.1-100 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const newConfig = JSON.parse(JSON.stringify(oldConfig)); // 深拷贝避免污染

        // 应用更新（仅更新提供的字段）
        if (filteredNormal) {
            newConfig.settings.normal_seclusion.value = {
                ...newConfig.settings.normal_seclusion.value,
                ...filteredNormal
            };
        }
        if (filteredDeep) {
            newConfig.settings.deep_seclusion.value = {
                ...newConfig.settings.deep_seclusion.value,
                ...filteredDeep
            };
        }
        if (base_exp_rate !== undefined) {
            newConfig.settings.seclusion_exp_rate.value = base_exp_rate;
        }
        newConfig.lastUpdated = new Date().toISOString();

        // 备份原配置
        const backupPath = backupConfigFile(SECLUSION_CONFIG_FILE);

        // 写入新配置
        fs.writeFileSync(SECLUSION_CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');

        // 触发热更新
        await configLoader.hotUpdateConfig('seclusion');

        // 通过 Socket.IO 推送全服通知，告知玩家修炼参数已调整
        // 避免玩家产生"为何收益变了"的困惑
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '修炼系统调整',
                content: '管理员已调整闭关参数（常规/深度），新配置已即时生效。如闭关冷却、收益倍率等可能发生变化，请留意。',
                priority: 'info'
            });
        } catch (notifyErr) {
            console.warn('推送修炼配置变更通知失败（不影响主流程）:', notifyErr.message);
        }

        // 记录操作日志（含修改前后值）
        await logAdminAction(req.player.id, 'update_cultivation_seclusion', {
            target: 'seclusion.json',
            before: {
                normal: oldConfig.settings.normal_seclusion?.value,
                deep: oldConfig.settings.deep_seclusion?.value,
                base_exp_rate: oldConfig.settings.seclusion_exp_rate?.value
            },
            after: {
                normal: newConfig.settings.normal_seclusion.value,
                deep: newConfig.settings.deep_seclusion.value,
                base_exp_rate: newConfig.settings.seclusion_exp_rate.value
            },
            backup: backupPath
        }, req);

        res.json({
            code: 200,
            message: '闭关配置已更新并热加载',
            data: {
                normal: newConfig.settings.normal_seclusion.value,
                deep: newConfig.settings.deep_seclusion.value,
                base_exp_rate: newConfig.settings.seclusion_exp_rate.value,
                backup: backupPath
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/cultivation/adventure
 * 更新历练配置（时长分级整体替换）
 *
 * 入参：
 *   { duration_types: { short, medium, long }, default_duration_type, early_finish_penalty }
 */
router.post('/adventure', auth, adminCheck, async (req, res, next) => {
    try {
        const { duration_types, default_duration_type, early_finish_penalty } = req.body || {};

        // 校验入参完整性
        if (!duration_types && !default_duration_type && early_finish_penalty === undefined) {
            throw new AppError('请至少提供 duration_types、default_duration_type 或 early_finish_penalty 中的一个字段', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验默认时长类型
        if (default_duration_type && !VALID_DURATION_TYPES.includes(default_duration_type)) {
            throw new AppError(`默认时长类型必须是 ${VALID_DURATION_TYPES.join('/')} 之一`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验提前结束惩罚
        if (early_finish_penalty !== undefined && !validateNumber(early_finish_penalty, { min: 0, max: 1 })) {
            throw new AppError('提前结束惩罚比例必须在 0-1 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验时长分级
        if (duration_types) {
            // 读取现有配置（用于合并后再校验，支持部分更新）
            const existingGameBalance = JSON.parse(fs.readFileSync(GAME_BALANCE_CONFIG_FILE, 'utf-8'));
            const existingDurationTypes = existingGameBalance.adventure?.duration_types || {};
            // 字段白名单过滤每个时长类型
            const filteredDurationTypes = {};
            for (const type of VALID_DURATION_TYPES) {
                if (duration_types[type]) {
                    filteredDurationTypes[type] = filterFields(duration_types[type], DURATION_TYPE_FIELDS);
                }
            }
            // 合并现有值后再校验，确保部分更新时仍满足完整性约束
            const mergedDurationTypes = {};
            for (const type of VALID_DURATION_TYPES) {
                mergedDurationTypes[type] = {
                    ...existingDurationTypes[type],
                    ...filteredDurationTypes[type]
                };
            }
            validateDurationTypes(mergedDurationTypes);
        }

        // 读取现有配置
        const oldConfig = JSON.parse(fs.readFileSync(GAME_BALANCE_CONFIG_FILE, 'utf-8'));
        const newConfig = JSON.parse(JSON.stringify(oldConfig));
        const oldAdventure = newConfig.adventure || {};

        // 应用更新
        if (duration_types) {
            // 字段白名单过滤后合并
            const filteredDurationTypes = {};
            for (const type of VALID_DURATION_TYPES) {
                if (duration_types[type]) {
                    filteredDurationTypes[type] = filterFields(duration_types[type], DURATION_TYPE_FIELDS);
                }
            }
            oldAdventure.duration_types = {
                ...oldAdventure.duration_types,
                ...filteredDurationTypes
            };
        }
        if (default_duration_type) {
            oldAdventure.default_duration_type = default_duration_type;
        }
        if (early_finish_penalty !== undefined) {
            oldAdventure.early_finish_penalty = early_finish_penalty;
        }
        newConfig.adventure = oldAdventure;

        // 备份原配置
        const backupPath = backupConfigFile(GAME_BALANCE_CONFIG_FILE);

        // 写入新配置
        fs.writeFileSync(GAME_BALANCE_CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');

        // 触发热更新
        await configLoader.hotUpdateConfig('game_balance');

        // 通过 Socket.IO 推送全服通知，告知玩家历练参数已调整
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '历练系统调整',
                content: '管理员已调整历练参数（时长分级/奖励倍率/受伤风险），新配置已即时生效。如历练时长、奖励、风险等可能发生变化，请留意。',
                priority: 'info'
            });
        } catch (notifyErr) {
            console.warn('推送历练配置变更通知失败（不影响主流程）:', notifyErr.message);
        }

        // 记录操作日志
        await logAdminAction(req.player.id, 'update_cultivation_adventure', {
            target: 'game_balance.json',
            before: oldConfig.adventure,
            after: newConfig.adventure,
            backup: backupPath
        }, req);

        res.json({
            code: 200,
            message: '历练配置已更新并热加载',
            data: {
                adventure: newConfig.adventure,
                backup: backupPath
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/cultivation/backups
 * 获取配置历史版本列表
 *
 * 查询参数：
 *   ?type=seclusion|game_balance  不传则返回全部
 *
 * 返回结构：
 *   [{ filename, configType, size, mtime, mtimeMs }]
 *
 * 安全设计：
 *   - 仅列出 backup 目录下的文件，路径不可越权
 *   - 仅返回 .json 文件，过滤其他类型
 *   - 文件名前缀必须是 seclusion_ 或 game_balance_，防止读取其他配置备份
 */
router.get('/backups', auth, adminCheck, async (req, res, next) => {
    try {
        // 确保 backup 目录存在
        if (!fs.existsSync(BACKUP_DIR)) {
            return res.json({ code: 200, data: [] });
        }

        // 读取 backup 目录下所有文件
        const files = fs.readdirSync(BACKUP_DIR);
        const { type } = req.query;

        // 过滤：仅 .json 文件 + 前缀匹配（seclusion_ 或 game_balance_）
        const validPrefixes = ['seclusion_', 'game_balance_'];
        const backupList = [];

        for (const filename of files) {
            // 安全校验：仅处理 .json 后缀
            if (!filename.endsWith('.json')) continue;
            // 安全校验：前缀必须是允许的两个之一
            const matchedPrefix = validPrefixes.find(p => filename.startsWith(p));
            if (!matchedPrefix) continue;

            // 解析配置类型
            const configType = matchedPrefix === 'seclusion_' ? 'seclusion' : 'game_balance';

            // 按类型筛选（如果指定了 type）
            if (type && type !== configType) continue;

            // 读取文件元数据
            const filePath = path.join(BACKUP_DIR, filename);
            const stat = fs.statSync(filePath);

            backupList.push({
                filename,
                configType,
                // 中文友好名称
                configLabel: configType === 'seclusion' ? '闭关配置' : '游戏平衡（含历练）',
                size: stat.size,
                // 文件大小（人类可读）
                sizeText: formatFileSize(stat.size),
                // 修改时间（ISO 字符串，便于前端直接展示）
                mtime: stat.mtime.toISOString(),
                // 修改时间戳（毫秒，用于排序）
                mtimeMs: stat.mtimeMs
            });
        }

        // 按修改时间倒序（最新的在前）
        backupList.sort((a, b) => b.mtimeMs - a.mtimeMs);

        res.json({
            code: 200,
            data: backupList
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/cultivation/rollback
 * 一键回滚到指定历史版本
 *
 * 入参：
 *   { filename: string }  备份文件名（不含路径，安全限制）
 *
 * 安全设计：
 *   - filename 仅允许字母数字下划线横线点，防止路径穿越攻击
 *   - 回滚前自动备份当前版本（形成回滚链，避免误操作不可逆）
 *   - 回滚后触发热加载，记录操作日志
 *   - 推送全服通知告知玩家配置已回滚
 */
router.post('/rollback', auth, adminCheck, async (req, res, next) => {
    try {
        const { filename } = req.body || {};
        if (!filename || typeof filename !== 'string') {
            throw new AppError('请提供要回滚的备份文件名 filename', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 安全校验：filename 仅允许字母数字下划线横线点，防止路径穿越攻击
        if (!/^[a-zA-Z0-9_\-\.]+\.json$/.test(filename)) {
            throw new AppError('备份文件名格式不合法', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 安全校验：前缀必须是 seclusion_ 或 game_balance_
        const isSeclusion = filename.startsWith('seclusion_');
        const isGameBalance = filename.startsWith('game_balance_');
        if (!isSeclusion && !isGameBalance) {
            throw new AppError('仅支持回滚 seclusion 或 game_balance 的备份', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 解析目标配置类型与对应的配置文件路径
        const configType = isSeclusion ? 'seclusion' : 'game_balance';
        const targetConfigFile = isSeclusion ? SECLUSION_CONFIG_FILE : GAME_BALANCE_CONFIG_FILE;
        const backupFilePath = path.join(BACKUP_DIR, filename);

        // 校验备份文件存在
        if (!fs.existsSync(backupFilePath)) {
            throw new AppError(`备份文件 ${filename} 不存在`, 404, ErrorCodes.NOT_FOUND);
        }

        // 读取备份文件内容（作为回滚源）
        const backupContent = fs.readFileSync(backupFilePath, 'utf-8');
        let backupConfig;
        try {
            backupConfig = JSON.parse(backupContent);
        } catch (e) {
            throw new AppError(`备份文件 ${filename} JSON 格式损坏，无法回滚`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 读取当前配置（作为回滚前的快照）
        const currentConfigRaw = fs.readFileSync(targetConfigFile, 'utf-8');
        const currentConfig = JSON.parse(currentConfigRaw);

        // 回滚前先备份当前版本（形成回滚链，避免误操作不可逆）
        const preRollbackBackupPath = backupConfigFile(targetConfigFile);

        // 用备份文件覆盖当前配置
        fs.writeFileSync(targetConfigFile, backupContent, 'utf-8');

        // 触发热加载
        await configLoader.hotUpdateConfig(configType);

        // 通过 Socket.IO 推送全服通知
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '修炼系统回滚',
                content: `管理员已将${configType === 'seclusion' ? '闭关' : '历练'}配置回滚至历史版本，新配置已即时生效。`,
                priority: 'info'
            });
        } catch (notifyErr) {
            console.warn('推送配置回滚通知失败（不影响主流程）:', notifyErr.message);
        }

        // 记录操作日志
        await logAdminAction(req.player.id, 'rollback_cultivation_config', {
            target: `${configType}.json`,
            rollbackFrom: filename,
            rollbackTo: 'current (pre-rollback)',
            preRollbackBackup: preRollbackBackupPath,
            before: currentConfig,
            after: backupConfig
        }, req);

        res.json({
            code: 200,
            message: `已回滚至 ${filename}，配置已热加载`,
            data: {
                configType,
                rollbackFrom: filename,
                preRollbackBackup: preRollbackBackupPath
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 格式化文件大小（人类可读）
 * @param {number} bytes - 字节数
 * @returns {string} 如 "1.2 KB"
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 递归对比 before/after 对象，提取所有叶子节点的变化
 *
 * 业务计算放后端的核心体现：前端只负责渲染，不再做 diff 算法
 *
 * @param {object} beforeObj - 修改前对象
 * @param {object} afterObj - 修改后对象
 * @param {string} prefix - 字段路径前缀（用于嵌套对象，如 "normal.max_duration"）
 * @returns {Array<{path: string, before: any, after: any, changeType: string}>}
 *          字段变化列表，changeType: added | removed | modified
 */
function computeDiff(beforeObj, afterObj, prefix = '') {
    const fields = [];
    // 收集所有 key（before 和 after 的并集）
    const allKeys = new Set([
        ...Object.keys(beforeObj || {}),
        ...Object.keys(afterObj || {})
    ]);

    for (const key of allKeys) {
        const path = prefix ? `${prefix}.${key}` : key;
        const beforeVal = beforeObj?.[key];
        const afterVal = afterObj?.[key];

        // 两者都是对象（非 null、非数组），递归
        if (
            beforeVal && typeof beforeVal === 'object' && !Array.isArray(beforeVal) &&
            afterVal && typeof afterVal === 'object' && !Array.isArray(afterVal)
        ) {
            fields.push(...computeDiff(beforeVal, afterVal, path));
        } else {
            // 叶子节点，对比值
            let changeType = 'unchanged';
            if (beforeVal === undefined) changeType = 'added';
            else if (afterVal === undefined) changeType = 'removed';
            else if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) changeType = 'modified';

            // 只展示有变化的字段（避免表格过长）
            if (changeType !== 'unchanged') {
                fields.push({ path, before: beforeVal, after: afterVal, changeType });
            }
        }
    }
    return fields;
}

/**
 * GET /api/admin/cultivation/logs/:logId/diff
 * 获取指定操作日志的字段级 diff（后端权威计算）
 *
 * 业务计算放后端的设计目的：
 *   - 防止前端伪造 diff 结果（如篡改 before/after 值）
 *   - 统一 diff 算法实现，避免前端版本漂移
 *   - 前端只负责渲染返回的 fields 数组
 *
 * 路径参数：
 *   logId - AdminLog 主键 ID
 *
 * 返回结构：
 *   { code, data: { target, backup, fields: [{path, before, after, changeType}] } }
 */
router.get('/logs/:logId/diff', auth, adminCheck, async (req, res, next) => {
    try {
        const { logId } = req.params;
        // 校验 logId 为正整数
        const logIdNum = parseInt(logId, 10);
        if (isNaN(logIdNum) || logIdNum <= 0) {
            throw new AppError('日志ID必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询日志记录
        const log = await AdminLog.findByPk(logIdNum);
        if (!log) {
            throw new AppError(`日志 ${logId} 不存在`, 404, ErrorCodes.NOT_FOUND);
        }

        // 仅允许修炼配置变更类日志查看 diff，避免越权获取其他日志的解析结果
        const allowedActions = [
            'update_cultivation_seclusion',
            'update_cultivation_adventure',
            'rollback_cultivation_config'
        ];
        if (!allowedActions.includes(log.action)) {
            throw new AppError(
                `该日志类型 "${log.action}" 不支持 diff 查看，仅修炼配置变更日志可查看`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 解析 details JSON
        let parsed;
        try {
            parsed = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
        } catch (e) {
            throw new AppError(
                `日志 ${logId} 的 details JSON 解析失败：${e.message}`,
                500,
                ErrorCodes.INTERNAL_ERROR
            );
        }

        if (!parsed || typeof parsed !== 'object') {
            throw new AppError(
                `日志 ${logId} 的 details 格式异常`,
                500,
                ErrorCodes.INTERNAL_ERROR
            );
        }

        // 提取 before/after，回滚类日志可能字段名为 rollbackFrom/rollbackTo，
        // 但同样有 before/after 字段（参见 rollback 接口的 logAdminAction 调用）
        const before = parsed.before || {};
        const after = parsed.after || {};

        // 后端权威 diff 计算
        const fields = computeDiff(before, after);

        res.json({
            code: 200,
            data: {
                target: parsed.target || '',
                backup: parsed.backup || parsed.preRollbackBackup || '',
                fields,
                // 附带日志元数据，便于前端展示
                meta: {
                    logId: log.id,
                    action: log.action,
                    adminId: log.admin_id,
                    createdAt: log.createdAt,
                    ip: log.ip
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
