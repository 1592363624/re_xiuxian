/**
 * OpenAPI 文档补丁脚本：为 PVP 战斗中使用丹药功能注入接口定义
 *
 * 新增路径：
 *   GET /api/pvp/battle-items — 获取当前战斗中可使用的丹药列表
 *
 * 修改路径：
 *   POST /api/pvp/action — action 参数新增 'item' 类型
 *
 * 运行方式：node scripts/openapi_patch_pvp_battle_items.js
 * 幂等：重复执行不会产生重复路径定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

// openapi.json 位于项目根目录 docs/ 下
const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');

if (!fs.existsSync(openapiPath)) {
    console.error(`❌ OpenAPI 文件不存在：${openapiPath}`);
    process.exit(1);
}

const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
let modified = false;

// ===== 1. 新增 GET /api/pvp/battle-items 路径 =====
const battleItemsPath = '/api/pvp/battle-items';
if (!openapi.paths[battleItemsPath]) {
    openapi.paths[battleItemsPath] = {
        get: {
            tags: ['PVP 斗法'],
            summary: '获取战斗中可使用的丹药列表',
            description: '查询玩家背包中可在 PVP 战斗中使用的消耗品（回春丹/小还丹/大还丹/凝气丹/聚灵丹等），返回物品名称、效果、持有数量及本场剩余使用次数。需在 PVP 战斗进行中调用。',
            operationId: 'getPvpBattleItems',
            security: [{ bearerAuth: [] }],
            responses: {
                '200': {
                    description: '成功获取丹药列表',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            items: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        item_id: { type: 'string', example: 'mid_healing_pill' },
                                                        name: { type: 'string', example: '小还丹' },
                                                        description: { type: 'string', example: '恢复中等气血' },
                                                        subtype: { type: 'string', example: 'healing', description: 'healing=恢复气血 / mana=恢复灵力' },
                                                        quality: { type: 'string', example: 'uncommon' },
                                                        effect: {
                                                            type: 'object',
                                                            properties: {
                                                                hp_restore: { type: 'integer', example: 50 },
                                                                mp_restore: { type: 'integer', example: 0 }
                                                            }
                                                        },
                                                        quantity: { type: 'integer', example: 5, description: '背包持有数量' }
                                                    }
                                                }
                                            },
                                            remaining_uses: { type: 'integer', example: 3, description: '本场剩余使用次数' },
                                            max_uses: { type: 'integer', example: 3, description: '每场上限次数' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '401': { $ref: '#/components/responses/Unauthorized' }
            }
        }
    };
    modified = true;
    console.log(`✅ 新增路径：${battleItemsPath}`);
} else {
    console.log(`⏭️ 路径已存在：${battleItemsPath}`);
}

// ===== 2. 更新 POST /api/pvp/action 的 action 参数描述 =====
const actionPath = '/api/pvp/action';
if (openapi.paths[actionPath]?.post?.requestBody?.content?.['application/json']?.schema?.properties?.action) {
    const actionProp = openapi.paths[actionPath].post.requestBody.content['application/json'].schema.properties.action;
    // 更新 action 枚举值和描述
    if (!actionProp.enum?.includes('item')) {
        actionProp.enum = ['attack', 'skill', 'defend', 'item'];
        actionProp.description = '行动类型：attack(攻击) / skill(技能) / defend(防御) / item(使用丹药)。action=item 时 skill_index 传物品ID字符串';
        modified = true;
        console.log(`✅ 更新路径：${actionPath} 的 action 参数新增 item 类型`);
    } else {
        console.log(`⏭️ 路径 ${actionPath} 的 action 参数已包含 item`);
    }
    // 更新 skill_index 描述
    const skillIndexProp = openapi.paths[actionPath].post.requestBody.content['application/json'].schema.properties.skill_index;
    if (skillIndexProp) {
        skillIndexProp.description = '技能槽位（仅 skill 动作有效）；action=item 时传物品ID字符串（如 mid_healing_pill）';
    }
} else {
    console.log(`⚠️ 路径 ${actionPath} 未找到，跳过 action 参数更新`);
}

if (modified) {
    fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf-8');
    console.log('\n✅ OpenAPI 文档已更新并保存');
} else {
    console.log('\n⏭️ 无需修改，文档已是最新');
}
