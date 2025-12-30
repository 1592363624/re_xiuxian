/**
 * 地图初始化脚本
 * 
 * 验证 map_data.json 配置格式，并创建必要的数据库表
 * 地图配置从 map_data.json 直接读取，无需同步到数据库
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sequelize = require('../config/database');
const PlayerMapPosition = require('../models/playerMapPosition');
const MapConfigLoader = require('../services/MapConfigLoader');

async function initMaps() {
    try {
        console.log('正在连接数据库...');
        await sequelize.authenticate();
        console.log('数据库连接成功。\n');

        console.log('正在验证地图配置...');
        const mapConfig = MapConfigLoader;
        const validation = mapConfig.validate();
        
        if (!validation.valid) {
            console.error('地图配置验证失败:');
            validation.errors.forEach(e => console.error(`  - ${e}`));
            process.exit(1);
        }
        console.log('✅ 地图配置验证通过！\n');

        console.log('正在同步玩家地图位置表结构...');
        await PlayerMapPosition.sync({ alter: true });
        console.log('✅ 表结构同步完成。\n');

        console.log('地图列表:');
        const allMaps = mapConfig.getAllMaps();
        allMaps.forEach(m => {
            const connections = m.connections || [];
            console.log(`  - ${m.name} (ID: ${m.id}, 类型: ${m.type}, 危险等级: ${m.danger_level})`);
            console.log(`    连接: [${connections.join(', ')}]`);
        });

        console.log('\n初始化完成！');
        console.log('\n后续操作:');
        console.log('  1. 修改 map_data.json 后无需运行此脚本，配置即时生效');
        console.log('  2. 启动服务器: npm start');
        console.log('  3. 访问 API: GET /api/map/config (无需认证)');
        
        process.exit(0);
    } catch (error) {
        console.error('初始化失败:', error);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

initMaps();
