/**
 * OpenAPI 文档补丁脚本：为洞府拜访奇遇系统更新接口定义
 *
 * 修改路径：
 *   POST /api/cave-social/visit — 响应新增 encounter 字段（奇遇结果）
 *
 * 运行方式：node scripts/openapi_patch_cave_encounters.js
 * 幂等：重复执行不会产生重复定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');

if (!fs.existsSync(openapiPath)) {
    console.error(`❌ OpenAPI 文件不存在：${openapiPath}`);
    process.exit(1);
}

const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
let modified = false;

// ===== 更新 POST /api/cave-social/visit 响应定义 =====
const visitPath = '/api/cave-social/visit';
if (openapi.paths[visitPath]?.post?.responses?.['200']) {
    const response = openapi.paths[visitPath].post.responses['200'];
    // 确保响应中有 content.application/json.schema
    if (!response.content?.['application/json']?.schema) {
        response.content = response.content || {};
        response.content['application/json'] = response.content['application/json'] || {};
        response.content['application/json'].schema = { type: 'object' };
    }
    const schema = response.content['application/json'].schema;
    // 确保 schema 有 properties
    if (!schema.properties) {
        schema.properties = {};
    }

    // 添加 encounter 字段到 data 的 properties
    if (!schema.properties.data) {
        schema.properties.data = { type: 'object', properties: {} };
    }
    if (!schema.properties.data.properties) {
        schema.properties.data.properties = {};
    }

    // 添加 encounter 字段定义
    if (!schema.properties.data.properties.encounter) {
        schema.properties.data.properties.encounter = {
            type: 'object',
            nullable: true,
            description: '拜访奇遇结果（null 表示未触发奇遇功能）',
            properties: {
                triggered: { type: 'boolean', description: '是否触发了奇遇' },
                reason: { type: 'string', description: '未触发原因（triggered=false 时有值）', nullable: true },
                encounter_id: { type: 'string', description: '奇遇ID', nullable: true, example: 'treasure_pill' },
                name: { type: 'string', description: '奇遇名称', nullable: true, example: '发现遗落丹药' },
                description: { type: 'string', description: '奇遇描述', nullable: true },
                type: { type: 'string', description: '奇遇类型', nullable: true, enum: ['item', 'exp', 'spirit_stone', 'trap', 'nothing'] },
                rewards: {
                    type: 'object',
                    nullable: true,
                    description: '奇遇奖励',
                    properties: {
                        item_id: { type: 'string', nullable: true },
                        item_name: { type: 'string', nullable: true },
                        item_count: { type: 'integer', nullable: true },
                        exp: { type: 'integer', nullable: true },
                        spirit_stone: { type: 'integer', nullable: true },
                        hp_loss: { type: 'integer', nullable: true }
                    }
                },
                today_encounters: { type: 'integer', description: '今日已触发奇遇次数', nullable: true },
                daily_limit: { type: 'integer', description: '每日奇遇上限', nullable: true }
            }
        };
        modified = true;
        console.log(`✅ 更新路径：${visitPath} 响应新增 encounter 字段定义`);
    } else {
        console.log(`⏭️ 路径 ${visitPath} 响应已包含 encounter 字段`);
    }

    // 添加 encounter_id/encounter_reward 到访客记录响应
    const visitorsPath = '/api/cave-social/visitors';
    if (openapi.paths[visitorsPath]?.get?.responses?.['200']) {
        const visResponse = openapi.paths[visitorsPath].get.responses['200'];
        if (visResponse.content?.['application/json']?.schema?.properties?.data?.properties?.visitors?.items?.properties) {
            const visItemProps = visResponse.content['application/json'].schema.properties.data.properties.visitors.items.properties;
            if (!visItemProps.encounter_type) {
                visItemProps.encounter_type = { type: 'string', nullable: true, description: '奇遇类型ID（null=未触发奇遇）' };
                visItemProps.encounter_reward = { type: 'object', nullable: true, description: '奇遇奖励 JSON' };
                modified = true;
                console.log(`✅ 更新路径：${visitorsPath} 访客记录新增 encounter_type/encounter_reward 字段`);
            } else {
                console.log(`⏭️ 路径 ${visitorsPath} 访客记录已包含 encounter 字段`);
            }
        }
    }
} else {
    console.log(`⚠️ 路径 ${visitPath} 未找到，跳过更新`);
}

if (modified) {
    fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf-8');
    console.log('\n✅ OpenAPI 文档已更新并保存');
} else {
    console.log('\n⏭️ 无需修改，文档已是最新');
}
