/**
 * 系统配置路由
 * 提供公开的系统配置查询接口
 */
const express = require('express');
const router = express.Router();
const SystemConfig = require('../models/system_config');
const authenticateToken = require('../middleware/auth');

// 获取公开系统配置 (需要登录)
router.get('/config', authenticateToken, async (req, res) => {
  try {
    // 这里可以定义哪些配置是公开给客户端的
    // 目前简单起见，返回所有配置，或者按需过滤
    // 假设 auto_save_interval 是需要下发给客户端的
    const configs = await SystemConfig.findAll();
    
    // 转换为键值对对象
    const configMap = {};
    configs.forEach(c => {
      // 尝试解析 JSON 值，如果是数字字符串则转为数字
      try {
        const num = Number(c.value);
        configMap[c.key] = isNaN(num) ? JSON.parse(c.value) : num;
      } catch (e) {
        configMap[c.key] = c.value;
      }
    });

    res.json(configMap);
  } catch (error) {
    console.error('获取系统配置失败:', error);
    res.status(500).json({ error: '获取系统配置失败' });
  }
});

module.exports = router;
