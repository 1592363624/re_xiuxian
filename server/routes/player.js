/**
 * 玩家相关路由
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const auth = require('../middleware/auth'); // 假设有认证中间件

// 获取当前玩家信息
router.get('/me', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        // 计算衍生属性 (这里简化处理，实际可能有更复杂的公式)
        // 假设 HP = 体质 * 10 (这里没有体质字段，先用固定公式模拟)
        // 简单模拟：HP 上限 = 境界基础值 + 属性加成
        // 暂时写死或根据 exp 估算
        const hpMax = 100 + Math.floor(player.exp / 10);
        const expNext = 100 * Math.pow(2, Math.floor(player.exp / 1000)); // 简单模拟升级经验

        const playerData = player.toJSON();
        
        // 合并计算属性
        const responseData = {
            ...playerData,
            hp_current: hpMax, // 暂时默认满血
            hp_max: hpMax,
            exp_next: expNext,
            // 确保 attributes 被正确解析 (Sequelize getter 应该已经处理了，但以防万一)
            attributes: typeof playerData.attributes === 'string' ? JSON.parse(playerData.attributes) : playerData.attributes
        };

        res.json(responseData);
    } catch (error) {
        console.error('获取玩家信息失败:', error);
        res.status(500).json({ message: '服务器错误' });
    }
});

// 更新玩家信息 (存档)
router.put('/me', auth, async (req, res) => {
    try {
        const { id } = req.user;
        const updates = req.body;
        
        const player = await Player.findByPk(id);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        // 允许更新的字段白名单
        const allowedUpdates = [
            'nickname', 'realm', 'exp', 'spirit_stones', 
            'lifespan_current', 'lifespan_max', 'attributes'
        ];
        
        allowedUpdates.forEach(key => {
            if (updates[key] !== undefined) {
                player[key] = updates[key];
            }
        });

        await player.save();
        
        res.json({ message: '存档成功', player });
    } catch (error) {
        console.error('存档失败:', error);
        res.status(500).json({ message: '存档失败' });
    }
});

module.exports = router;
