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

// 更新日志缓存：内存一份（快），磁盘一份（重启后还在）
let changelogCache = null;
let lastCacheTime = 0;
const CHANGELOG_CACHE_FILE = () => require('os').tmpdir() + require('path').sep + 're_xiuxian_changelog_cache.json';

function readChangelogDiskCache() {
    try {
        const raw = require('fs').readFileSync(CHANGELOG_CACHE_FILE(), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;                 // 没有缓存文件是正常情况
    }
}

function writeChangelogDiskCache(commits) {
    try {
        require('fs').writeFileSync(CHANGELOG_CACHE_FILE(), JSON.stringify(commits));
    } catch (err) {
        console.warn('[changelog] 磁盘缓存写入失败（不影响本次响应）:', err.message);
    }
}

/**
 * 获取 GitHub 更新日志
 * GitHub URL、User-Agent、缓存时长、超时均从 system 配置读取，避免硬编码
 *
 * 这个面板本来就自带一份编辑过的版本说明（客户端 src/data/changelog.ts），GitHub 提交列表只是补充信息，
 * 所以第三方不可达时**不能**把请求打成 500 —— 响应拦截器会给玩家弹一条"服务器错误，请稍后重试"，
 * 而面板其实能正常显示。现在：拉得到就用，拉不到就用内存/磁盘缓存，都没有就返回空列表并标明来源。
 */
router.get('/changelog', async (req, res, next) => {
    const now = Date.now();
    const systemSettings = getSystemConfig().settings || {};
    const setting = key => systemSettings[key]?.value;
    const cacheDuration = setting('changelog_cache_duration_ms') ?? 600000;
    const fetchTimeout = setting('changelog_fetch_timeout_ms') ?? 5000;

    const reply = (data, source) => res.json({ code: 200, data, source });

    try {
        if (changelogCache && (now - lastCacheTime < cacheDuration)) {
            return reply(changelogCache, 'memory_cache');
        }

        const githubUrl = setting('github_api_url') || 'https://api.github.com/repos/1592363624/re_xiuxian/commits';
        const userAgent = setting('github_user_agent') || 're_xiuxian-game';

        const response = await axios.get(githubUrl, {
            params: { per_page: 30 },
            headers: { 'User-Agent': userAgent },
            timeout: fetchTimeout
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
        writeChangelogDiskCache(commits);

        return reply(commits, 'github');
    } catch (error) {
        console.warn('[changelog] 拉取 GitHub 提交失败，改用缓存:', error.message);
        if (changelogCache) return reply(changelogCache, 'memory_cache');
        const disk = readChangelogDiskCache();
        if (disk) {
            changelogCache = disk;
            lastCacheTime = 0;      // 磁盘缓存没有时效信息，下次请求仍然尝试刷新
            return reply(disk, 'disk_cache');
        }
        return reply([], 'unavailable');
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
