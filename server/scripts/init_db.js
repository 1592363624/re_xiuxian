/**
 * 数据库初始化脚本
 * 用于创建表结构和初始化默认数据
 */
const path = require('path');
// 尝试加载 .env 文件 (位于 server 根目录)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sequelize = require('../config/database');
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const Chat = require('../models/chat');

async function initDB() {
  try {
    console.log('开始初始化数据库...');
    console.log(`连接数据库: ${process.env.DB_HOST} / ${process.env.DB_NAME}`);
    
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 同步模型
    console.log('正在同步表结构...');
    await sequelize.sync({ alter: true });
    console.log('表结构同步完成');

    // 初始化系统配置
    console.log('检查并初始化系统配置...');
    const defaultConfig = [
      { key: 'auto_save_interval', value: '10000', description: '自动存档间隔(毫秒)' },
      { key: 'initial_lifespan', value: '100', description: '初始寿元' }
    ];

    for (const config of defaultConfig) {
      const [item, created] = await SystemConfig.findOrCreate({
        where: { key: config.key },
        defaults: config
      });
      if (created) {
        console.log(`已创建默认配置: ${config.key}`);
      } else {
        console.log(`配置已存在: ${config.key}`);
      }
    }

    console.log('数据库初始化完成！');
    process.exit(0);
  } catch (error) {
    console.error('数据库初始化失败:', error);
    process.exit(1);
  }
}

initDB();
