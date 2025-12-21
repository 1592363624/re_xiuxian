const jwt = require('jsonwebtoken');
const Player = require('../models/player');

module.exports = async (req, res, next) => {
    const token = req.header('Authorization');
    
    if (!token) {
        return res.status(401).json({ message: '未提供认证令牌，拒绝访问' });
    }

    try {
        // Bearer Token 格式处理
        const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET || 'xiuxian_secret_key');
        
        // 校验版本号 (单点登录核心逻辑)
        const player = await Player.findByPk(decoded.id);
        
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

        // 更新最后在线时间 (每分钟最多更新一次，避免频繁写入)
        const now = new Date();
        if (!player.last_online || (now - new Date(player.last_online)) > 60000) {
            player.last_online = now;
            await player.save({ silent: true }); // 使用 silent: true 避免触发表的 updatedAt 更新
        }

        next();
    } catch (error) {
        res.status(401).json({ message: '令牌无效或已过期' });
    }
};
