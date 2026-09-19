const jwt = require('jsonwebtoken');
const Player = require('../models/player');
const { infrastructure } = require('../modules');

// 通过 ConfigLoader 获取配置
const configLoader = infrastructure.ConfigLoader;
const gameBalanceConfig = configLoader.getConfig('game_balance');

// 从配置文件读取在线更新时间间隔
const LAST_ONLINE_UPDATE_INTERVAL_MS = gameBalanceConfig.time_intervals.last_online_update_interval_ms;

module.exports = async (req, res, next) => {
    const token = req.header('Authorization');
    
    if (!token) {
        return res.status(401).json({ message: '未提供认证令牌，拒绝访问' });
    }

    // 仅令牌本身有问题才返回 401：客户端拦截器收到 401 会 logout() 并重新登录，
    // 重新登录会递增 token_version，进而踢掉该账号的其他会话
    let decoded;
    try {
        // Bearer Token 格式处理
        decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
    } catch (error) {
        console.warn(`[auth] 令牌校验失败 ${req.method} ${req.originalUrl}: ${error.name}`);
        return res.status(401).json({ message: '令牌无效或已过期' });
    }

    // 数据库故障与令牌故障必须区分，否则连接池抖动会被当成登录过期，引发全服级联掉线
    let player;
    try {
        // 校验版本号 (单点登录核心逻辑)
        player = await Player.findByPk(decoded.id);
    } catch (error) {
        console.error(`[auth] 玩家查询失败 user_id=${decoded.id}:`, error);
        return res.status(503).json({ message: '服务暂时不可用，请稍后重试' });
    }

    if (!player) {
        return res.status(401).json({ message: '用户不存在' });
    }

    // 调试日志
    // console.log(`Auth Check: User ${player.username}, Token V: ${decoded.v}, DB V: ${player.token_version}`);

    // 强制检查版本号：如果 Token 中没有版本号，或者与数据库不一致，则拒绝
    // 注意：新注册用户或首次登录可能数据库是 null/0，Token 也应该是对应的。
    // 为了兼容旧数据，如果数据库是 null，视为 0
    const dbVersion = player.token_version || 0;
    const tokenVersion = decoded.v;

    if (tokenVersion === undefined || tokenVersion !== dbVersion) {
        console.log(`互踢触发: User ${player.username}, Token V: ${tokenVersion}, DB V: ${dbVersion}`);
        return res.status(401).json({ message: '您的账号已在其他设备登录，当前会话已失效', code: 'SESSION_EXPIRED' });
    }

    req.user = decoded;
    req.player = player; // 挂载 player 对象供后续使用

    // 最后在线时间仅用于统计，写入失败不应让整个请求失败
    try {
        const now = new Date();
        if (!player.last_online || (now - new Date(player.last_online)) > LAST_ONLINE_UPDATE_INTERVAL_MS) {
            player.last_online = now;
            await player.save({ silent: true }); // 使用 silent: true 避免触发表的 updatedAt 更新
        }
    } catch (error) {
        console.warn(`[auth] 更新 last_online 失败 player_id=${player.id}: ${error.message}`);
    }

    next();
};
