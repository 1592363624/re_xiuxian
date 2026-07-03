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

module.exports = router;
