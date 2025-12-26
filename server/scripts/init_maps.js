/**
 * 地图初始化脚本
 * 
 * 基于核心数值设计文档 9.3 章节
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sequelize = require('../config/database');
const Map = require('../models/map');

const mapData = [
    // 1. 新手引导层
    {
        name: '青竹村',
        type: 'NOVICE',
        min_realm_rank: 1, // 凡人
        safety_level: 'SAFE',
        description: '新手出生地，灵气稀薄但安全，适合初入仙途者。',
        resources: [
            { name: '止血草', type: 'herb', rank: 1, cooldown: 1800, difficulty: 0 },
            { name: '灵泉水', type: 'material', rank: 1, cooldown: 1800, difficulty: 0 }
        ],
        events: [
            { name: '修炼者求助', type: 'quest', description: '偶遇修炼者求助，完成后奖励少量修为。', probability: 0.1 },
            { name: '灵泉水喷涌', type: 'resource', description: '灵泉水喷涌，限时拾取翻倍。', probability: 0.05 }
        ],
        connections: [], // 后续填充
        environment_cost: 0
    },
    {
        name: '新手修炼谷',
        type: 'NOVICE',
        min_realm_rank: 2, // 炼气1层
        safety_level: 'SAFE',
        description: '宗门为新手准备的修炼之地，灵气略高于外界。',
        resources: [
            { name: '清心草', type: 'herb', rank: 1, cooldown: 1800, difficulty: 0 }
        ],
        connections: [],
        environment_cost: 0
    },

    // 2. 低阶探索层 (炼气4层+, Rank 5)
    {
        name: '黑风山脉',
        type: 'LOW',
        min_realm_rank: 5, 
        safety_level: 'LOW_RISK',
        description: '常年黑风呼啸，栖息着不少低阶妖兽。',
        resources: [
            { name: '火灵果', type: 'herb', rank: 2, cooldown: 3600, difficulty: 1 },
            { name: '铁矿石', type: 'ore', rank: 1, cooldown: 3600, difficulty: 1 },
            { name: '低阶妖丹', type: 'monster_drop', rank: 1, cooldown: 3600, difficulty: 1 }
        ],
        events: [
            { name: '妖兽暴动', type: 'combat', description: '妖兽暴动，击败后奖励双倍妖丹。', probability: 0.15 },
            { name: '隐藏资源点', type: 'resource', description: '发现隐藏资源点，获取10份中阶灵草。', probability: 0.05 }
        ],
        connections: [],
        environment_cost: 0
    },
    {
        name: '迷雾森林',
        type: 'LOW',
        min_realm_rank: 5,
        safety_level: 'LOW_RISK',
        description: '终年迷雾缭绕，容易迷失方向。',
        resources: [
            { name: '迷雾草', type: 'herb', rank: 2, cooldown: 3600, difficulty: 1 }
        ],
        connections: [],
        environment_cost: 0
    },

    // 3. 中阶探索层 (炼气11层+, Rank 12)
    {
        name: '万妖岭',
        type: 'MID',
        min_realm_rank: 12,
        safety_level: 'MID_RISK',
        description: '妖兽聚集之地，危机四伏。',
        resources: [
            { name: '凝神花', type: 'herb', rank: 3, cooldown: 7200, difficulty: 2 },
            { name: '筑基期妖丹', type: 'monster_drop', rank: 2, cooldown: 7200, difficulty: 2 }
        ],
        events: [
            { name: '秘境碎片掉落', type: 'item', description: '拾取后可兑换秘境令牌。', probability: 0.1 }
        ],
        connections: [],
        environment_cost: 0
    },
    {
        name: '灵晶矿洞',
        type: 'MID',
        min_realm_rank: 12,
        safety_level: 'MID_RISK',
        description: '盛产灵晶的矿洞，常有矿洞守卫巡逻。',
        resources: [
            { name: '灵晶', type: 'currency', rank: 2, cooldown: 7200, difficulty: 2 }
        ],
        events: [
            { name: '矿洞塌方预警', type: 'resource', description: '限时采集，灵晶获取量+50%。', probability: 0.1 }
        ],
        connections: [],
        environment_cost: 0
    },

    // 4. 高阶探索层 (筑基后期+, Rank 17)
    {
        name: '断魂崖',
        type: 'HIGH',
        min_realm_rank: 17,
        safety_level: 'HIGH_RISK',
        description: '高耸入云的断崖，常有高阶妖兽出没。',
        resources: [
            { name: '百年灵芝', type: 'herb', rank: 4, cooldown: 14400, difficulty: 3 },
            { name: '结丹期妖丹', type: 'monster_drop', rank: 3, cooldown: 14400, difficulty: 3 }
        ],
        events: [
            { name: '上古妖兽残魂', type: 'combat', description: '击败后掉落结丹期材料。', probability: 0.2 }
        ],
        connections: [],
        environment_cost: 50 // 50点/小时
    },
    {
        name: '上古战场遗迹',
        type: 'HIGH',
        min_realm_rank: 17,
        safety_level: 'HIGH_RISK',
        description: '上古修士大战之地，残留着狂暴的灵气。',
        resources: [
            { name: '上品灵晶', type: 'currency', rank: 3, cooldown: 14400, difficulty: 3 },
            { name: '玄阶功法碎片', type: 'item', rank: 3, cooldown: 14400, difficulty: 3 }
        ],
        events: [
            { name: '跨宗门冲突', type: 'combat', description: '参与后奖励大量宗门贡献。', probability: 0.1 }
        ],
        connections: [],
        environment_cost: 50
    },

    // 5. 特殊秘境层 (筑基期+, Rank 15)
    {
        name: '五行秘境',
        type: 'SPECIAL',
        min_realm_rank: 15,
        safety_level: 'EXTREME_RISK',
        description: '蕴含五行之力的秘境，每7天开启一次。',
        resources: [
            { name: '筑基丹材料', type: 'material', rank: 3, cooldown: 604800, difficulty: 4 }
        ],
        events: [
            { name: '秘境奇遇', type: 'buff', description: '获得临时属性加成。', probability: 0.3 }
        ],
        connections: [],
        environment_cost: 100 // 100点/小时
    },
    {
        name: '轮回殿',
        type: 'SPECIAL',
        min_realm_rank: 15,
        safety_level: 'EXTREME_RISK',
        description: '神秘莫测的轮回殿，每15天开启一次。',
        resources: [
            { name: '特殊宝物', type: 'item', rank: 4, cooldown: 1296000, difficulty: 4 }
        ],
        connections: [],
        environment_cost: 100
    }
];

async function initMaps() {
    try {
        console.log('正在连接数据库...');
        await sequelize.authenticate();
        console.log('数据库连接成功。');

        console.log('正在同步 Map 表结构...');
        await Map.sync({ alter: true });

        console.log('正在导入/更新地图数据...');
        
        // 1. 创建地图
        const createdMaps = {};
        for (const data of mapData) {
            const [map, created] = await Map.upsert(data);
            createdMaps[data.name] = map; // 注意：upsert 返回 [instance, created]
            // 如果 upsert 不返回实例（视 sequelize 版本），则需 find
            if (!map) {
                 const found = await Map.findOne({ where: { name: data.name } });
                 createdMaps[data.name] = found;
            } else {
                 createdMaps[data.name] = map;
            }
        }

        // 2. 建立连接 (简单起见，手动指定连接)
        // 规则：相邻层级/同层级主要地图均设有固定传送点
        
        // 获取ID
        const getMapId = (name) => {
            const m = createdMaps[name];
            return m ? m.id : null;
        };

        const connectionsMap = {
            '青竹村': ['新手修炼谷', '黑风山脉'],
            '新手修炼谷': ['青竹村'],
            '黑风山脉': ['青竹村', '迷雾森林', '万妖岭'],
            '迷雾森林': ['黑风山脉'],
            '万妖岭': ['黑风山脉', '灵晶矿洞', '断魂崖'],
            '灵晶矿洞': ['万妖岭'],
            '断魂崖': ['万妖岭', '上古战场遗迹', '五行秘境'], // 假设秘境入口在这里
            '上古战场遗迹': ['断魂崖', '轮回殿'],
            '五行秘境': ['断魂崖'],
            '轮回殿': ['上古战场遗迹']
        };

        for (const [name, targets] of Object.entries(connectionsMap)) {
            const map = createdMaps[name];
            if (map) {
                const targetIds = targets.map(t => getMapId(t)).filter(id => id !== null);
                map.connections = targetIds;
                await map.save();
                console.log(`更新地图连接: ${name} -> [${targets.join(', ')}]`);
            }
        }

        console.log('地图数据导入完成！');
        process.exit(0);
    } catch (error) {
        console.error('导入失败:', error);
        process.exit(1);
    }
}

initMaps();
