/**
 * 认证路由：注册与登录
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Player = require('../models/player');
const { Op } = require('sequelize');
const { ATTRIBUTES } = require('../utils/gameConstants');

// 检查唯一性 API
router.get('/check-unique', async (req, res) => {
    try {
        const { type, value } = req.query; // type: 'username' or 'nickname'

        if (!type || !value) {
            return res.status(400).json({ message: '参数缺失' });
        }

        const where = {};
        where[type] = value;

        const player = await Player.findOne({ where });

        if (player) {
            const msg = type === 'username' ? '该账号已被注册，请更换其他账号' : '该道号已被使用，请选择其他道号';
            return res.json({ available: false, message: msg });
        }

        res.json({ available: true });
    } catch (error) {
        res.status(500).json({ message: '服务器错误', error: error.message });
    }
});

// 注册
router.post('/register', async (req, res) => {
    try {
        const { username, password, nickname } = req.body;
        
        // 格式验证
        const USERNAME_REGEX = /^[a-zA-Z0-9]{6,12}$/;
        const PASSWORD_REGEX = /^[a-zA-Z0-9]{6,12}$/;
        
        if (!username || !USERNAME_REGEX.test(username)) {
            return res.status(400).json({ message: '账号必须为6-12位英文或数字' });
        }
        if (!password || !PASSWORD_REGEX.test(password)) {
            return res.status(400).json({ message: '密码必须为6-12位英文或数字' });
        }
        if (!nickname || nickname.length < 2 || nickname.length > 10) {
            return res.status(400).json({ message: '道号必须为2-10个字符' });
        }
        
        // 1. 业务层预检查 (提升用户体验)
        // 使用 Op.or 一次性查询，减少数据库交互
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
                return res.status(400).json({ message: '该账号已被注册，请更换其他账号' });
            }
            if (existingPlayer.nickname === nickname) {
                return res.status(400).json({ message: '该道号已被使用，请选择其他道号' });
            }
        }

        // 密码加密
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 生成随机单灵根 (仅保留属性，无资质数值)
        const allRoots = Object.values(ATTRIBUTES);
        const randomRoot = allRoots[Math.floor(Math.random() * allRoots.length)];
        const spiritRoots = { type: randomRoot };

        // 创建新玩家
        const newPlayer = await Player.create({
            username,
            password: hashedPassword,
            nickname,
            spirit_roots: spiritRoots
        });

        res.status(201).json({ 
            message: '注册成功，踏入仙途',
            playerId: newPlayer.id 
        });
    } catch (error) {
        // 2. 数据库层唯一性冲突捕获 (处理并发)
        if (error.name === 'SequelizeUniqueConstraintError') {
            const field = error.errors[0].path;
            // 注意：error.errors[0].path 可能是 'username' 也可能是索引名，取决于 Sequelize 版本和配置
            // 但通常可以通过 error.fields 来判断
            // 或者简单地根据 message 判断
            
            // 为了更稳健，我们可以重新检查是哪个字段重复了，或者根据索引名判断
            // 之前的索引名是 'uk_player_username' 和 'uk_player_nickname'
            
            // 简单处理：
            if (error.message.includes('username') || (error.errors[0] && error.errors[0].message.includes('username'))) {
                 return res.status(400).json({ message: '该账号已被注册，请更换其他账号' });
            }
            if (error.message.includes('nickname') || (error.errors[0] && error.errors[0].message.includes('nickname'))) {
                 return res.status(400).json({ message: '该道号已被使用，请选择其他道号' });
            }
            
            return res.status(400).json({ message: '账号或道号已被占用' });
        }

        res.status(500).json({ message: '服务器错误', error: error.message });
    }
});

// 登录
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // 查找用户
        const player = await Player.findOne({ where: { username } });
        
        if (!player) {
            // 安全性：即使账号不存在，也进行一次耗时的密码比对，防止时序攻击 (Timing Attack)
            // 使用一个固定的无效哈希进行比对，消耗与正常登录相似的时间
            const dummyHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456'; // 示例无效哈希
            await bcrypt.compare(password, dummyHash).catch(() => {}); 
            
            return res.status(404).json({ message: '该账号不存在，请检查或注册新账号' });
        }

        // 验证密码
        const isMatch = await bcrypt.compare(password, player.password);
        if (!isMatch) {
            return res.status(401).json({ message: '密码错误，请重新输入' });
        }

        // 更新 Token 版本号 (实现互踢)
        player.token_version = (player.token_version || 0) + 1;
        await player.save();

        // 生成 JWT
        const payload = {
            id: player.id,
            username: player.username,
            v: player.token_version // 存入版本号
        };
        
        const token = jwt.sign(
            payload, 
            process.env.JWT_SECRET || 'xiuxian_secret_key', 
            { expiresIn: '7d' } // 7天过期
        );

        res.json({
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
        res.status(500).json({ message: '服务器错误', error: error.message });
    }
});

module.exports = router;
