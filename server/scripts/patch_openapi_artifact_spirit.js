/**
 * OpenAPI 补丁脚本：为器灵系统添加 9 个接口路径定义
 *
 * 对应玩法文档第7节/第895-909行 法宝、器灵与徽章
 * 幂等：重复执行不会重复添加路径
 *
 * 运行方式：node scripts/patch_openapi_artifact_spirit.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));

if (!openapi.paths) openapi.paths = {};

/** 器灵系统 9 个接口路径定义 */
const artifactSpiritPaths = {
    '/api/artifact-spirit/awaken': {
        post: {
            tags: ['器灵系统'],
            summary: '唤醒器灵',
            description: '消耗灵石+物品，在指定已装备法宝上唤醒器灵。筑基期(rank=3)解锁。成功率=基础80%+祭炼等级*2%（最高98%）。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['equipment_id', 'spirit_type'],
                            properties: {
                                equipment_id: { type: 'integer', description: '装备记录ID（player_equipment.id）', example: 123 },
                                spirit_type: { type: 'string', enum: ['attack', 'defense', 'support', 'balance'], description: '器灵类型' },
                                spirit_name: { type: 'string', maxLength: 50, description: '器灵自定义名称（可选）' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '唤醒结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            spirit_type: { type: 'string' },
                                            spirit_name: { type: 'string', nullable: true },
                                            spirit_level: { type: 'integer', example: 1 },
                                            intimacy: { type: 'integer', example: 10 },
                                            power: { type: 'integer', example: 50 },
                                            success_rate: { type: 'number', example: 0.82 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/list': {
        get: {
            tags: ['器灵系统'],
            summary: '我的器灵列表',
            description: '获取玩家所有已唤醒器灵列表（含装备配置合并展示）',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '器灵列表',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirits: { type: 'array', items: { type: 'object' } },
                                            count: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/trial-ranking': {
        get: {
            tags: ['器灵系统'],
            summary: '器灵试炼榜',
            description: '全服试炼累计分排行（多人竞争维度），按 trial_total_score 降序排列',
            security: [{ bearerAuth: [] }],
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }
            ],
            responses: {
                200: {
                    description: '试炼榜数据',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            ranking: { type: 'array', items: { type: 'object' } },
                                            my_rank: { type: 'integer' },
                                            my_spirit: { type: 'object', nullable: true },
                                            total: { type: 'integer' },
                                            page: { type: 'integer' },
                                            page_size: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/{spirit_id}': {
        get: {
            tags: ['器灵系统'],
            summary: '器灵详情',
            description: '获取指定器灵完整状态（含冷却时间、试炼记录、护主/催发状态）',
            security: [{ bearerAuth: [] }],
            parameters: [
                { name: 'spirit_id', in: 'path', required: true, schema: { type: 'integer' } }
            ],
            responses: {
                200: {
                    description: '器灵详情',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            spirit_type: { type: 'string' },
                                            spirit_level: { type: 'integer' },
                                            intimacy: { type: 'integer' },
                                            power: { type: 'integer' },
                                            cooldowns: { type: 'object' },
                                            daily_trial_count: { type: 'integer' },
                                            daily_trial_limit: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/trial': {
        post: {
            tags: ['器灵系统'],
            summary: '器灵试炼',
            description: '按器灵战力评分获取奖励（经验/灵石/力量值），每日3次。累计分进入排行榜。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['spirit_id'],
                            properties: {
                                spirit_id: { type: 'integer', description: '器灵记录ID' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '试炼结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            score: { type: 'integer' },
                                            is_best_score: { type: 'boolean' },
                                            rewards: { type: 'object' },
                                            spirit_level: { type: 'integer' },
                                            leveled_up: { type: 'boolean' },
                                            daily_trial_count: { type: 'integer' },
                                            daily_trial_limit: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/protect': {
        post: {
            tags: ['器灵系统'],
            summary: '器灵护主',
            description: '开启限时护主状态（5分钟），消耗5亲密度，CD 30分钟。护主时触发减伤/反弹/回血。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['spirit_id'],
                            properties: {
                                spirit_id: { type: 'integer' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '护主开启结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            active_until: { type: 'string', format: 'date-time' },
                                            duration_seconds: { type: 'integer' },
                                            intimacy_cost: { type: 'integer' },
                                            intimacy_remaining: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/activate': {
        post: {
            tags: ['器灵系统'],
            summary: '催发器灵',
            description: '限时属性爆发（3分钟），消耗50力量值，CD 1小时。催发时属性倍率1.5x。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['spirit_id'],
                            properties: {
                                spirit_id: { type: 'integer' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '催发开启结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            active_until: { type: 'string', format: 'date-time' },
                                            duration_seconds: { type: 'integer' },
                                            power_cost: { type: 'integer' },
                                            power_remaining: { type: 'integer' },
                                            bonus_multiplier: { type: 'number', example: 1.5 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/pet': {
        post: {
            tags: ['器灵系统'],
            summary: '抚摸法宝',
            description: '增加亲密度+经验，CD 1小时。每次亲密度+5，经验+20。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['spirit_id'],
                            properties: {
                                spirit_id: { type: 'integer' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '抚摸结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            intimacy_gain: { type: 'integer' },
                                            intimacy: { type: 'integer' },
                                            exp_gain: { type: 'integer' },
                                            spirit_level: { type: 'integer' },
                                            leveled_up: { type: 'boolean' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    '/api/artifact-spirit/nurture': {
        post: {
            tags: ['器灵系统'],
            summary: '温养器灵',
            description: '增加力量值，CD 2小时，消耗1000灵石。每次力量值+20。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['spirit_id'],
                            properties: {
                                spirit_id: { type: 'integer' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '温养结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            spirit_id: { type: 'integer' },
                                            power_gain: { type: 'integer' },
                                            power: { type: 'integer' },
                                            power_max: { type: 'integer' },
                                            spirit_stones_cost: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

// 合并路径（幂等：直接覆盖）
let added = 0;
for (const [pathKey, pathDef] of Object.entries(artifactSpiritPaths)) {
    if (!openapi.paths[pathKey]) {
        added++;
    }
    openapi.paths[pathKey] = pathDef;
}

// 确保 tags 含器灵系统
if (!openapi.tags) openapi.tags = [];
if (!openapi.tags.find(t => t.name === '器灵系统')) {
    openapi.tags.push({ name: '器灵系统', description: '法宝器灵养成与多人试炼竞技（玩法文档第7节）' });
}

// 写回文件
fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf-8');
console.log(`[OpenAPI 补丁] 器灵系统路径添加完成：新增 ${added} 个，总计 ${Object.keys(artifactSpiritPaths).length} 个路径`);
