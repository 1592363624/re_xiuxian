/**
 * 认证路由：注册与登录
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Player = require('../models/player');

// 注册
router.post('/register', async (req, res) => {
    try {
        const { username, password, nickname } = req.body;
        
        // 检查用户是否存在
        const existingUser = await Player.findOne({ where: { username } });
        if (existingUser) {
            return res.status(400).json({ message: '该账号已被注册' });
        }

        // 密码加密
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 创建新玩家
        const newPlayer = await Player.create({
            username,
            password: hashedPassword,
            nickname
        });

        res.status(201).json({ 
            message: '注册成功，踏入仙途',
            playerId: newPlayer.id 
        });
    } catch (error) {
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
