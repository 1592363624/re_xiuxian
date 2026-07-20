/**
 * 批次2多人玩法 OpenAPI 文档更新脚本
 *
 * 用途：向 docs/openapi.json 注入世界BOSS和宗门战的接口定义
 * 注意：使用 Node.js fs 操作避免 PowerShell ConvertTo-Json 损坏中文
 *
 * 运行：node server/scripts/update_openapi_batch2.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');

// 通用安全响应引用
const securityBearer = [{ bearerAuth: [] }];

// 通用错误响应
const errorResponses = {
    400: {
        description: '请求参数错误或业务校验失败',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 400 },
                        message: { type: 'string' },
                        error_code: { type: 'string' }
                    }
                }
            }
        }
    },
    401: {
        description: '未授权（JWT 缺失或失效）',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 401 },
                        message: { type: 'string', example: '令牌无效或已过期' }
                    }
                }
            }
        }
    },
    403: {
        description: '权限不足（非管理员）',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 403 },
                        message: { type: 'string', example: '权限不足：需要管理员权限' }
                    }
                }
            }
        }
    },
    404: {
        description: '资源不存在',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 404 },
                        message: { type: 'string' },
                        error_code: { type: 'string', example: 'NOT_FOUND' }
                    }
                }
            }
        }
    },
    500: {
        description: '服务器内部错误',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 500 },
                        message: { type: 'string' },
                        error_code: { type: 'string', example: 'INTERNAL_ERROR' }
                    }
                }
            }
        }
    }
};

// 通用成功响应包装
function successResponse(dataSchema) {
    return {
        description: '操作成功',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 200 },
                        data: dataSchema
                    }
                }
            }
        }
    };
}

// 大整数安全字符串类型
const bigIntString = { type: 'string', description: '大整数（字符串形式以避免 JSON 精度丢失）', example: '5000000' };

// ===================== 新增 Tag =====================
const newTags = [
    {
        name: '世界BOSS',
        description: '世界BOSS系统 - 批次2多人玩法：3档BOSS(元婴/化神/炼虚)、3阶段切换、个人/宗门伤害排行、赛季结算、首杀荣誉'
    },
    {
        name: '世界BOSS管理',
        description: '世界BOSS GM 后台 - 统计/手动刷新/过期/赛季管理/强制结算（需要管理员权限，审计日志）'
    },
    {
        name: '宗门战',
        description: '宗门战/领地争夺系统 - 批次2多人玩法：9个资源点(灵脉/矿脉/秘境/战略)、宣战/加入/攻防/占领、宗门资金、赛季结算'
    },
    {
        name: '宗门战管理',
        description: '宗门战 GM 后台 - 统计/赛季管理/资源点初始化/手动推进状态/资源产出结算（需要管理员权限，审计日志）'
    }
];

// ===================== 世界BOSS玩家接口 =====================
const worldBossPaths = {
    '/api/world-boss/available': {
        get: {
            tags: ['世界BOSS'],
            summary: '获取可挑战的BOSS列表',
            description: '查询所有 pending/active 状态的BOSS（含即将刷新与正在交战的），按 active 优先排序',
            security: securityBearer,
            responses: {
                200: successResponse({
                    type: 'object',
                    properties: {
                        bosses: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'integer', example: 1 },
                                    boss_key: { type: 'string', example: 'qingyuanzi' },
                                    boss_name: { type: 'string', example: '青元子' },
                                    realm_rank_min: { type: 'integer', example: 11 },
                                    phase: { type: 'integer', example: 1 },
                                    status: { type: 'string', enum: ['pending', 'active'], example: 'active' },
                                    spawn_time: { type: 'string', format: 'date-time' },
                                    active_start_time: { type: 'string', format: 'date-time', nullable: true },
                                    expire_time: { type: 'string', format: 'date-time' },
                                    season_id: { type: 'integer' },
                                    participant_count: { type: 'integer' },
                                    hp_percentage: { type: 'number', example: 75.5 },
                                    hp_current: bigIntString,
                                    hp_max: bigIntString,
                                    killer_player_id: { type: 'integer', nullable: true },
                                    killer_nickname: { type: 'string', nullable: true },
                                    countdown_seconds: { type: 'integer', description: '距离刷新/过期的剩余秒数' }
                                }
                            }
                        },
                        current_season: {
                            type: 'object',
                            nullable: true,
                            properties: {
                                id: { type: 'integer' },
                                season_name: { type: 'string' },
                                start_date: { type: 'string' },
                                end_date: { type: 'string' },
                                total_bosses_killed: { type: 'integer' }
                            }
                        },
                        server_time: { type: 'string', format: 'date-time' }
                    }
                }),
                401: errorResponses[401],
                500: errorResponses[500]
            }
        }
    },
    '/api/world-boss/seasons': {
        get: {
            tags: ['世界BOSS'],
            summary: '获取赛季列表',
            description: '分页查询世界BOSS赛季（含 active/pending/ended 全部状态）',
            security: securityBearer,
            parameters: [
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'pending', 'ended'] }, description: '可选状态过滤' },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: '返回条数（最大100）' }
            ],
            responses: {
                200: successResponse({
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            season_id: { type: 'integer' },
                            season_name: { type: 'string' },
                            start_date: { type: 'string' },
                            end_date: { type: 'string' },
                            status: { type: 'string', enum: ['active', 'pending', 'ended'] },
                            total_bosses_killed: { type: 'integer' },
                            total_damage_dealt: bigIntString,
                            settlement_time: { type: 'string', format: 'date-time', nullable: true }
                        }
                    }
                }),
                401: errorResponses[401]
            }
        }
    },
    '/api/world-boss/season/ranking': {
        get: {
            tags: ['世界BOSS'],
            summary: '获取赛季宗门伤害排行',
            security: securityBearer,
            parameters: [
                { name: 'season_id', in: 'query', required: true, schema: { type: 'integer' }, description: '赛季ID' },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '赛季宗门排行数据' }),
                400: errorResponses[400],
                401: errorResponses[401]
            }
        }
    },
    '/api/world-boss/{bossId}': {
        get: {
            tags: ['世界BOSS'],
            summary: '获取BOSS详情',
            description: '包含基础信息/当前HP/阶段/技能列表/伤害排行前10',
            security: securityBearer,
            parameters: [
                { name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: 'BOSS详情（含技能/排行前10）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/world-boss/{bossId}/ranking': {
        get: {
            tags: ['世界BOSS'],
            summary: '获取BOSS伤害排行（个人或宗门）',
            security: securityBearer,
            parameters: [
                { name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } },
                { name: 'type', in: 'query', schema: { type: 'string', enum: ['personal', 'sect'], default: 'personal' } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '伤害排行列表' }),
                400: errorResponses[400],
                401: errorResponses[401]
            }
        }
    },
    '/api/world-boss/{bossId}/attack': {
        post: {
            tags: ['世界BOSS'],
            summary: '攻击世界BOSS',
            description: '核心战斗接口，事务+行级锁，含伤害计算/阶段切换/反击/击杀结算',
            security: securityBearer,
            parameters: [
                { name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } }
            ],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                skill_id: { type: 'string', enum: ['basic', 'skill', 'ultimate'], default: 'basic', description: '技能ID：basic=1.0倍率/skill=1.5倍率/ultimate=2.5倍率' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({
                    type: 'object',
                    properties: {
                        attack: {
                            type: 'object',
                            properties: {
                                skill_id: { type: 'string' },
                                damage: { type: 'integer', description: '本次造成的伤害' },
                                is_crit: { type: 'boolean', description: '是否暴击' },
                                damage_breakdown: { type: 'object', description: '伤害计算明细' }
                            }
                        },
                        boss: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                name: { type: 'string' },
                                hp_before: bigIntString,
                                hp_after: bigIntString,
                                hp_max: bigIntString,
                                hp_percentage: { type: 'number' },
                                phase: { type: 'integer' },
                                phase_changed: { type: 'boolean' },
                                status: { type: 'string' },
                                defeated: { type: 'boolean' }
                            }
                        },
                        counter: {
                            type: 'object',
                            description: 'BOSS 反击信息',
                            properties: {
                                damage: { type: 'integer' },
                                phase_multiplier: { type: 'number' },
                                boss_skill_factor: { type: 'number' }
                            }
                        },
                        player: {
                            type: 'object',
                            properties: {
                                battle_hp_before: bigIntString,
                                battle_hp_after: bigIntString,
                                battle_hp_max: bigIntString,
                                is_dead: { type: 'boolean' },
                                death_count: { type: 'integer' },
                                attack_count: { type: 'integer' }
                            }
                        },
                        settle: { type: 'object', nullable: true, description: '若BOSS被击杀，返回结算奖励信息' },
                        timestamp: { type: 'string', format: 'date-time' }
                    }
                }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404],
                500: errorResponses[500]
            }
        }
    },
    '/api/world-boss/{bossId}/revive': {
        post: {
            tags: ['世界BOSS'],
            summary: '原地复活',
            description: 'BOSS战死亡后消耗灵石原地复活，60秒CD',
            security: securityBearer,
            parameters: [{ name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '复活结果（含消耗灵石/恢复HP）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/world-boss/{bossId}/retreat': {
        post: {
            tags: ['世界BOSS'],
            summary: '撤退',
            description: '主动脱离BOSS战，5分钟内不可再次加入',
            security: securityBearer,
            parameters: [{ name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '撤退结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    }
};

// ===================== 世界BOSS GM 接口 =====================
const adminWorldBossPaths = {
    '/api/admin/world-boss/metrics': {
        get: {
            tags: ['世界BOSS管理'],
            summary: '世界BOSS统计指标',
            description: '返回活跃BOSS数/历史击杀数/赛季数/今日参与人数/当前配置',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'object', description: '统计指标' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/world-boss/bosses': {
        get: {
            tags: ['世界BOSS管理'],
            summary: '分页查询所有BOSS实例',
            security: securityBearer,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'active', 'defeated', 'expired'] } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: 'BOSS分页列表' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/world-boss/seasons': {
        get: {
            tags: ['世界BOSS管理'],
            summary: '分页查询所有赛季',
            security: securityBearer,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'pending', 'ended'] } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '赛季分页列表' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/world-boss/spawn': {
        post: {
            tags: ['世界BOSS管理'],
            summary: '手动刷新BOSS',
            description: 'GM介入手动刷新指定BOSS，可选自定义HP。审计日志记录',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['boss_key'],
                            properties: {
                                boss_key: { type: 'string', enum: ['qingyuanzi', 'yaoshou', 'mulan'], description: 'BOSS配置键' },
                                custom_hp: { type: 'integer', description: '自定义HP（可选，缺省使用配置文件的 base_hp）' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '刷新结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/world-boss/season/create': {
        post: {
            tags: ['世界BOSS管理'],
            summary: '创建新赛季',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['season_name', 'start_date', 'end_date'],
                            properties: {
                                season_name: { type: 'string', example: '2026年7月世界BOSS赛季' },
                                start_date: { type: 'string', format: 'date', example: '2026-07-19' },
                                end_date: { type: 'string', format: 'date', example: '2026-08-19' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '赛季创建结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/world-boss/season/{seasonId}/settle': {
        post: {
            tags: ['世界BOSS管理'],
            summary: '强制结算赛季',
            description: 'GM介入手动结算赛季，审计日志记录',
            security: securityBearer,
            parameters: [{ name: 'seasonId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '结算结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403],
                404: errorResponses[404]
            }
        }
    },
    '/api/admin/world-boss/{bossId}/expire': {
        post: {
            tags: ['世界BOSS管理'],
            summary: '强制过期BOSS',
            description: 'GM介入手动过期BOSS，适用场景：BOSS配置错误/玩家卡死/紧急下线。审计日志记录',
            security: securityBearer,
            parameters: [{ name: 'bossId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '过期结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403],
                404: errorResponses[404]
            }
        }
    }
};

// ===================== 宗门战玩家接口 =====================
const sectWarPaths = {
    '/api/sect-war/season/current': {
        get: {
            tags: ['宗门战'],
            summary: '获取当前宗门战赛季',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'object', nullable: true, description: '当前赛季信息（无赛季时返回 null）' }),
                401: errorResponses[401]
            }
        }
    },
    '/api/sect-war/season/ranking': {
        get: {
            tags: ['宗门战'],
            summary: '获取赛季宗门排行',
            security: securityBearer,
            parameters: [
                { name: 'season_id', in: 'query', schema: { type: 'integer' }, description: '赛季ID（缺省取当前赛季）' },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '赛季宗门排行' }),
                401: errorResponses[401]
            }
        }
    },
    '/api/sect-war/territories': {
        get: {
            tags: ['宗门战'],
            summary: '获取所有资源点列表',
            description: '返回9个资源点的归属/占领状态/产出/防御等级',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'array', description: '资源点列表' }),
                401: errorResponses[401]
            }
        }
    },
    '/api/sect-war/mysect': {
        get: {
            tags: ['宗门战'],
            summary: '获取我的宗门战信息',
            description: '返回宗门ID/名称/角色/资金/成员数/赛季战绩',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'object', description: '宗门战信息' }),
                401: errorResponses[401]
            }
        }
    },
    '/api/sect-war/wars': {
        get: {
            tags: ['宗门战'],
            summary: '获取战役列表',
            security: securityBearer,
            parameters: [
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'preparing', 'announced', 'active', 'settled'], default: 'all' } },
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1, maximum: 100 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '战役分页列表' }),
                401: errorResponses[401]
            }
        }
    },
    '/api/sect-war/wars/{warId}': {
        get: {
            tags: ['宗门战'],
            summary: '获取战役详情',
            description: '含双方宗门/参战名单/资源点占领状态',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '战役详情' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/sect-war/wars': {
        post: {
            tags: ['宗门战'],
            summary: '宣战（宗主权限）',
            description: '宗主向另一宗门宣战，扣 5000 灵石到 war_chest，进入 preparing 状态',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['defender_sect_id'],
                            properties: {
                                defender_sect_id: { type: 'string', example: 'xinggong', description: '防守方宗门ID' },
                                target_territory_id: { type: 'integer', nullable: true, description: '目标资源点ID（可选，NULL表示纯荣誉战）' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '宣战结果（含战役ID/扣款/战斗开始时间）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/sect-war/wars/{warId}/join': {
        post: {
            tags: ['宗门战'],
            summary: '加入战役',
            description: '自动根据玩家宗门分配攻方/守方阵营，校验人数上限（攻方20/守方30）',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '加入结果（含分配阵营）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/sect-war/wars/{warId}/leave': {
        post: {
            tags: ['宗门战'],
            summary: '离开战役',
            description: '仅 preparing/announced 阶段可离开；active 阶段离开视为逃跑（视配置扣荣誉）',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '离开结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/sect-war/wars/{warId}/attack': {
        post: {
            tags: ['宗门战'],
            summary: '攻击敌方玩家',
            description: '复用 PvpService 战斗公式，含伤害/反击/击杀/荣誉奖励',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_player_id'],
                            properties: {
                                target_player_id: { type: 'integer', description: '目标玩家ID' },
                                action: { type: 'string', enum: ['attack', 'skill', 'defend'], default: 'attack', description: '行动类型' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '攻击结果（含伤害/反击/击杀/荣誉）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404],
                500: errorResponses[500]
            }
        }
    },
    '/api/sect-war/wars/{warId}/capture': {
        post: {
            tags: ['宗门战'],
            summary: '占领资源点',
            description: '开始30秒占领计时，需在计时内不被击杀/打断才能完成占领',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['territory_id'],
                            properties: {
                                territory_id: { type: 'integer', description: '资源点ID' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '占领开始/完成/被中断' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/sect-war/wars/{warId}/surrender': {
        post: {
            tags: ['宗门战'],
            summary: '投降（认输）',
            description: '仅攻方宗主可调用，对方获胜获得 war_chest',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '投降结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                404: errorResponses[404]
            }
        }
    },
    '/api/sect-war/myrecords': {
        get: {
            tags: ['宗门战'],
            summary: '获取我的历史战役记录',
            security: securityBearer,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1, maximum: 100 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '历史战役分页列表' }),
                401: errorResponses[401]
            }
        }
    }
};

// ===================== 宗门战 GM 接口 =====================
const adminSectWarPaths = {
    '/api/admin/sect-war/metrics': {
        get: {
            tags: ['宗门战管理'],
            summary: '宗门战统计指标',
            description: '返回各状态战役数/资源点数/赛季数/今日参战玩家数/当前配置',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'object', description: '统计指标' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/wars': {
        get: {
            tags: ['宗门战管理'],
            summary: '分页查询所有战役',
            security: securityBearer,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'preparing', 'announced', 'active', 'settled'], default: 'all' } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '战役分页列表' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/seasons': {
        get: {
            tags: ['宗门战管理'],
            summary: '分页查询所有赛季',
            security: securityBearer,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
                { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'pending', 'ended'] } }
            ],
            responses: {
                200: successResponse({ type: 'object', description: '赛季分页列表' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/season/create': {
        post: {
            tags: ['宗门战管理'],
            summary: '创建新赛季',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['season_name', 'start_date', 'end_date'],
                            properties: {
                                season_name: { type: 'string', example: '2026年7月宗门战赛季' },
                                start_date: { type: 'string', format: 'date' },
                                end_date: { type: 'string', format: 'date' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '赛季创建结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/season/{seasonId}/settle': {
        post: {
            tags: ['宗门战管理'],
            summary: '强制结算赛季',
            description: 'GM介入手动结算赛季，审计日志记录',
            security: securityBearer,
            parameters: [{ name: 'seasonId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '结算结果' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403],
                404: errorResponses[404]
            }
        }
    },
    '/api/admin/sect-war/territories/initialize': {
        post: {
            tags: ['宗门战管理'],
            summary: '初始化资源点',
            description: '赛季新建后未自动初始化资源点，或资源点数据损坏时重置。审计日志记录',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['season_id'],
                            properties: {
                                season_id: { type: 'integer', description: '赛季ID' }
                            }
                        }
                    }
                }
            },
            responses: {
                200: successResponse({ type: 'object', description: '初始化结果（含创建数量）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/production/settle': {
        post: {
            tags: ['宗门战管理'],
            summary: '手动触发资源点产出结算',
            description: '应急用：定时任务失败/产出未到账时手动补偿。注意：可能重复发放，请确认后使用',
            security: securityBearer,
            responses: {
                200: successResponse({ type: 'object', description: '结算结果' }),
                401: errorResponses[401],
                403: errorResponses[403]
            }
        }
    },
    '/api/admin/sect-war/wars/{warId}/advance': {
        post: {
            tags: ['宗门战管理'],
            summary: '手动推进战役状态',
            description: '应急用：定时任务失败导致战役卡在 preparing/announced 阶段时手动推进。审计日志记录',
            security: securityBearer,
            parameters: [{ name: 'warId', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
                200: successResponse({ type: 'object', description: '推进结果（含前一状态/当前状态）' }),
                400: errorResponses[400],
                401: errorResponses[401],
                403: errorResponses[403],
                404: errorResponses[404]
            }
        }
    }
};

// ===================== 主流程 =====================
function main() {
    console.log('读取 openapi.json...');
    const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

    // 合并新 tag（去重）
    if (!Array.isArray(openapi.tags)) openapi.tags = [];
    const existingTagNames = new Set(openapi.tags.map(t => t.name));
    for (const tag of newTags) {
        if (!existingTagNames.has(tag.name)) {
            openapi.tags.push(tag);
            existingTagNames.add(tag.name);
            console.log(`  + 新增 tag: ${tag.name}`);
        }
    }

    // 合并新 paths（已存在则跳过并打印警告）
    const allNewPaths = Object.assign({}, worldBossPaths, adminWorldBossPaths, sectWarPaths, adminSectWarPaths);
    if (!openapi.paths) openapi.paths = {};
    let added = 0, skipped = 0;
    for (const [pathKey, pathDef] of Object.entries(allNewPaths)) {
        if (openapi.paths[pathKey]) {
            console.log(`  ! 跳过已存在的路径: ${pathKey}`);
            skipped++;
            continue;
        }
        openapi.paths[pathKey] = pathDef;
        added++;
    }
    console.log(`  + 新增路径: ${added} 个，跳过: ${skipped} 个`);

    // 写回文件（UTF-8 无 BOM，2 空格缩进）
    console.log('写回 openapi.json...');
    fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf8');
    console.log(`完成。文件大小: ${fs.statSync(openapiPath).size} 字节`);
}

try {
    main();
} catch (err) {
    console.error('更新失败:', err);
    process.exit(1);
}
