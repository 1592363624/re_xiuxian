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
        timezone: '+08:00', // 东八区时间
        hooks: {
            // 解决 MySQL 5.6 在某些情况下连接建立后未选择数据库的问题
            afterConnect: async (connection, config) => {
                if (process.env.DB_NAME) {
                   // 注意：connection 是原始的 driver 连接对象，不是 Sequelize 实例
                   // mysql2 的 connection 对象通常有 query 方法
                   // 这里使用 try-catch 防止意外，虽然理论上不应该出错
                   try {
                       // 仅当 connection 有 query 方法时执行（防御性编程）
                       if (typeof connection.query === 'function') {
                           // 使用回调风格或 Promise 风格，视驱动版本而定。
                           // mysql2 的 query 返回 connection，所以这里简单调用
                           // 注意：这里不能用 await，因为 afterConnect 签名在不同版本可能不同
                           // 且 connection.query 在 mysql2 中可能不返回 Promise
                           connection.query(`USE \`${process.env.DB_NAME}\`;`);
                       }
                   } catch (e) {
                       console.error('手动选择数据库失败:', e.message);
                   }
                }
            }
        }
    }
);

module.exports = sequelize;
