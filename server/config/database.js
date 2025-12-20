/**
 * 数据库配置文件
 * 负责初始化 Sequelize 实例并连接数据库
 */
const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host: process.env.DB_HOST,
        dialect: 'mysql',
        logging: false, // 关闭SQL日志输出
        pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
        },
        timezone: '+08:00' // 东八区时间
    }
);

module.exports = sequelize;
