const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    const token = req.header('Authorization');
    
    if (!token) {
        return res.status(401).json({ message: '未提供认证令牌，拒绝访问' });
    }

    try {
        // Bearer Token 格式处理
        const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET || 'xiuxian_secret_key');
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ message: '令牌无效或已过期' });
    }
};
