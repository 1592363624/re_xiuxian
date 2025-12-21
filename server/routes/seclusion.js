const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const authenticateToken = require('../middleware/auth');
const { Op } = require('sequelize');

// 获取闭关经验倍率 (默认 0.1 / 秒，即 1点/10秒)
async function getSeclusionExpRate() {
    try {
        const config = await SystemConfig.findByPk('seclusion_exp_rate');
        if (config) {
            return parseFloat(config.value);
        }
        return 0.1;
    } catch (err) {
        console.error('获取闭关倍率失败:', err);
        return 0.1;
    }
}

/**
 * @route POST /api/seclusion/start
 * @desc 开始闭关
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const { duration } = req.body; // duration in seconds
        const playerId = req.user.id;

        if (!duration || duration <= 0) {
            return res.status(400).json({ error: '无效的闭关时长' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ error: '玩家不存在' });
        }

        if (player.is_secluded) {
            return res.status(400).json({ error: '玩家已在闭关中' });
        }

        // Update player status
        player.is_secluded = true;
        player.seclusion_start_time = new Date();
        player.seclusion_duration = duration;
        await player.save();

        res.json({
            message: '开始闭关',
            data: {
                is_secluded: player.is_secluded,
                seclusion_start_time: player.seclusion_start_time,
                seclusion_duration: player.seclusion_duration
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '服务器错误' });
    }
});

/**
 * @route POST /api/seclusion/end
 * @desc 结束闭关 (结算奖励)
 * @access Private
 */
router.post('/end', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);

        if (!player) {
            return res.status(404).json({ error: '玩家不存在' });
        }

        if (!player.is_secluded) {
            return res.status(400).json({ error: '玩家未在闭关中' });
        }

        const startTime = new Date(player.seclusion_start_time);
        const now = new Date();
        const actualDurationSeconds = Math.floor((now - startTime) / 1000);
        
        // Calculate rewards
        // Formula: Use configured rate (default 0.1/s)
        const baseExpRate = await getSeclusionExpRate(); 
        const expGain = Math.floor(actualDurationSeconds * baseExpRate);

        // Update player stats
        player.exp = (BigInt(player.exp) + BigInt(expGain)).toString(); // Handle BigInt
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.seclusion_duration = 0;
        await player.save();

        res.json({
            message: '闭关结束',
            data: {
                exp_gain: expGain,
                actual_duration: actualDurationSeconds,
                player: {
                    exp: player.exp,
                    is_secluded: false
                }
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '服务器错误' });
    }
});

/**
 * @route GET /api/seclusion/status
 * @desc 获取闭关状态
 * @access Private
 */
router.get('/status', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);

        if (!player) {
            return res.status(404).json({ error: '玩家不存在' });
        }

        const rate = await getSeclusionExpRate();

        res.json({
            is_secluded: player.is_secluded,
            seclusion_start_time: player.seclusion_start_time,
            seclusion_duration: player.seclusion_duration,
            exp_rate: rate
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '服务器错误' });
    }
});

module.exports = router;
