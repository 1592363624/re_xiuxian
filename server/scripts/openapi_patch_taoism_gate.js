/**
 * OpenAPI 文档补丁脚本
 * 为太一门引道系统注入 9 个接口定义
 *
 * 接口列表：
 *   1. GET  /api/taoism-gate/profile       - 获取道途面板
 *   2. POST /api/taoism-gate/choose        - 选择道途
 *   3. POST /api/taoism-gate/switch        - 切换道途
 *   4. POST /api/taoism-gate/cultivate     - 引道修炼
 *   5. POST /api/taoism-gate/skill         - 使用道途技能
 *   6. GET  /api/taoism-gate/tasks         - 获取今日任务
 *   7. POST /api/taoism-gate/tasks/claim   - 领取任务奖励
 *   8. GET  /api/taoism-gate/ranking       - 获取道途排行榜
 *   9. GET  /api/taoism-gate/resonance     - 查询道途共鸣状态
 *
 * 运行：node server/scripts/openapi_patch_taoism_gate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 新增 schemas 定义
const newSchemas = {
    TaoismGateProfile: {
        type: 'object',
        description: '太一道途面板',
        properties: {
            gate: {
                type: 'object',
                properties: {
                    dao_path: { type: 'string', nullable: true, description: '当前道途key（metal/wood/water/fire/earth）' },
                    dao_path_name: { type: 'string', description: '道途名称' },
                    dao_path_description: { type: 'string', description: '道途描述' },
                    dao_path_color: { type: 'string', description: '道途主题色' },
                    dao_level: { type: 'integer', minimum: 1, maximum: 10, description: '道途等级' },
                    dao_level_title: { type: 'string', description: '等级标题' },
                    dao_exp: { type: 'integer', description: '当前道途经验' },
                    next_level_exp: { type: 'integer', nullable: true, description: '下一级所需经验' },
                    passive_bonus: {
                        type: 'object',
                        nullable: true,
                        properties: {
                            type: { type: 'string' },
                            value: { type: 'number' },
                            description: { type: 'string' }
                        }
                    }
                }
            },
            divine_sense: {
                type: 'object',
                properties: {
                    current: { type: 'integer' },
                    max: { type: 'integer' }
                }
            },
            skills: {
                type: 'array',
                items: { $ref: '#/components/schemas/TaoismGateSkill' }
            },
            daily_tasks: {
                type: 'array',
                items: { $ref: '#/components/schemas/TaoismGateTask' }
            },
            resonance: {
                type: 'object',
                properties: {
                    same_path_player_count: { type: 'integer' },
                    resonance_bonus: { type: 'number', description: '共鸣加成（0-0.5）' },
                    restraint_targets: { type: 'array', items: { type: 'string' } }
                }
            },
            stats: {
                type: 'object',
                properties: {
                    total_cultivate_count: { type: 'integer' },
                    total_skill_use_count: { type: 'integer' },
                    total_resonance_count: { type: 'integer' }
                }
            }
        }
    },
    TaoismGateSkill: {
        type: 'object',
        description: '道途技能信息',
        properties: {
            skill_id: { type: 'string' },
            skill_name: { type: 'string' },
            skill_description: { type: 'string' },
            skill_divine_sense_cost: { type: 'integer' },
            skill_cooldown_hours: { type: 'integer' },
            skill_min_level: { type: 'integer' },
            can_use: { type: 'boolean' },
            cooldown_end: { type: 'string', format: 'date-time', nullable: true },
            is_locked: { type: 'boolean' }
        }
    },
    TaoismGateTask: {
        type: 'object',
        description: '道途日常任务',
        properties: {
            task_type: { type: 'string', enum: ['cultivate', 'use_skill', 'resonance'] },
            task_name: { type: 'string' },
            task_description: { type: 'string' },
            target_count: { type: 'integer' },
            current_count: { type: 'integer' },
            completed: { type: 'boolean' },
            rewards_claimed: { type: 'boolean' },
            rewards: {
                type: 'object',
                properties: {
                    dao_exp: { type: 'integer' },
                    divine_sense: { type: 'integer' },
                    law_fragment_five_elements: { type: 'integer' }
                }
            }
        }
    },
    TaoismGateChooseRequest: {
        type: 'object',
        required: ['dao_path'],
        properties: {
            dao_path: { type: 'string', enum: ['metal', 'wood', 'water', 'fire', 'earth'], description: '道途key' }
        }
    },
    TaoismGateSwitchRequest: {
        type: 'object',
        required: ['dao_path'],
        properties: {
            dao_path: { type: 'string', enum: ['metal', 'wood', 'water', 'fire', 'earth'] }
        }
    },
    TaoismGateSkillRequest: {
        type: 'object',
        properties: {
            target_player_id: { type: 'integer', nullable: true, description: '目标玩家ID（攻击/探查/定身类技能需要）' },
            target_beast_id: { type: 'integer', nullable: true, description: '目标灵兽ID（攻击/恢复/定身类技能需要）' }
        }
    },
    TaoismGateClaimRequest: {
        type: 'object',
        required: ['task_index'],
        properties: {
            task_index: { type: 'integer', minimum: 0, description: '任务索引（0-based）' }
        }
    },
    TaoismGateRanking: {
        type: 'object',
        properties: {
            category: { type: 'string', enum: ['dao_level', 'total_skill_use', 'total_resonance'] },
            rankings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        rank: { type: 'integer' },
                        player_id: { type: 'integer' },
                        player_nickname: { type: 'string' },
                        dao_path: { type: 'string' },
                        dao_path_name: { type: 'string' },
                        dao_level: { type: 'integer' },
                        value: { type: 'integer' }
                    }
                }
            },
            total: { type: 'integer' },
            current_page: { type: 'integer' },
            total_pages: { type: 'integer' }
        }
    },
    TaoismGateResonance: {
        type: 'object',
        properties: {
            dao_path: { type: 'string', nullable: true },
            dao_path_name: { type: 'string', nullable: true },
            same_path_total: { type: 'integer' },
            same_path_advanced: { type: 'integer', description: '同道途5级以上玩家数' },
            resonance_bonus: { type: 'number' },
            resonance_description: { type: 'string' },
            restraint_targets: { type: 'array', items: { type: 'string' } }
        }
    }
};

// 新增 paths 定义
const newPaths = {
    '/api/taoism-gate/profile': {
        get: {
            tags: ['太一门引道'],
            summary: '获取道途面板',
            description: '获取玩家道途详情（含道途/等级/经验/技能/任务/共鸣信息）',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '道途面板',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string' },
                                    data: { $ref: '#/components/schemas/TaoismGateProfile' }
                                }
                            }
                        }
                    }
                },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/choose': {
        post: {
            tags: ['太一门引道'],
            summary: '选择道途（首次选择，免费）',
            description: '校验：境界≥元婴期(rank 18) + 神识≥200 + 尚未选择过道途',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/TaoismGateChooseRequest' }
                    }
                }
            },
            responses: {
                200: {
                    description: '选择成功',
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
                                            dao_path: { type: 'string' },
                                            dao_path_name: { type: 'string' },
                                            dao_level: { type: 'integer' },
                                            passive_bonus: { type: 'string' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: { description: '参数错误/境界不足/神识不足/已选道途' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/switch': {
        post: {
            tags: ['太一门引道'],
            summary: '切换道途（每月1次免费，之后消耗100五行法则碎片，7天冷却）',
            description: '切换后等级重置为1，保留50%经验',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/TaoismGateSwitchRequest' }
                    }
                }
            },
            responses: {
                200: {
                    description: '切换成功',
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
                                            dao_path: { type: 'string' },
                                            dao_path_name: { type: 'string' },
                                            dao_level: { type: 'integer', example: 1 },
                                            dao_exp: { type: 'integer' },
                                            fragment_consumed: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: { description: '参数错误/未选道途/同道途/冷却中/碎片不足' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/cultivate': {
        post: {
            tags: ['太一门引道'],
            summary: '引道修炼（消耗50神识获得道途经验，每日5次上限）',
            description: '获得经验 = 基础100 + 神识上限×50%',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '修炼成功',
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
                                            exp_gained: { type: 'integer' },
                                            dao_exp: { type: 'integer' },
                                            dao_level: { type: 'integer' },
                                            leveled_up: { type: 'boolean' },
                                            new_level: { type: 'integer' },
                                            divine_sense_left: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: { description: '未选道途/已达上限/神识不足/已满级' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/skill': {
        post: {
            tags: ['太一门引道'],
            summary: '使用道途技能（消耗神识，按道途不同有不同效果）',
            description: '5种道途技能：金锋裂魂（攻击）/木灵回春（恢复）/水镜映心（反弹盾）/火眼金睛（探查）/土牢定身（定身）。需道途等级≥5',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/TaoismGateSkillRequest' }
                    }
                }
            },
            responses: {
                200: {
                    description: '技能使用成功',
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
                                            skill_id: { type: 'string' },
                                            skill_name: { type: 'string' },
                                            skill_result: { type: 'object' },
                                            exp_gained: { type: 'integer' },
                                            divine_sense_left: { type: 'integer' },
                                            cooldown_end: { type: 'string', format: 'date-time' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: { description: '未选道途/等级不足/冷却中/神识不足/参数错误' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/tasks': {
        get: {
            tags: ['太一门引道'],
            summary: '获取今日任务（每日3个，跨日重置）',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '任务列表',
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
                                            tasks: {
                                                type: 'array',
                                                items: { $ref: '#/components/schemas/TaoismGateTask' }
                                            },
                                            reset_time: { type: 'string', format: 'date-time' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/tasks/claim': {
        post: {
            tags: ['太一门引道'],
            summary: '领取任务奖励',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/TaoismGateClaimRequest' }
                    }
                }
            },
            responses: {
                200: {
                    description: '领取成功',
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
                                            task_name: { type: 'string' },
                                            rewards: { type: 'object' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: { description: '未选道途/索引无效/未完成/已领取' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/ranking': {
        get: {
            tags: ['太一门引道'],
            summary: '获取道途排行榜',
            description: '排行类别：dao_level（道途等级）/total_skill_use（技能使用次数）/total_resonance（共鸣次数）',
            security: [{ bearerAuth: [] }],
            parameters: [
                { name: 'category', in: 'query', schema: { type: 'string', enum: ['dao_level', 'total_skill_use', 'total_resonance'] }, default: 'dao_level' },
                { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 }, default: 1 },
                { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 }, default: 20 }
            ],
            responses: {
                200: {
                    description: '排行榜',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string' },
                                    data: { $ref: '#/components/schemas/TaoismGateRanking' }
                                }
                            }
                        }
                    }
                },
                400: { description: '无效排行类别' },
                401: { description: '未授权' }
            }
        }
    },
    '/api/taoism-gate/resonance': {
        get: {
            tags: ['太一门引道'],
            summary: '查询道途共鸣状态',
            description: '同道途玩家数+当前共鸣加成+相克目标。共鸣加成：2人+10%/3人+20%/4人+30%/5人+50%（封顶）',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '共鸣状态',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string' },
                                    data: { $ref: '#/components/schemas/TaoismGateResonance' }
                                }
                            }
                        }
                    }
                },
                401: { description: '未授权' }
            }
        }
    }
};

// 主函数：合并 schemas + paths + tag
function patchOpenAPI() {
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error(`❌ OpenAPI 文档不存在: ${OPENAPI_PATH}`);
        process.exit(1);
    }

    const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf-8'));
    const beforePaths = Object.keys(openapi.paths || {}).length;
    const beforeSchemas = Object.keys(openapi.components?.schemas || {}).length;
    const beforeTags = (openapi.tags || []).length;

    // 1. 注入 schemas
    if (!openapi.components) openapi.components = {};
    if (!openapi.components.schemas) openapi.components.schemas = {};
    let addedSchemas = 0;
    for (const [name, schema] of Object.entries(newSchemas)) {
        if (!openapi.components.schemas[name]) {
            openapi.components.schemas[name] = schema;
            addedSchemas++;
        }
    }

    // 2. 注入 paths
    if (!openapi.paths) openapi.paths = {};
    let addedPaths = 0;
    for (const [p, def] of Object.entries(newPaths)) {
        if (!openapi.paths[p]) {
            openapi.paths[p] = def;
            addedPaths++;
        }
    }

    // 3. 注入 tag
    if (!openapi.tags) openapi.tags = [];
    const tagName = '太一门引道';
    if (!openapi.tags.find(t => t.name === tagName)) {
        openapi.tags.push({
            name: tagName,
            description: '太一门引道系统（玩法文档第25节）：五行道途+神识联动+多人共鸣'
        });
    }

    // 4. 写回
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf-8');

    console.log('========================================================');
    console.log('  OpenAPI 文档太一门引道补丁完成');
    console.log('========================================================');
    console.log(`  paths:   ${beforePaths} → ${Object.keys(openapi.paths).length} (+${addedPaths})`);
    console.log(`  schemas: ${beforeSchemas} → ${Object.keys(openapi.components.schemas).length} (+${addedSchemas})`);
    console.log(`  tags:    ${beforeTags} → ${openapi.tags.length} (+${openapi.tags.length - beforeTags})`);
    console.log('========================================================');
}

patchOpenAPI();
