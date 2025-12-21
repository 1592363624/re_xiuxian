const jwt = require('jsonwebtoken');
const Player = require('../models/player');
const sequelize = require('../config/database');
require('dotenv').config({ path: '../.env' });

async function testAuth() {
  try {
    await sequelize.authenticate();
    
    // 1. 获取一个测试用户
    const player = await Player.findOne();
    if (!player) {
        console.log('没有用户，无法测试');
        return;
    }
    console.log(`测试用户: ${player.username}, DB Version: ${player.token_version}`);

    // 2. 生成一个没有 'v' 字段的旧 Token
    const oldToken = jwt.sign(
        { id: player.id, username: player.username }, // 没有 v
        process.env.JWT_SECRET || 'xiuxian_secret_key',
        { expiresIn: '1h' }
    );

    // 3. 模拟中间件校验逻辑
    const decoded = jwt.verify(oldToken, process.env.JWT_SECRET || 'xiuxian_secret_key');
    console.log('Decoded Token:', decoded);

    const dbVersion = player.token_version || 0;
    const tokenVersion = decoded.v;

    console.log(`Check: Token V (${tokenVersion}) vs DB V (${dbVersion})`);

    // 旧逻辑模拟
    if (decoded.v !== undefined && player.token_version !== decoded.v) {
        console.log('FAIL: 旧逻辑会拦截 (预期外)');
    } else {
        console.log('PASS: 旧逻辑会放行 (这就是漏洞所在!)');
    }

    // 新逻辑模拟
    if (tokenVersion === undefined || tokenVersion !== dbVersion) {
        console.log('SUCCESS: 新逻辑会拦截 (漏洞已修复)');
    } else {
        console.log('FAIL: 新逻辑会放行 (仍然存在问题)');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testAuth();
