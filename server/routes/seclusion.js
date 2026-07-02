const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const Realm = require('../models/realm');
const authenticateToken = require('../middleware/auth');
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../config/seclusion.json');

/**
 * 获取配置值，带默认值支持
 * @param {string} key - 配置键名
 * @param {*} defaultValue - 默认值
 * @returns {*} 配置值或默认值
 */
function getConfigValue(key, defaultValue = null) {
    try {
        const config = configLoader.getConfig('seclusion');
        if (config && config.settings && config.settings[key]) {
            const value = config.settings[key].value;
            return value !== null && value !== undefined ? value : defaultValue;
        }
        return defaultValue;
    } catch (err) {
        console.warn(`获取配置 ${key} 失败，使用默认值:`, err.message);
        return defaultValue;
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

/**
 * 获取闭关冷却时间（秒）
 */
function getSeclusionCooldown() {
    const val = getConfigValue('seclusion_cooldown', 60);
    return parseInt(val) || 60;
}

/**
 * 获取闭关基础修为收益率（每秒）
 */
function getSeclusionExpRate() {
    const val = getConfigValue('seclusion_exp_rate', 1);
    return parseFloat(val) || 1;
}

/**
 * 获取修炼时间间隔（秒）
 */
function getCultivateInterval() {
    const val = getConfigValue('cultivate_interval', 60);
    return parseInt(val) || 60;
}

/**
 * 获取深度闭关修为收益倍率
 */
function getDeepSeclusionExpRate() {
    const val = getConfigValue('deep_seclusion_exp_rate', 2);
    return parseFloat(val) || 2;
}

/**
 * 获取深度闭关时间间隔（秒）
 */
function getDeepSeclusionInterval() {
    const val = getConfigValue('deep_seclusion_interval', 72000);
    return parseInt(val) || 72000;
}

// 获取境界加成倍率
async function getRealmMultiplier(realmName) {
    try {
        const realm = await Realm.findOne({ where: { name: realmName } });
        if (realm) {
            return 1.0 + (realm.rank - 1) * 0.1;
        }
    } catch (err) {
        console.error('获取境界加成失败:', err);
    }
    return 1.0;
}

/**
 * @route POST /api/seclusion/start
 * @desc 开始闭关
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);
        
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        if (player.is_secluded) {
            throw new AppError('玩家已在闭关中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 检查冷却时间
        if (player.last_seclusion_time) {
            const cooldown = getSeclusionCooldown();
            const now = new Date();
            const lastEnd = new Date(player.last_seclusion_time);
            const diffSeconds = Math.floor((now - lastEnd) / 1000);
            
            if (diffSeconds < cooldown) {
                const remainingMinutes = Math.ceil((cooldown - diffSeconds) / 60);
                throw new AppError(
                    `闭关冷却中，还需要等待 ${remainingMinutes} 分钟`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
        }

        // Update player status
        player.is_secluded = true;
        player.seclusion_start_time = new Date();
        player.seclusion_duration = 0; // 不再限制时长，设为0表示无限期直至手动停止
        await player.save();

        // 推送状态变更给前端
        WebSocketNotificationService.notifyPlayerUpdate(playerId, 'seclusion_start', {
            is_secluded: true,
            seclusion_start_time: player.seclusion_start_time
        });

        res.json({
            code: 200,
            message: '进入闭关状态',
            data: {
                is_secluded: player.is_secluded,
                seclusion_start_time: player.seclusion_start_time
            }
        });

    } catch (error) {
        next(error);
    }
});

/**
 * @route POST /api/seclusion/end
 * @desc 结束闭关 (结算奖励)
 * @access Private
 */
router.post('/end', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);

        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        if (!player.is_secluded) {
            throw new AppError('玩家未在闭关中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const startTime = new Date(player.seclusion_start_time);
        const now = new Date();
        const actualDurationSeconds = Math.floor((now - startTime) / 1000);
        
        // Calculate rewards
        const baseExpRate = getSeclusionExpRate(); 
        
        // 获取境界加成
        const realmMultiplier = await getRealmMultiplier(player.realm);

        const expGain = Math.floor(actualDurationSeconds * baseExpRate * realmMultiplier);

        // Update player stats
        player.exp = (BigInt(player.exp) + BigInt(expGain)).toString();
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.seclusion_duration = 0;
        player.last_seclusion_time = now; // 记录结束时间
        await player.save();

        // 推送状态变更给前端
        WebSocketNotificationService.notifyPlayerUpdate(playerId, 'seclusion_end', {
            is_secluded: false,
            exp_gain: expGain,
            exp: player.exp,
            last_seclusion_time: player.last_seclusion_time
        });

        const cooldown = getSeclusionCooldown();

        res.json({
            code: 200,
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

    } catch (error) {
        next(error);
    }
});

/**
 * @route GET /api/seclusion/status
 * @desc 获取闭关状态
 * @access Private
 */
router.get('/status', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const player = await Player.findByPk(playerId);

        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const rate = getSeclusionExpRate();
        const cultivateInterval = getCultivateInterval();
        const deepSeclusionRate = getDeepSeclusionExpRate();
        const deepSeclusionInterval = getDeepSeclusionInterval();

        // 由后端计算当前闭关已获修为，避免前端自行计算
        let expGained = 0;
        let currentDuration = 0;
        if (player.is_secluded && player.seclusion_start_time) {
            const startTime = new Date(player.seclusion_start_time);
            const now = new Date();
            currentDuration = Math.floor((now - startTime) / 1000);

            // 获取境界加成
            const realmMultiplier = await getRealmMultiplier(player.realm);

            expGained = Math.floor(currentDuration * rate * realmMultiplier);
        }

        res.json({
            code: 200,
            data: {
                is_secluded: player.is_secluded,
                seclusion_start_time: player.seclusion_start_time,
                seclusion_duration: player.seclusion_duration,
                exp_rate: rate,
                cultivate_interval: cultivateInterval,
                deep_seclusion_exp_rate: deepSeclusionRate,
                deep_seclusion_interval: deepSeclusionInterval,
                // 后端计算的当前闭关已获修为
                exp_gained: expGained,
                current_duration: currentDuration
            }
        });

    } catch (error) {
        next(error);
    }
});

module.exports = router;
