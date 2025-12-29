const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const Realm = require('../models/realm');
const authenticateToken = require('../middleware/auth');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../config/seclusion.json');

function getConfigValue(key) {
    try {
        const config = configLoader.getConfig('seclusion');
        if (config && config.settings && config.settings[key]) {
            return config.settings[key].value;
        }
        return null;
    } catch (err) {
        console.error('获取配置失败:', err);
        return null;
    }
}

function saveConfigValue(key, value) {
    try {
        let config = { settings: {} };
        if (fs.existsSync(CONFIG_FILE)) {
            const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
            config = JSON.parse(content);
        }
        if (!config.settings[key]) {
            config.settings[key] = { value: value, displayName: key };
        } else {
            config.settings[key].value = value;
        }
        config.lastUpdated = new Date().toISOString();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        configLoader.hotUpdateConfig('seclusion');
        return true;
    } catch (err) {
        console.error('保存配置失败:', err);
        return false;
    }
}

// 获取闭关经验倍率 (默认 0.1 / 秒，即 1点/10秒)
function getSeclusionExpRate() {
    const value = getConfigValue('seclusion_exp_rate');
    return value !== null ? value : 0.1;
}

// 获取闭关冷却时间 (默认 3600 秒)
function getSeclusionCooldown() {
    const value = getConfigValue('seclusion_cooldown');
    return value !== null ? value : 3600;
}

// 获取修炼时间间隔 (默认 60 秒)
function getCultivateInterval() {
    const value = getConfigValue('cultivate_interval');
    return value !== null ? value : 60;
}

// 获取深度闭关收益倍率 (默认 2.0)
function getDeepSeclusionExpRate() {
    const value = getConfigValue('deep_seclusion_exp_rate');
    return value !== null ? value : 2.0;
}

// 获取深度闭关时间间隔 (默认 300 秒)
function getDeepSeclusionInterval() {
    const value = getConfigValue('deep_seclusion_interval');
    return value !== null ? value : 300;
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
                    is_secluded: false,
                    last_seclusion_time: player.last_seclusion_time
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
        const cultivateInterval = await getCultivateInterval();
        const deepSeclusionRate = await getDeepSeclusionExpRate();
        const deepSeclusionInterval = await getDeepSeclusionInterval();

        res.json({
            is_secluded: player.is_secluded,
            seclusion_start_time: player.seclusion_start_time,
            seclusion_duration: player.seclusion_duration,
            exp_rate: rate,
            cultivate_interval: cultivateInterval,
            deep_seclusion_exp_rate: deepSeclusionRate,
            deep_seclusion_interval: deepSeclusionInterval
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '服务器错误' });
    }
});

module.exports = router;
