/**
 * 认证路由：注册与登录
 * 业务逻辑委托 PlayerService.initializePlayer，路由层只做参数校验和响应
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Player = require('../models/player');
const { Op } = require('sequelize');
const PlayerService = require('../game/core/PlayerService');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 通过 ConfigLoader 获取配置（懒加载，避免模块加载时配置未初始化）
const configLoader = infrastructure.ConfigLoader;
function getAuthConfig() {
    return configLoader.getConfig('game_balance')?.auth || {};
}

// IP 提取工具函数（统一抽取，消除 auth.js 内重复代码）
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // 取第一个 IP 并去除空白（注意：x-forwarded-for 可被伪造，生产环境需配合反向代理信任设置）
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
}

// 检查唯一性 API
router.get('/check-unique', async (req, res, next) => {
    try {
        const { type, value } = req.query; // type: 'username' or 'nickname'

        if (!type || !value) {
            throw new AppError('参数缺失', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 白名单校验，防止 NoSQL 注入
        const allowedTypes = ['username', 'nickname'];
        if (!allowedTypes.includes(type)) {
            throw new AppError('无效的查询类型', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const where = {};
        where[type] = value;

        const player = await Player.findOne({ where });

        if (player) {
            const msg = type === 'username' ? '该账号已被注册，请更换其他账号' : '该道号已被使用，请选择其他道号';
            return res.json({ code: 200, available: false, message: msg });
        }

        res.json({ code: 200, available: true });
    } catch (error) {
        next(error);
    }
});

// 注册
router.post('/register', async (req, res, next) => {
    try {
        const { username, password, nickname } = req.body;
        const authConfig = getAuthConfig();

        // 格式验证（使用配置文件中的正则）
        const usernameRegex = new RegExp(authConfig.username_regex);
        const passwordRegex = new RegExp(authConfig.password_regex);
        const nicknameMinLen = authConfig.nickname_min_length ?? 2;
        const nicknameMaxLen = authConfig.nickname_max_length ?? 10;

        if (!username || !usernameRegex.test(username)) {
            throw new AppError('账号必须为6-12位英文或数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!password || !passwordRegex.test(password)) {
            throw new AppError('密码必须为6-12位英文或数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!nickname || nickname.length < nicknameMinLen || nickname.length > nicknameMaxLen) {
            throw new AppError(`道号必须为${nicknameMinLen}-${nicknameMaxLen}个字符`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 业务层预检查（提升用户体验，使用 Op.or 一次性查询）
        const existingPlayer = await Player.findOne({
            where: {
                [Op.or]: [
                    { username },
                    { nickname }
                ]
            }
        });

        if (existingPlayer) {
            if (existingPlayer.username === username) {
                throw new AppError('该账号已被注册，请更换其他账号', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (existingPlayer.nickname === nickname) {
                throw new AppError('该道号已被使用，请选择其他道号', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
        }

        // 密码加密（salt rounds 从配置读取，避免硬编码）
        const saltRounds = authConfig.bcrypt_salt_rounds ?? 10;
        const salt = await bcrypt.genSalt(saltRounds);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 委托 PlayerService 初始化玩家（统一灵根数据结构，避免双套逻辑）
        const newPlayer = await PlayerService.initializePlayer(username, hashedPassword, nickname, {
            ip: getClientIp(req),
            userAgent: req.headers['user-agent'] || ''
        });

        res.status(201).json({
            code: 201,
            message: '注册成功，踏入仙途',
            playerId: newPlayer.id
        });
    } catch (error) {
        // 数据库层唯一性冲突捕获（处理并发）
        if (error.name === 'SequelizeUniqueConstraintError') {
            if (error.message.includes('username') || (error.errors[0] && error.errors[0].message.includes('username'))) {
                return next(new AppError('该账号已被注册，请更换其他账号', 400, ErrorCodes.BUSINESS_LOGIC_ERROR));
            }
            if (error.message.includes('nickname') || (error.errors[0] && error.errors[0].message.includes('nickname'))) {
                return next(new AppError('该道号已被使用，请选择其他道号', 400, ErrorCodes.BUSINESS_LOGIC_ERROR));
            }
            return next(new AppError('账号或道号已被占用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR));
        }
        next(error);
    }
});

// 登录
router.post('/login', async (req, res, next) => {
    try {
        const { username, password } = req.body;
        const authConfig = getAuthConfig();

        // 查找用户
        const player = await Player.findOne({ where: { username } });

        if (!player) {
            // 安全性：即使账号不存在，也进行一次耗时的密码比对，防止时序攻击 (Timing Attack)
            // 使用一个固定的无效哈希进行比对，消耗与正常登录相似的时间
            const dummyHash = '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890123456789012';
            await bcrypt.compare(password, dummyHash).catch(() => {});

            throw new AppError('该账号不存在，请检查或注册新账号', 404, ErrorCodes.NOT_FOUND);
        }

        // 验证密码
        const isMatch = await bcrypt.compare(password, player.password);
        if (!isMatch) {
            throw new AppError('密码错误，请重新输入', 401, ErrorCodes.UNAUTHORIZED);
        }

        // 更新 Token 版本号（实现互踢）和 IP 地址
        player.token_version = (player.token_version || 0) + 1;
        player.ip_address = getClientIp(req);
        await player.save();

        // 生成 JWT（过期时间从配置读取，避免硬编码）
        const payload = {
            id: player.id,
            username: player.username,
            v: player.token_version // 存入版本号
        };

        const token = jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: authConfig.jwt_expires_in ?? '7d' }
        );

        res.json({
            code: 200,
            message: '登录成功',
            token,
            player: {
                id: player.id,
                nickname: player.nickname,
                realm: player.realm,
                role: player.role
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
