/**
 * OpenAPI 补丁脚本：灵兽探渊系统
 *
 * 向 docs/openapi.json 注入灵兽探渊系统的 8 个接口定义：
 *   1. GET  /api/spirit-beast/abyss/floors     - 获取可用深渊层数列表
 *   2. POST /api/spirit-beast/abyss/start      - 开始探渊
 *   3. POST /api/spirit-beast/abyss/recall     - 召回灵兽
 *   4. GET  /api/spirit-beast/abyss/status     - 获取当前探渊状态
 *   5. GET  /api/spirit-beast/abyss/history    - 获取探渊历史
 *   6. GET  /api/spirit-beast/abyss/encounters - 获取遭遇历史
 *   7. GET  /api/spirit-beast/abyss/ranking    - 获取排行榜
 *   8. GET  /api/spirit-beast/abyss/config     - 获取探渊配置
 *
 * 特性：
 *   - 幂等：重复运行不会重复添加
 *   - 安全：仅修改 openapi.json，不触碰其他文件
 *   - 完整：包含所有 schemas 定义
 *
 * 运行：node server/scripts/openapi_patch_beast_abyss.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '../../docs/openapi.json');

/**
 * 灵兽探渊系统标签定义
 */
const TAG_BEAST_ABYSS = {
    name: '灵兽探渊系统',
    description: '灵兽探渊系统（玩法文档第24节）：9层深渊按境界解锁，异步多人PVE+PVP混合探索玩法。包含PVE怪物战斗、PVP玩家灵兽遭遇、宝箱/陷阱事件、兽魂凝练、体力/受伤机制、排行榜等。'
};

/**
 * 通用错误响应 schema 引用
 */
const errorResponseRef = { $ref: '#/components/schemas/ErrorResponse' };
const authHeader = {
    description: 'JWT 用户认证令牌（格式：Bearer <token>）',
    schema: { type: 'string', example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }
};

/**
 * 安全响应包装
 */
const securitySchemes = [{ bearerAuth: [] }];

/**
 * 构造路径定义
 */
function buildPaths() {
    return {
        // 1. 获取深渊层数列表
        '/api/spirit-beast/abyss/floors': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取可用深渊层数列表',
                description: '按玩家当前境界过滤可探渊的深渊层数。层数越高，怪物越强但奖励倍率越高。返回同时探渊上限、每日次数限制、时长范围等约束。',
                security: securitySchemes,
                parameters: [{
                    name: 'Authorization',
                    in: 'header',
                    required: true,
                    ...authHeader
                }],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssFloorsResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 2. 开始探渊
        '/api/spirit-beast/abyss/start': {
            post: {
                tags: ['灵兽探渊系统'],
                summary: '开始探渊',
                description: '指定灵兽和时长开始探渊。校验：灵兽属于玩家、未出战/放养/探渊中、体力充足、未达每日次数上限、未达同时探渊上限、时长在1-4小时之间、玩家境界达到层数要求。',
                security: securitySchemes,
                parameters: [{
                    name: 'Authorization',
                    in: 'header',
                    required: true,
                    ...authHeader
                }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/BeastAbyssStartRequest' }
                        }
                    }
                },
                responses: {
                    200: {
                        description: '探渊开始成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssStartResponse' }
                            }
                        }
                    },
                    400: { description: '参数错误或业务校验失败', content: { 'application/json': { schema: errorResponseRef } } },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 3. 召回灵兽
        '/api/spirit-beast/abyss/recall': {
            post: {
                tags: ['灵兽探渊系统'],
                summary: '召回灵兽',
                description: '手动召回探渊中的灵兽并结算奖励。召回类型：early（提前召回，奖励按30%经验/50%灵石结算）、manual（正常召回）、auto（超期自动召回，由调度器触发）。结算时一次性模拟探渊期间所有遭遇事件。',
                security: securitySchemes,
                parameters: [{
                    name: 'Authorization',
                    in: 'header',
                    required: true,
                    ...authHeader
                }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/BeastAbyssRecallRequest' }
                        }
                    }
                },
                responses: {
                    200: {
                        description: '召回成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssRecallResponse' }
                            }
                        }
                    },
                    400: { description: '参数错误或灵兽不在探渊中', content: { 'application/json': { schema: errorResponseRef } } },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 4. 获取当前探渊状态
        '/api/spirit-beast/abyss/status': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取当前探渊状态',
                description: '返回玩家当前所有活跃探渊记录，含剩余秒数、是否到期、最深层数、PVP统计等。前端可用于实时展示探渊进度。',
                security: securitySchemes,
                parameters: [{
                    name: 'Authorization',
                    in: 'header',
                    required: true,
                    ...authHeader
                }],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssStatusResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 5. 获取探渊历史
        '/api/spirit-beast/abyss/history': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取探渊历史',
                description: '分页返回玩家已结算的探渊记录（按创建时间倒序），含召回类型、最深层数、PVP统计、奖励快照等。',
                security: securitySchemes,
                parameters: [
                    { name: 'Authorization', in: 'header', required: true, ...authHeader },
                    { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 } },
                    { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 } }
                ],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssHistoryResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 6. 获取遭遇历史
        '/api/spirit-beast/abyss/encounters': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取遭遇历史',
                description: '分页返回玩家探渊期间的遭遇日志（怪物战斗/宝箱/陷阱/PVP），含遭遇类型、结果、获得经验/灵石/物品/兽魂等详情。',
                security: securitySchemes,
                parameters: [
                    { name: 'Authorization', in: 'header', required: true, ...authHeader },
                    { name: 'explore_id', in: 'query', required: false, schema: { type: 'integer', description: '指定探渊记录ID过滤' } },
                    { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 } },
                    { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 20, minimum: 1, maximum: 50 } }
                ],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssEncountersResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 7. 获取排行榜
        '/api/spirit-beast/abyss/ranking': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取排行榜',
                description: '获取三类排行榜：deepest_floor（最深层数，按探渊记录聚合）/ total_explore_count（累计探渊次数，按玩家聚合）/ total_pvp_wins（累计PVP胜利数，按玩家聚合）。',
                security: securitySchemes,
                parameters: [
                    { name: 'Authorization', in: 'header', required: true, ...authHeader },
                    { name: 'category', in: 'query', required: false, schema: { type: 'string', enum: ['deepest_floor', 'total_explore_count', 'total_pvp_wins'], default: 'deepest_floor' } },
                    { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 } },
                    { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 20, minimum: 1, maximum: 50 } }
                ],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssRankingResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        },

        // 8. 获取探渊配置
        '/api/spirit-beast/abyss/config': {
            get: {
                tags: ['灵兽探渊系统'],
                summary: '获取探渊配置',
                description: '返回探渊系统的全局配置，含体力上限、每次消耗、每日次数限制、同时探渊上限、时长范围、事件类型概率、召回惩罚比例、兽魂凝练比例等。前端用于展示规则说明。',
                security: securitySchemes,
                parameters: [{
                    name: 'Authorization',
                    in: 'header',
                    required: true,
                    ...authHeader
                }],
                responses: {
                    200: {
                        description: '获取成功',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BeastAbyssConfigResponse' }
                            }
                        }
                    },
                    401: { description: '未授权', content: { 'application/json': { schema: errorResponseRef } } }
                }
            }
        }
    };
}

/**
 * 构造 schemas 定义
 */
function buildSchemas() {
    return {
        // 请求 schemas
        BeastAbyssStartRequest: {
            type: 'object',
            required: ['beast_id', 'duration_hours'],
            properties: {
                beast_id: { type: 'integer', description: '灵兽ID', example: 1 },
                duration_hours: { type: 'number', description: '探渊时长（小时，1-4）', example: 2, minimum: 1, maximum: 4 }
            }
        },
        BeastAbyssRecallRequest: {
            type: 'object',
            required: ['beast_id'],
            properties: {
                beast_id: { type: 'integer', description: '要召回的灵兽ID', example: 1 }
            }
        },

        // 响应 schemas
        BeastAbyssFloorsResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        floors: {
                            type: 'array',
                            description: '可探渊的层数列表（按境界过滤）',
                            items: { $ref: '#/components/schemas/BeastAbyssFloorInfo' }
                        },
                        total_floors: { type: 'integer', description: '总层数（9）', example: 9 },
                        available_floors: { type: 'integer', description: '当前可用层数', example: 8 },
                        max_concurrent_beasts: { type: 'integer', description: '同时探渊灵兽数上限', example: 2 },
                        min_duration_hours: { type: 'integer', description: '最短探渊时长（小时）', example: 1 },
                        max_duration_hours: { type: 'integer', description: '最长探渊时长（小时）', example: 4 },
                        daily_explore_limit: { type: 'integer', description: '每日探渊次数上限（玩家级）', example: 3 },
                        stamina_max: { type: 'integer', description: '体力上限', example: 100 }
                    }
                }
            }
        },
        BeastAbyssFloorInfo: {
            type: 'object',
            properties: {
                floor: { type: 'integer', description: '层数（1-9）', example: 1 },
                name: { type: 'string', description: '层数名称', example: '浅渊入口' },
                description: { type: 'string', description: '层数描述', example: '深渊入口，低阶修士的试炼之地' },
                min_realm_rank: { type: 'integer', description: '解锁所需境界rank', example: 1 },
                stamina_cost_per_floor: { type: 'integer', description: '每层体力消耗', example: 10 },
                monster_difficulty: { type: 'number', description: '怪物难度系数', example: 1.0 },
                pvp_encounter_rate: { type: 'number', description: 'PVP遭遇概率', example: 0.15 },
                reward_multiplier: { type: 'number', description: '奖励倍率', example: 1.0 },
                available: { type: 'boolean', description: '当前玩家是否可进入', example: true }
            }
        },
        BeastAbyssStartResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        explore_id: { type: 'integer', description: '探渊记录ID', example: 14 },
                        beast_id: { type: 'integer', description: '灵兽ID', example: 1 },
                        start_floor: { type: 'integer', description: '起始层数', example: 1 },
                        duration_hours: { type: 'number', description: '探渊时长（小时）', example: 1 },
                        start_time: { type: 'string', format: 'date-time', description: '开始时间' },
                        end_time: { type: 'string', format: 'date-time', description: '预计结束时间' },
                        stamina_left: { type: 'integer', description: '探渊后剩余体力', example: 0 }
                    }
                }
            }
        },
        BeastAbyssRecallResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        explore_id: { type: 'integer', description: '探渊记录ID', example: 14 },
                        recall_type: { type: 'string', enum: ['early', 'manual', 'auto'], description: '召回类型', example: 'early' },
                        status: { type: 'string', enum: ['recalled', 'injured', 'completed'], description: '结算状态', example: 'recalled' },
                        max_floor_reached: { type: 'integer', description: '到达的最深层数', example: 3 },
                        monster_kills: { type: 'integer', description: '击杀怪物数', example: 5 },
                        treasures_found: { type: 'integer', description: '发现宝箱数', example: 2 },
                        traps_triggered: { type: 'integer', description: '触发陷阱数', example: 1 },
                        pvp_encounters: { type: 'integer', description: 'PVP遭遇次数', example: 1 },
                        pvp_wins: { type: 'integer', description: 'PVP胜利次数', example: 1 },
                        pvp_losses: { type: 'integer', description: 'PVP失败次数', example: 0 },
                        rewards: { $ref: '#/components/schemas/BeastAbyssRewards' },
                        events: {
                            type: 'array',
                            description: '本次探渊的所有遭遇事件',
                            items: { $ref: '#/components/schemas/BeastAbyssEvent' }
                        }
                    }
                }
            }
        },
        BeastAbyssRewards: {
            type: 'object',
            description: '探渊奖励汇总',
            properties: {
                exp_gained: { type: 'integer', description: '灵兽获得经验', example: 1500 },
                spirit_stones_gained: { type: 'integer', description: '玩家获得灵石', example: 200 },
                beast_soul_gained: { type: 'integer', description: '凝练兽魂数（满级灵兽专有）', example: 2 },
                items_gained: {
                    type: 'array',
                    description: '获得的物品列表',
                    items: {
                        type: 'object',
                        properties: {
                            item_key: { type: 'string', example: 'spirit_herb' },
                            quantity: { type: 'integer', example: 3 }
                        }
                    }
                }
            }
        },
        BeastAbyssEvent: {
            type: 'object',
            description: '单次遭遇事件',
            properties: {
                floor: { type: 'integer', description: '发生层数', example: 2 },
                encounter_type: { type: 'string', enum: ['monster', 'treasure', 'trap', 'pvp'], description: '遭遇类型', example: 'monster' },
                encounter_detail: { type: 'string', description: '遭遇详情（怪物名/宝箱名/陷阱名/对手灵兽名）', example: '深渊魔狼' },
                result: { type: 'string', description: '遭遇结果（胜/败/获得/触发等）', example: '胜利' },
                hp_after: { type: 'integer', description: '遭遇后灵兽HP', example: 850 },
                stamina_after: { type: 'integer', description: '遭遇后灵兽体力', example: 80 },
                exp_gained: { type: 'integer', description: '获得经验', example: 200 },
                spirit_stones_gained: { type: 'integer', description: '获得灵石', example: 50 },
                beast_soul_gained: { type: 'integer', description: '获得兽魂', example: 0 },
                items_gained: { type: 'string', description: '获得物品（JSON字符串）', example: '[]' },
                opponent_player_id: { type: 'integer', description: 'PVP对手玩家ID', nullable: true, example: 5 },
                opponent_beast_name: { type: 'string', description: 'PVP对手灵兽名', nullable: true, example: '青云狼' }
            }
        },
        BeastAbyssStatusResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        active_explores: {
                            type: 'array',
                            description: '当前活跃探渊列表',
                            items: { $ref: '#/components/schemas/BeastAbyssActiveExplore' }
                        },
                        active_count: { type: 'integer', description: '活跃探渊数', example: 1 },
                        max_concurrent: { type: 'integer', description: '同时探渊上限', example: 2 }
                    }
                }
            }
        },
        BeastAbyssActiveExplore: {
            type: 'object',
            properties: {
                explore_id: { type: 'integer', example: 14 },
                beast_id: { type: 'integer', example: 1 },
                beast_name: { type: 'string', example: '青云狼' },
                start_floor: { type: 'integer', example: 1 },
                max_floor_reached: { type: 'integer', example: 1 },
                duration_hours: { type: 'number', example: 1 },
                start_time: { type: 'string', format: 'date-time' },
                end_time: { type: 'string', format: 'date-time' },
                remaining_seconds: { type: 'integer', description: '剩余秒数', example: 3540 },
                is_expired: { type: 'boolean', description: '是否已到期', example: false }
            }
        },
        BeastAbyssHistoryResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        history: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/BeastAbyssHistoryItem' }
                        },
                        total: { type: 'integer', example: 15 },
                        current_page: { type: 'integer', example: 1 },
                        total_pages: { type: 'integer', example: 2 }
                    }
                }
            }
        },
        BeastAbyssHistoryItem: {
            type: 'object',
            properties: {
                id: { type: 'integer', example: 14 },
                beast_id: { type: 'integer', example: 1 },
                beast_snapshot: { type: 'object', description: '灵兽快照（含探渊时的属性）' },
                start_floor: { type: 'integer', example: 1 },
                max_floor_reached: { type: 'integer', example: 3 },
                duration_hours: { type: 'number', example: 2 },
                start_time: { type: 'string', format: 'date-time' },
                end_time: { type: 'string', format: 'date-time' },
                actual_end_time: { type: 'string', format: 'date-time' },
                status: { type: 'string', enum: ['active', 'recalled', 'injured', 'completed'], example: 'recalled' },
                recall_type: { type: 'string', enum: ['early', 'manual', 'auto'], example: 'early' },
                pvp_encounters: { type: 'integer', example: 1 },
                pvp_wins: { type: 'integer', example: 1 },
                pvp_losses: { type: 'integer', example: 0 },
                monster_kills: { type: 'integer', example: 5 },
                treasures_found: { type: 'integer', example: 2 },
                traps_triggered: { type: 'integer', example: 1 },
                stamina_used: { type: 'integer', example: 100 },
                beast_soul_gained: { type: 'integer', example: 2 },
                rewards_snapshot: { type: 'object', description: '奖励快照' }
            }
        },
        BeastAbyssEncountersResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        encounters: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/BeastAbyssEvent' }
                        },
                        total: { type: 'integer', example: 10 },
                        current_page: { type: 'integer', example: 1 },
                        total_pages: { type: 'integer', example: 1 }
                    }
                }
            }
        },
        BeastAbyssRankingResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        category: { type: 'string', enum: ['deepest_floor', 'total_explore_count', 'total_pvp_wins'], example: 'deepest_floor' },
                        rankings: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    rank: { type: 'integer', description: '名次', example: 1 },
                                    player_id: { type: 'integer', example: 1 },
                                    player_nickname: { type: 'string', example: '测试管理员' },
                                    value: { type: 'integer', description: '排名依据的数值（最深层数/累计次数/累计PVP胜数）', example: 7 },
                                    beast_name: { type: 'string', description: '灵兽名（仅 deepest_floor 类别）', example: '青云狼', nullable: true }
                                }
                            }
                        },
                        total: { type: 'integer', example: 20 },
                        current_page: { type: 'integer', example: 1 },
                        total_pages: { type: 'integer', example: 1 },
                        my_rank: { type: 'integer', description: '我的名次（未上榜为null）', example: 1, nullable: true }
                    }
                }
            }
        },
        BeastAbyssConfigResponse: {
            type: 'object',
            properties: {
                code: { type: 'integer', example: 200 },
                data: {
                    type: 'object',
                    properties: {
                        abyss: {
                            type: 'object',
                            description: '探渊全局配置',
                            properties: {
                                total_floors: { type: 'integer', example: 9 },
                                min_duration_hours: { type: 'integer', example: 1 },
                                max_duration_hours: { type: 'integer', example: 4 },
                                max_concurrent_beasts: { type: 'integer', example: 2 },
                                stamina_per_explore: { type: 'integer', example: 100 },
                                stamina_max: { type: 'integer', example: 100 },
                                stamina_recover_per_hour: { type: 'integer', example: 25 },
                                daily_explore_limit: { type: 'integer', example: 3 },
                                beast_hp_injury_recover_hours: { type: 'integer', example: 2 },
                                pvp_encounter_base_rate: { type: 'number', example: 0.25 },
                                pvp_winner_loot_ratio: { type: 'number', example: 0.10 }
                            }
                        },
                        event_types: {
                            type: 'object',
                            description: '事件类型概率配置',
                            properties: {
                                monster: { type: 'number', example: 0.45 },
                                treasure: { type: 'number', example: 0.20 },
                                trap: { type: 'number', example: 0.15 },
                                pvp: { type: 'number', example: 0.20 }
                            }
                        },
                        recall_config: {
                            type: 'object',
                            description: '召回惩罚配置',
                            properties: {
                                early_recall_floor_penalty: { type: 'number', example: 0.5 },
                                early_recall_exp_penalty: { type: 'number', example: 0.3 }
                            }
                        },
                        beast_soul_config: {
                            type: 'object',
                            description: '兽魂凝练配置',
                            properties: {
                                exp_to_soul_ratio: { type: 'integer', example: 1000 },
                                min_exp_for_soul: { type: 'integer', example: 100 },
                                min_beast_level: { type: 'integer', example: 50 }
                            }
                        }
                    }
                }
            }
        }
    };
}

/**
 * 主函数：幂等地注入灵兽探渊系统接口定义
 */
function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  OpenAPI 补丁：灵兽探渊系统');
    console.log('═══════════════════════════════════════════');

    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error('❌ openapi.json 不存在:', OPENAPI_PATH);
        process.exit(1);
    }

    // 读取并解析 openapi.json
    const doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf-8'));
    console.log(`📊 原始统计: paths=${Object.keys(doc.paths).length}, tags=${doc.tags.length}, schemas=${Object.keys(doc.components.schemas).length}`);

    // 1. 注入 tag（幂等）
    if (!doc.tags.find(t => t.name === TAG_BEAST_ABYSS.name)) {
        doc.tags.push(TAG_BEAST_ABYSS);
        console.log(`✅ 添加标签: ${TAG_BEAST_ABYSS.name}`);
    } else {
        console.log(`ℹ️  标签已存在: ${TAG_BEAST_ABYSS.name}`);
    }

    // 2. 注入 paths（幂等）
    const newPaths = buildPaths();
    let addedPaths = 0;
    for (const [pathKey, pathDef] of Object.entries(newPaths)) {
        if (!doc.paths[pathKey]) {
            doc.paths[pathKey] = pathDef;
            addedPaths++;
            console.log(`✅ 添加路径: ${pathKey}`);
        } else {
            console.log(`ℹ️  路径已存在: ${pathKey}`);
        }
    }

    // 3. 注入 schemas（幂等）
    const newSchemas = buildSchemas();
    let addedSchemas = 0;
    for (const [schemaKey, schemaDef] of Object.entries(newSchemas)) {
        if (!doc.components.schemas[schemaKey]) {
            doc.components.schemas[schemaKey] = schemaDef;
            addedSchemas++;
        } else {
            console.log(`ℹ️  schema 已存在: ${schemaKey}`);
        }
    }
    console.log(`✅ 添加 schemas: ${addedSchemas} 个`);

    // 4. 写回文件
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(doc, null, 2), 'utf-8');
    console.log(`📊 更新后统计: paths=${Object.keys(doc.paths).length}, tags=${doc.tags.length}, schemas=${Object.keys(doc.components.schemas).length}`);
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ OpenAPI 补丁应用完成');
    console.log('═══════════════════════════════════════════');
}

main();
