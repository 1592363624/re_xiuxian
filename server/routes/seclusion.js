const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const Realm = require('../models/realm');
const SystemConfig = require('../models/system_config');
const authenticateToken = require('../middleware/auth');
const { Op } = require('sequelize');

// 获取闭关经验倍率 (默认 0.1 / 秒，即 1点/10秒)
async function getSeclusionExpRate() {
    try {
        const config = await SystemConfig.findOne({ where: { key: 'seclusion_exp_rate' } });
        if (config) {
            return parseFloat(config.value);
        }
        return 0.1;
    } catch (err) {
        console.error('获取闭关倍率失败:', err);
        return 0.1;
    }
}

// 获取闭关冷却时间 (默认 3600 秒)
async function getSeclusionCooldown() {
    try {
        const config = await SystemConfig.findOne({ where: { key: 'seclusion_cooldown' } });
        if (config) {
            return parseInt(config.value);
        }
        return 3600; // 60 分钟
    } catch (err) {
        console.error('获取闭关冷却时间失败:', err);
        return 3600;
    }
}

/**
 * @route POST /api/seclusion/start
 * @desc 开始闭关
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);
        
        if (!player) {
            return res.status(404).json({ error: '玩家不存在' });
        }

        if (player.is_secluded) {
            return res.status(400).json({ error: '玩家已在闭关中' });
        }

        // 检查冷却时间
        if (player.last_seclusion_time) {
            const cooldown = await getSeclusionCooldown();
            const now = new Date();
            const lastEnd = new Date(player.last_seclusion_time);
            const diffSeconds = Math.floor((now - lastEnd) / 1000);
            
            if (diffSeconds < cooldown) {
                const remainingMinutes = Math.ceil((cooldown - diffSeconds) / 60);
                return res.status(400).json({ 
                    error: `闭关冷却中，还需要等待 ${remainingMinutes} 分钟`,
                    remaining_seconds: cooldown - diffSeconds
                });
            }
        }

        // Update player status
        player.is_secluded = true;
        player.seclusion_start_time = new Date();
        player.seclusion_duration = 0; // 不再限制时长，设为0表示无限期直至手动停止
        await player.save();

        res.json({
            message: '进入闭关状态',
            data: {
                is_secluded: player.is_secluded,
                seclusion_start_time: player.seclusion_start_time
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
        const baseExpRate = await getSeclusionExpRate(); 
        
        // 获取境界加成
        let realmMultiplier = 1.0;
        try {
            const realm = await Realm.findByPk(player.realm);
            if (realm) {
                // 境界加成逻辑：每提升一个境界 Rank，收益增加 10%
                // 凡人(Rank 1) 为 1.0 倍，炼气1层(Rank 2) 为 1.1 倍，以此类推
                realmMultiplier = 1.0 + (realm.rank - 1) * 0.1;
            }
        } catch (err) {
            console.error('获取境界加成失败:', err);
        }

        const expGain = Math.floor(actualDurationSeconds * baseExpRate * realmMultiplier);

        // Update player stats
        player.exp = (BigInt(player.exp) + BigInt(expGain)).toString();
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.seclusion_duration = 0;
        player.last_seclusion_time = now; // 记录结束时间
        await player.save();

        const cooldown = await getSeclusionCooldown();

        res.json({
            message: `闭关结束，本次闭关获得修为 ${expGain} 点。下次闭关需间隔 ${Math.floor(cooldown / 60)} 分钟。`,
            data: {
                exp_gain: expGain,
                actual_duration: actualDurationSeconds,
                cooldown_minutes: Math.floor(cooldown / 60),
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
