/**
 * 公告配图配置路由（GM）
 *
 * 为什么单独开一个：announcement_upload.json 是运维阈值 + 安全白名单的合集。
 * 原先改它只能 SSH 上机改文件再重启，而"单张图上限""一次能几张图""多久回收孤儿图"
 * 恰恰是运营过程中最常被改的那几个数 —— 走后台界面改完即刻热更，不必动进程。
 *
 * 接口列表：
 *   GET  /api/admin/announcement/config  查看当前配置（含哪些字段可改、哪些锁死）
 *   POST /api/admin/announcement/config  局部更新白名单内字段（校验→备份→落盘→热更→日志）
 *
 * 模式沿用 routes/admin_cultivation.js：先备份原文件到 config/backup，写盘成功再
 * 调 ConfigLoader.hotUpdateConfig，任何一步失败都不留下"改了一半"的配置。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const configLoader = infrastructure.ConfigLoader;
const CONFIG_FILE = path.join(__dirname, '../config/announcement_upload.json');
const BACKUP_DIR = path.join(__dirname, '../config/backup');
const CONFIG_NAME = 'announcement_upload';

/**
 * 可改字段白名单：key 是"点分路径"，value 是校验规则
 *
 * 刻意不含 storage_dir 与 url_prefix：
 *   storage_dir 决定了 express.static 的根（在 index.js 挂载那一刻就固定了）；
 *   url_prefix 一旦改动，历史公告里已写入的 URL 立刻全部 404。
 * 这两个属于"换部署形态"级别的操作，必须停机改，不能在运行菜单里点到。
 */
const EDITABLE_FIELDS = {
    'upload.max_file_size_bytes': { min: 100 * 1024, max: 20 * 1024 * 1024 },
    'upload.max_images_per_announcement': { min: 1, max: 9 },
    'upload.delete_file_when_notification_removed': { type: 'boolean' },
    'static.max_age_ms': { min: 0, max: 365 * 24 * 3600 * 1000 },
    'cleanup.enabled': { type: 'boolean' },
    'cleanup.interval_ms': { min: 60000, max: 24 * 3600 * 1000 },
    'cleanup.retention_hours': { min: 1, max: 720 },
    'batch_delete.max_ids_per_request': { min: 1, max: 1000 }
};

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
 * 备份配置文件（带时间戳）
 * @param {string} filePath
 * @returns {string|null} 备份路径
 */
function backupConfigFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
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
 * 按规则校验一个待写入的值
 * @param {string} key - 点分路径
 * @param {*} value - 待校验值
 * @returns {*} 归一化后的值
 */
function validateField(key, value) {
    const rule = EDITABLE_FIELDS[key];
    if (!rule) {
        throw new AppError(`字段 ${key} 不允许修改`, 400, ErrorCodes.VALIDATION_ERROR);
    }

    if (rule.type === 'boolean') {
        if (typeof value !== 'boolean') {
            throw new AppError(`字段 ${key} 必须是布尔值`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        return value;
    }

    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw new AppError(`字段 ${key} 必须是整数`, 400, ErrorCodes.VALIDATION_ERROR);
    }
    if (num < rule.min || num > rule.max) {
        throw new AppError(
            `字段 ${key} 必须在 ${rule.min} ~ ${rule.max} 之间`,
            400,
            ErrorCodes.VALIDATION_ERROR
        );
    }
    return num;
}

/**
 * 读取当前配置（带"哪些字段可改"的元信息，前端据此渲染表单）
 * GET /api/admin/announcement/config
 */
router.get('/config', auth, adminCheck, async (req, res, next) => {
    try {
        const config = configLoader.getConfig(CONFIG_NAME);
        res.json({
            code: 200,
            data: {
                config,
                editable_fields: Object.keys(EDITABLE_FIELDS),
                locked_fields: [
                    'upload.storage_dir（静态目录在启动时挂载，改了要重启）',
                    'upload.url_prefix（改动会让历史公告里的图片地址全部失效）',
                    'upload.allowed_types（安全白名单，改动前需代码评审）'
                ]
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 局部更新配置并热加载
 * POST /api/admin/announcement/config
 *
 * 请求体：{ "upload.max_file_size_bytes": 8388608, "cleanup.enabled": true, ... }
 * 传几个改几个，其余保持原值。
 */
router.post('/config', auth, adminCheck, async (req, res, next) => {
    try {
        const payload = req.body || {};
        const keys = Object.keys(payload);

        if (keys.length === 0) {
            throw new AppError('未提供任何待修改字段', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const oldConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        const newConfig = JSON.parse(JSON.stringify(oldConfig));
        const changes = {};

        for (const key of keys) {
            const value = validateField(key, payload[key]);
            const segments = key.split('.');

            // 逐级下钻：最后一段才是要赋值的叶子
            let cursor = newConfig;
            for (const segment of segments.slice(0, -1)) {
                if (!cursor[segment] || typeof cursor[segment] !== 'object') {
                    cursor[segment] = {};
                }
                cursor = cursor[segment];
            }
            cursor[segments[segments.length - 1]] = value;

            // 旧值取出来写进日志：事后要知道"之前是多少"才谈得上回滚
            let oldCursor = oldConfig;
            for (const segment of segments.slice(0, -1)) {
                oldCursor = oldCursor?.[segment];
            }
            changes[key] = {
                before: oldCursor?.[segments[segments.length - 1]],
                after: value
            };
        }

        const backupPath = backupConfigFile(CONFIG_FILE);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');

        // 落盘之后再换内存里的那份：中途失败（比如 JSON 被改坏）至少磁盘上还是老配置
        await configLoader.hotUpdateConfig(CONFIG_NAME);

        await logAdminAction(req.player.id, 'update_announcement_config', {
            target: 'announcement_upload.json',
            backup: backupPath,
            changes
        }, req);

        res.json({
            code: 200,
            message: '公告配图配置已更新并热加载',
            data: { changes, config: newConfig }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
