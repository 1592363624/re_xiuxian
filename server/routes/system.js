/**
 * 系统配置路由
 * 提供公开的系统配置查询接口
 * 修复：统一从 system 配置读取（原误用 system_config）、GitHub URL/缓存时长/白名单均从配置读取
 */
const express = require('express');
const router = express.Router();
const SystemConfig = require('../models/system_config');
const Player = require('../models/player');
const authenticateToken = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const { Op } = require('sequelize');
const axios = require('axios');

// 通过 ConfigLoader 获取配置（懒加载，避免模块加载时配置未初始化）
const configLoader = infrastructure.ConfigLoader;
function getSystemConfig() {
    try {
        return configLoader.getConfig('system') || { settings: {} };
    } catch (err) {
        console.warn('[system] 加载 system 配置失败，使用空对象:', err.message);
        return { settings: {} };
    }
}

// 懒加载 game_balance 用于在线阈值
function getAuthConfig() {
    return configLoader.getConfig('game_balance')?.auth || {};
}

// 更新日志缓存（内存级，仅当前进程有效）
let changelogCache = null;
let lastCacheTime = 0;

/**
 * 获取 GitHub 更新日志
 * GitHub URL、User-Agent、缓存时长均从 system 配置读取，避免硬编码
 */
router.get('/changelog', async (req, res, next) => {
    try {
        const now = Date.now();
        const systemSettings = getSystemConfig().settings || {};
        const cacheDuration = systemSettings.changelog_cache_duration_ms?.value ?? 600000;

        if (changelogCache && (now - lastCacheTime < cacheDuration)) {
            return res.json(changelogCache);
        }

        const githubUrl = systemSettings.github_api_url?.value || 'https://api.github.com/repos/1592363624/re_xiuxian/commits';
        const userAgent = systemSettings.github_user_agent?.value || 're_xiuxian-game';

        const response = await axios.get(githubUrl, {
            params: { per_page: 30 },
            headers: { 'User-Agent': userAgent }
        });

        // 格式化数据
        const commits = response.data.map(commit => ({
            sha: commit.sha,
            message: commit.commit.message,
            date: commit.commit.author.date,
            author: commit.commit.author.name,
            url: commit.html_url
        }));

        changelogCache = commits;
        lastCacheTime = now;

        res.json({
            code: 200,
            data: commits
        });
    } catch (error) {
        console.error('获取GitHub提交记录失败:', error.message);
        // 如果有缓存，即使过期也返回
        if (changelogCache) {
            return res.json({
                code: 200,
                data: changelogCache
            });
        }
        next(new AppError('获取更新日志失败', 500, ErrorCodes.INTERNAL_ERROR));
    }
});

/**
 * 获取服务器统计信息
 */
router.get('/stats', async (req, res, next) => {
    try {
        const totalPlayers = await Player.count();

        // 优先使用 Socket.IO 在线用户数，如果没有则回退到基于 last_online 的统计
        const onlineUsersMap = req.app.get('onlineUsers');
        let onlinePlayers = 0;

        if (onlineUsersMap && onlineUsersMap.size > 0) {
            onlinePlayers = onlineUsersMap.size;
        } else {
            // 回退方案：在线阈值从配置读取，避免硬编码
            const thresholdMinutes = getAuthConfig().online_threshold_minutes ?? 5;
            const thresholdAgo = new Date(Date.now() - thresholdMinutes * 60 * 1000);
            onlinePlayers = await Player.count({
                where: {
                    last_online: {
                        [Op.gte]: thresholdAgo
                    }
                }
            });
        }

        res.json({
            code: 200,
            data: {
                online: Math.max(1, onlinePlayers),
                total: totalPlayers,
                serverTime: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('获取统计信息失败:', error);
        next(new AppError('获取统计信息失败', 500, ErrorCodes.INTERNAL_ERROR));
    }
});

/**
 * 获取公开系统配置 (需要登录)
 * 修复：使用白名单过滤，避免敏感配置（如内部 URL、阈值）泄露给客户端
 */
router.get('/config', authenticateToken, async (req, res, next) => {
    try {
        const systemSettings = getSystemConfig().settings || {};
        // 白名单从配置读取，未配置时仅返回 auto_save_interval
        const allowedKeys = systemSettings.client_config_keys?.value || ['auto_save_interval'];

        const configs = await SystemConfig.findAll();
        const configMap = {};

        // 仅下发白名单中的配置键，其他配置保留在服务端不暴露
        configs.forEach(c => {
            if (allowedKeys.includes(c.key)) {
                // 尝试解析 JSON 值，如果是数字字符串则转为数字
                try {
                    const num = Number(c.value);
                    configMap[c.key] = isNaN(num) ? JSON.parse(c.value) : num;
                } catch (e) {
                    configMap[c.key] = c.value;
                }
            }
        });

        res.json({
            code: 200,
            data: configMap
        });
    } catch (error) {
        console.error('获取系统配置失败:', error);
        next(new AppError('获取系统配置失败', 500, ErrorCodes.INTERNAL_ERROR));
    }
});

module.exports = router;
