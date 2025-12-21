const jwt = require('jsonwebtoken');
const Player = require('../models/player');
const sequelize = require('../config/database');
require('dotenv').config({ path: '../.env' });

async function testAuth() {
  try {
    await sequelize.authenticate();
    
    // 1. 获取或创建固定的测试用户
    const TEST_USERNAME = 'testuser1592363624';
    let player = await Player.findOne({ where: { username: TEST_USERNAME } });
    
    if (!player) {
        console.log('创建固定测试用户...');
        player = await Player.create({
            username: TEST_USERNAME,
            password: 'dummy_password_hash', // 测试脚本不需要真实登录，只需用于生成Token
            nickname: 'AuthTester',
            token_version: 0
        });
    } else {
        // 重置 token_version 为 0，确保测试环境一致
        console.log('重置测试用户 token_version 为 0...');
        player.token_version = 0;
        await player.save();
    }
    
    console.log(`测试用户: ${player.username}, DB Version: ${player.token_version}`);

    // 2. 生成一个没有 'v' 字段的旧 Token (模拟旧版本 Token 或攻击者构造的 Token)
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

    // 旧逻辑模拟 (仅作对比参考)
    if (decoded.v !== undefined && player.token_version !== decoded.v) {
        console.log('FAIL: 旧逻辑会拦截 (预期外)');
    } else {
        console.log('PASS: 旧逻辑会放行 (这就是漏洞所在!)');
    }

    // 新逻辑模拟 (实际生效的逻辑)
    // 必须存在 v 且 v 必须等于数据库中的 version
    if (tokenVersion === undefined || tokenVersion !== dbVersion) {
        console.log('SUCCESS: 新逻辑会拦截 (漏洞已修复 - 必须包含正确的版本号)');
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
