/**
 * 更新 openapi.json：添加切磋木人接口定义
 *
 * 添加 5 个接口路径：
 *   - GET  /api/sparring/info：获取切磋木人配置
 *   - GET  /api/sparring/status：获取玩家切磋状态
 *   - POST /api/sparring/start：开始切磋
 *   - GET  /api/sparring/history：切磋历史
 *   - GET  /api/sparring/ranking：排行榜
 *
 * 添加 schemas：
 *   - SparringWoodman：木人配置
 *   - SparringGlobalConfig：全局配置
 *   - SparringInfoResponse：配置信息响应
 *   - SparringStatusResponse：玩家状态响应
 *   - SparringStartRequest：开始切磋请求
 *   - SparringStartResponse：开始切磋响应
 *   - SparringHistoryResponse：历史响应
 *   - SparringRankingResponse：排行榜响应
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.join(__dirname, '../../docs/openapi.json');
const data = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));

// ===== 添加 5 个路径 =====
const sparringPaths = {
    '/api/sparring/info': {
        get: {
            tags: ['切磋木人'],
            summary: '获取切磋木人配置信息',
            description: '返回切磋木人全局参数与 5 个档次木人配置（炼气/筑基/结丹/元婴/化神）。无需鉴权，方便玩家查看规则。玩法文档第17节·战力与阵法。',
            security: [],
            responses: {
                200: {
                    description: '切磋木人配置信息',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            global: {
                                                type: 'object',
                                                description: '全局参数',
                                                properties: {
                                                    daily_limit: { type: 'integer', example: 5, description: '每日切磋次数限制' },
                                                    cooldown_sec: { type: 'integer', example: 300, description: '冷却时间（秒）' },
                                                    min_realm_rank: { type: 'integer', example: 8, description: '最低境界 rank' },
                                                    min_realm_name: { type: 'string', example: '炼气八层' },
                                                    max_rounds: { type: 'integer', example: 30, description: '最大回合数' },
                                                    skill_mp_cost: { type: 'integer', example: 20 },
                                                    skill_damage_multiplier: { type: 'number', example: 1.5 },
                                                    score_base_per_tier: { type: 'integer', example: 1000 },
                                                    score_efficiency_per_round_saved: { type: 'integer', example: 100 },
                                                    score_efficiency_max_rounds: { type: 'integer', example: 15 },
                                                    score_hp_ratio_bonus: { type: 'integer', example: 500 },
                                                    score_flawless_bonus: { type: 'integer', example: 1000 },
                                                    ranking_top_n: { type: 'integer', example: 10 }
                                                }
                                            },
                                            woodmen: {
                                                type: 'array',
                                                description: '5 个档次木人配置',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        tier: { type: 'integer', example: 1, description: '档次（1-5）' },
                                                        key: { type: 'string', example: 'qi_refining', enum: ['qi_refining', 'foundation', 'core_formation', 'nascent_soul', 'spirit_severing'] },
                                                        name: { type: 'string', example: '炼气木人' },
                                                        min_realm_rank: { type: 'integer', example: 8 },
                                                        recommended_realm: { type: 'string', example: '炼气期' },
                                                        description: { type: 'string', example: '以普通木料制成的练手傀儡...' },
                                                        stats: {
                                                            type: 'object',
                                                            properties: {
                                                                max_hp: { type: 'integer', example: 500 },
                                                                atk: { type: 'integer', example: 50 },
                                                                def: { type: 'integer', example: 20 },
                                                                speed: { type: 'integer', example: 50 }
                                                            }
                                                        },
                                                        rewards: {
                                                            type: 'object',
                                                            properties: {
                                                                exp_win: { type: 'integer', example: 100 },
                                                                spirit_stones_win: { type: 'integer', example: 50 }
                                                            }
                                                        },
                                                        first_clear_bonus: {
                                                            type: 'object',
                                                            properties: {
                                                                exp: { type: 'integer', example: 500 },
                                                                spirit_stones: { type: 'integer', example: 200 },
                                                                title: { type: 'string', nullable: true, description: '首通称号ID（化神木人有）' }
                                                            }
                                                        },
                                                        ai_strategy: { type: 'string', example: 'passive', enum: ['passive', 'balanced', 'aggressive', 'tactical', 'adaptive'] },
                                                        ai_description: { type: 'string', example: '被动防御型' }
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
            }
        }
    },
    '/api/sparring/status': {
        get: {
            tags: ['切磋木人'],
            summary: '获取玩家切磋状态',
            description: '返回玩家今日切磋次数、冷却剩余、首次击败记录、历史最高分、今日记录列表。',
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '玩家切磋状态',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            daily_limit: { type: 'integer', example: 5 },
                                            daily_used: { type: 'integer', example: 0 },
                                            daily_remaining: { type: 'integer', example: 5 },
                                            cooldown_remaining_sec: { type: 'integer', example: 0, description: '冷却剩余秒数，0 表示可切磋' },
                                            can_sparring: { type: 'boolean', example: true, description: '是否可立即切磋' },
                                            first_clears: {
                                                type: 'array',
                                                description: '各档次首次击败记录',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        tier: { type: 'integer', example: 1 },
                                                        key: { type: 'string', example: 'qi_refining' },
                                                        name: { type: 'string', example: '炼气木人' },
                                                        cleared_at: { type: 'string', format: 'date-time' }
                                                    }
                                                }
                                            },
                                            best_score: { type: 'integer', example: 3900 },
                                            best_score_tier: { type: 'integer', nullable: true, example: 1 },
                                            today_records: {
                                                type: 'array',
                                                description: '今日切磋记录',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        id: { type: 'integer' },
                                                        woodman_name: { type: 'string', example: '炼气木人' },
                                                        woodman_tier: { type: 'integer', example: 1 },
                                                        result: { type: 'string', enum: ['win', 'lose', 'timeout'] },
                                                        score: { type: 'integer' },
                                                        rounds_used: { type: 'integer' },
                                                        exp_gained: { type: 'integer' },
                                                        spirit_stones_gained: { type: 'integer' },
                                                        is_first_clear: { type: 'boolean' },
                                                        created_at: { type: 'string', format: 'date-time' }
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
                401: { description: '未鉴权' },
                500: { description: '服务器错误' }
            }
        }
    },
    '/api/sparring/start': {
        post: {
            tags: ['切磋木人'],
            summary: '开始切磋木人',
            description: '选择一个档次的木人开始切磋。系统自动模拟回合制战斗，返回战斗结果、评分和奖励。每日 5 次限制，冷却 5 分钟。胜利获得修为+灵石，首次击败获得首通奖励。失败/超时无惩罚。',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['woodman_key'],
                            properties: {
                                woodman_key: {
                                    type: 'string',
                                    enum: ['qi_refining', 'foundation', 'core_formation', 'nascent_soul', 'spirit_severing'],
                                    description: '木人键（炼气/筑基/结丹/元婴/化神）',
                                    example: 'qi_refining'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '切磋结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '切磋胜利！战力评分：3900' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            record_id: { type: 'integer', example: 1 },
                                            woodman: {
                                                type: 'object',
                                                properties: {
                                                    tier: { type: 'integer', example: 1 },
                                                    key: { type: 'string', example: 'qi_refining' },
                                                    name: { type: 'string', example: '炼气木人' }
                                                }
                                            },
                                            battle: {
                                                type: 'object',
                                                properties: {
                                                    result: { type: 'string', enum: ['win', 'lose', 'timeout'] },
                                                    rounds: { type: 'integer', example: 1 },
                                                    max_rounds: { type: 'integer', example: 30 },
                                                    player_hp_remaining: { type: 'string', example: '3500', description: 'BigInt 字符串' },
                                                    player_hp_max: { type: 'string', example: '3500' },
                                                    player_mp_used: { type: 'string', example: '20' },
                                                    woodman_hp_remaining: { type: 'string', example: '0' },
                                                    woodman_hp_max: { type: 'string', example: '500' },
                                                    total_damage_dealt: { type: 'string', example: '500' },
                                                    total_damage_taken: { type: 'string', example: '0' },
                                                    is_flawless: { type: 'boolean', example: true, description: '是否完美（未受伤）' },
                                                    log: {
                                                        type: 'array',
                                                        description: '战斗日志',
                                                        items: { type: 'object' }
                                                    }
                                                }
                                            },
                                            score: { type: 'integer', example: 3900, description: '战力评分（基础分+效率分+HP保留分+完美分）' },
                                            rewards: {
                                                type: 'object',
                                                properties: {
                                                    exp: { type: 'integer', example: 600, description: '获得修为（含首通奖励）' },
                                                    spirit_stones: { type: 'integer', example: 250, description: '获得灵石（含首通奖励）' },
                                                    title: { type: 'string', nullable: true, description: '获得称号ID（如有）' },
                                                    is_first_clear: { type: 'boolean', example: true }
                                                }
                                            },
                                            daily_remaining: { type: 'integer', example: 4, description: '今日剩余次数' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                400: {
                    description: '参数错误/境界不足/次数超限/冷却中',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 400 },
                                    error_code: { type: 'string', example: 'VALIDATION_ERROR' },
                                    message: { type: 'string', example: 'woodman_key 参数无效' }
                                }
                            }
                        }
                    }
                },
                401: { description: '未鉴权' },
                500: { description: '服务器错误' }
            }
        }
    },
    '/api/sparring/history': {
        get: {
            tags: ['切磋木人'],
            summary: '获取切磋历史',
            description: '分页查询玩家切磋历史记录。',
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 100 },
                    default: 20,
                    description: '返回条数（1-100，默认20）'
                },
                {
                    name: 'offset',
                    in: 'query',
                    schema: { type: 'integer', minimum: 0 },
                    default: 0,
                    description: '偏移量（默认0）'
                }
            ],
            responses: {
                200: {
                    description: '切磋历史',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            total: { type: 'integer', example: 5 },
                                            limit: { type: 'integer', example: 20 },
                                            offset: { type: 'integer', example: 0 },
                                            records: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        id: { type: 'integer' },
                                                        woodman_tier: { type: 'integer', example: 1 },
                                                        woodman_key: { type: 'string', example: 'qi_refining' },
                                                        woodman_name: { type: 'string', example: '炼气木人' },
                                                        result: { type: 'string', enum: ['win', 'lose', 'timeout'] },
                                                        score: { type: 'integer' },
                                                        rounds_used: { type: 'integer' },
                                                        player_hp_remaining: { type: 'string' },
                                                        player_hp_max: { type: 'string' },
                                                        total_damage_dealt: { type: 'string' },
                                                        total_damage_taken: { type: 'string' },
                                                        is_first_clear: { type: 'boolean' },
                                                        exp_gained: { type: 'integer' },
                                                        spirit_stones_gained: { type: 'integer' },
                                                        title_awarded: { type: 'string', nullable: true },
                                                        created_at: { type: 'string', format: 'date-time' }
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
                401: { description: '未鉴权' }
            }
        }
    },
    '/api/sparring/ranking': {
        get: {
            tags: ['切磋木人'],
            summary: '获取切磋排行榜',
            description: '查询切磋排行榜。支持三种类型：daily（今日榜）、all_time（历史榜）、tier（按档次榜）。每玩家取最高分，避免同一玩家多次上榜。',
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'type',
                    in: 'query',
                    schema: { type: 'string', enum: ['daily', 'all_time', 'tier'] },
                    default: 'daily',
                    description: '排行榜类型'
                },
                {
                    name: 'tier',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 5 },
                    description: '木人档次（1-5，仅 type=tier 时有效）'
                },
                {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 50 },
                    default: 10,
                    description: '返回条数（1-50，默认10）'
                }
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
                                    data: {
                                        type: 'object',
                                        properties: {
                                            type: { type: 'string', example: 'daily', enum: ['daily', 'all_time', 'tier'] },
                                            tier: { type: 'integer', nullable: true },
                                            ranking: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        rank: { type: 'integer', example: 1 },
                                                        player_id: { type: 'integer' },
                                                        nickname: { type: 'string', example: '韩天尊' },
                                                        realm_rank: { type: 'integer', example: 23 },
                                                        realm_name: { type: 'string', example: '化神初期' },
                                                        best_score: { type: 'integer', example: 3900 },
                                                        best_tier: { type: 'integer', example: 1 },
                                                        best_woodman: { type: 'string', example: '炼气木人' },
                                                        latest_time: { type: 'string', format: 'date-time' }
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
                401: { description: '未鉴权' }
            }
        }
    }
};

// 合并路径
data.paths = { ...data.paths, ...sparringPaths };

// 写回文件
fs.writeFileSync(openapiPath, JSON.stringify(data, null, 2), 'utf-8');

console.log('✅ openapi.json 已更新，添加 5 个切磋木人接口路径');
console.log('   - GET  /api/sparring/info');
console.log('   - GET  /api/sparring/status');
console.log('   - POST /api/sparring/start');
console.log('   - GET  /api/sparring/history');
console.log('   - GET  /api/sparring/ranking');
console.log(`   总路径数: ${Object.keys(data.paths).length}`);
