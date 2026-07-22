/**
 * OpenAPI 路径追加工具：补全 PVP 主接口定义
 *
 * 缺失接口（5 个）：
 *   GET  /api/pvp/status       获取 PVP 状态
 *   GET  /api/pvp/leaderboard  段位排行榜
 *   GET  /api/pvp/history      战斗历史
 *   POST /api/pvp/challenge    发起挑战
 *   POST /api/pvp/action       执行回合
 *   POST /api/pvp/flee         逃跑
 *
 * 使用方式：
 *   node server/scripts/update_openapi_pvp_main.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 通用错误响应
const errorResponses = {
    400: {
        description: '业务逻辑错误或参数校验失败',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 400 },
                        error_code: { type: 'string', example: 'BUSINESS_LOGIC_ERROR' },
                        message: { type: 'string', example: '错误描述' }
                    }
                }
            }
        }
    },
    401: { description: '未鉴权或 token 失效' },
    500: { description: '服务器内部错误' }
};

const newPaths = {
    '/api/pvp/status': {
        get: {
            tags: ['PVP斗法'],
            summary: '获取 PVP 状态',
            description: [
                '获取玩家当前 PVP 状态：',
                '- 是否在 PVP 战斗中',
                '- 进行中战斗信息（对手、回合、HP、战斗日志）',
                '- 段位与战绩（积分、段位、胜场、败场、连胜）',
                '- 玩家自身状态（战力、荣誉、因果、虚弱、冷却）',
                '- PVP 系统配置（每日上限、冷却、段位列表）',
                '',
                '段位体系（六档）：',
                '  散修：0~499，道子：500~999，真传：1000~1999',
                '  长老：2000~3499，宗主：3500~4999，大能：5000+'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: 'PVP 状态',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            is_in_pvp_battle: { type: 'boolean', example: false },
                                            battle_info: {
                                                type: 'object',
                                                nullable: true,
                                                description: '进行中战斗信息，无则 null',
                                                properties: {
                                                    battle_id: { type: 'integer', example: 1 },
                                                    is_attacker: { type: 'boolean', example: true },
                                                    opponent_id: { type: 'integer', example: 2 },
                                                    opponent_nickname: { type: 'string', example: '张三' },
                                                    opponent_realm: { type: 'string', example: '筑基初期' },
                                                    opponent_power: { type: 'integer', example: 1500 },
                                                    attacker_power: { type: 'integer', example: 1800 },
                                                    current_round: { type: 'integer', example: 3 },
                                                    max_rounds: { type: 'integer', example: 30 },
                                                    is_my_turn: { type: 'boolean', example: true },
                                                    started_at: { type: 'string', format: 'date-time' },
                                                    battle_log: { type: 'array', items: { type: 'object' } }
                                                }
                                            },
                                            ranking: {
                                                type: 'object',
                                                properties: {
                                                    score: { type: 'integer', example: 500 },
                                                    rank_tier: { type: 'string', example: '道子' },
                                                    season_wins: { type: 'integer', example: 5 },
                                                    season_losses: { type: 'integer', example: 3 },
                                                    season_draws: { type: 'integer', example: 0 },
                                                    win_streak: { type: 'integer', example: 2 },
                                                    max_win_streak: { type: 'integer', example: 5 },
                                                    daily_challenge_remaining: { type: 'integer', example: 8 },
                                                    daily_defend_remaining: { type: 'integer', example: 4 },
                                                    total_battles: { type: 'integer', example: 20 },
                                                    win_rate: { type: 'number', example: 62.5 }
                                                }
                                            },
                                            player: {
                                                type: 'object',
                                                properties: {
                                                    power: { type: 'integer', example: 1800 },
                                                    honor: { type: 'integer', example: 100 },
                                                    karma: { type: 'integer', example: 50 },
                                                    is_weak: { type: 'boolean', example: false },
                                                    weakness_remaining_seconds: { type: 'integer', example: 0 },
                                                    pvp_score: { type: 'integer', example: 500 },
                                                    pvp_rank: { type: 'string', example: '道子' },
                                                    cooldown_remaining_seconds: { type: 'integer', example: 0 }
                                                }
                                            },
                                            config: {
                                                type: 'object',
                                                description: 'PVP 系统配置',
                                                properties: {
                                                    daily_challenge_limit: { type: 'integer', example: 10 },
                                                    daily_defend_limit: { type: 'integer', example: 5 },
                                                    cooldown_seconds: { type: 'integer', example: 300 },
                                                    weakness_duration_minutes: { type: 'integer', example: 30 },
                                                    max_rounds: { type: 'integer', example: 30 },
                                                    round_timeout_seconds: { type: 'integer', example: 60 },
                                                    ranks: { type: 'array', items: { type: 'object' } }
                                                }
                                            },
                                            server_time: { type: 'integer', example: 1721568000000 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/pvp/leaderboard': {
        get: {
            tags: ['PVP斗法'],
            summary: '段位排行榜',
            description: '获取 PVP 积分排行榜（默认 50 条，最多 100 条）',
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
                    description: '返回条数（1-100，默认 50）'
                }
            ],
            responses: {
                200: {
                    description: '排行榜列表',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            list: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        player_id: { type: 'integer', example: 1 },
                                                        nickname: { type: 'string', example: '韩天尊' },
                                                        score: { type: 'integer', example: 5200 },
                                                        rank_tier: { type: 'string', example: '大能' },
                                                        season_wins: { type: 'integer', example: 50 },
                                                        season_losses: { type: 'integer', example: 10 },
                                                        win_streak: { type: 'integer', example: 5 },
                                                        total_battles: { type: 'integer', example: 60 }
                                                    }
                                                }
                                            },
                                            total: { type: 'integer', example: 50 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/pvp/history': {
        get: {
            tags: ['PVP斗法'],
            summary: '战斗历史',
            description: '获取玩家 PVP 战斗历史记录（分页）',
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'page',
                    in: 'query',
                    schema: { type: 'integer', default: 1, minimum: 1 },
                    description: '页码（默认 1）'
                },
                {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
                    description: '每页条数（1-100，默认 20）'
                }
            ],
            responses: {
                200: {
                    description: '战斗历史分页列表',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            list: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        id: { type: 'integer', example: 1 },
                                                        battle_type: { type: 'string', enum: ['normal', 'ranked'], example: 'normal' },
                                                        attacker_id: { type: 'integer', example: 1 },
                                                        defender_id: { type: 'integer', example: 2 },
                                                        winner_id: { type: 'integer', nullable: true, example: 1 },
                                                        total_rounds: { type: 'integer', example: 12 },
                                                        attacker_score_change: { type: 'integer', example: 20 },
                                                        defender_score_change: { type: 'integer', example: -15 },
                                                        attacker_honor_gain: { type: 'integer', example: 10 },
                                                        defender_honor_gain: { type: 'integer', example: 0 },
                                                        spirit_stone_reward: { type: 'integer', example: 500 },
                                                        started_at: { type: 'string', format: 'date-time' },
                                                        finished_at: { type: 'string', format: 'date-time' }
                                                    }
                                                }
                                            },
                                            total: { type: 'integer', example: 30 },
                                            page: { type: 'integer', example: 1 },
                                            pageSize: { type: 'integer', example: 20 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/pvp/challenge': {
        post: {
            tags: ['PVP斗法'],
            summary: '发起 PVP 挑战',
            description: [
                '向指定玩家发起 PVP 挑战，开始一场斗法战斗。',
                '',
                '业务校验：',
                '- 目标玩家存在、未死亡、未被封禁',
                '- 双方均不在其他 PVP 战斗中',
                '- 双方均为入世模式（避世模式不可挑战/被挑战）',
                '- 今日挑战次数未达上限',
                '- 战斗冷却已结束',
                '- 双方境界差距不超过限制',
                '',
                '挑战成功后：',
                '- 创建战斗记录，随机决定先手方',
                '- 推送 pvp_challenge 事件给发起方',
                '- 推送 pvp_challenged 事件给被挑战方'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_player_id'],
                            properties: {
                                target_player_id: {
                                    type: 'integer',
                                    description: '目标玩家 ID'
                                },
                                battle_type: {
                                    type: 'string',
                                    enum: ['normal', 'ranked'],
                                    default: 'normal',
                                    description: '战斗类型：normal=普通斗法 / ranked=排位斗法'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '挑战成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '斗法挑战已发起' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            battle_id: { type: 'integer', example: 1 },
                                            opponent_info: {
                                                type: 'object',
                                                properties: {
                                                    player_id: { type: 'integer', example: 2 },
                                                    nickname: { type: 'string', example: '张三' },
                                                    realm: { type: 'string', example: '筑基初期' },
                                                    power: { type: 'integer', example: 1500 }
                                                }
                                            },
                                            first_attacker: { type: 'string', enum: ['attacker', 'defender'], example: 'attacker' },
                                            message: { type: 'string', example: '斗法开始！' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/pvp/action': {
        post: {
            tags: ['PVP斗法'],
            summary: '执行战斗回合',
            description: [
                '在当前 PVP 战斗中执行一个回合动作。',
                '',
                '可选动作：',
                '- attack：普通攻击（无消耗）',
                '- skill：技能攻击（消耗 MP，需指定 skill_index）',
                '- defend：防御（减少受到的伤害，回复部分 MP）',
                '',
                '业务校验：',
                '- 玩家在 PVP 战斗中',
                '- 当前是玩家回合',
                '- 动作类型合法',
                '- skill 动作需要 skill_index 合法且 MP 足够'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['action'],
                            properties: {
                                action: {
                                    type: 'string',
                                    enum: ['attack', 'skill', 'defend'],
                                    description: '动作类型'
                                },
                                skill_index: {
                                    type: 'integer',
                                    default: 0,
                                    description: '技能槽位（仅 skill 动作有效，默认 0）'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '回合执行结果',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '回合执行完成' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            battle_id: { type: 'integer', example: 1 },
                                            round: { type: 'integer', example: 3 },
                                            actor: { type: 'string', enum: ['attacker', 'defender'], example: 'attacker' },
                                            action: { type: 'string', enum: ['attack', 'skill', 'defend'], example: 'attack' },
                                            damage: { type: 'integer', example: 150 },
                                            attacker_hp: { type: 'integer', example: 800 },
                                            defender_hp: { type: 'integer', example: 650 },
                                            battle_ended: { type: 'boolean', example: false },
                                            winner_id: { type: 'integer', nullable: true, example: null },
                                            battle_log: { type: 'array', items: { type: 'object' } }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/pvp/flee': {
        post: {
            tags: ['PVP斗法'],
            summary: '逃跑（放弃战斗）',
            description: [
                '攻击方主动放弃当前 PVP 战斗，按失败结算。',
                '',
                '业务效果：',
                '- 战斗立即结束，逃跑方判负',
                '- 扣除积分（与失败一致）',
                '- 进入虚弱状态',
                '- 防守方获得胜利奖励',
                '',
                '限制：',
                '- 仅攻击方可逃跑',
                '- 必须在 PVP 战斗中'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: { type: 'object', properties: {} }
                    }
                }
            },
            responses: {
                200: {
                    description: '逃跑成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '斗法已逃跑' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            battle_id: { type: 'integer', example: 1 },
                                            fled: { type: 'boolean', example: true },
                                            winner_id: { type: 'integer', example: 2 },
                                            score_change: { type: 'integer', example: -15 },
                                            message: { type: 'string', example: '逃跑成功，按失败结算' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    }
};

function main() {
    console.log('读取 OpenAPI 文件:', OPENAPI_PATH);
    const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    console.log('当前 paths 数量:', Object.keys(openapi.paths).length);

    let added = 0;
    let overwritten = 0;
    for (const [p, methods] of Object.entries(newPaths)) {
        if (openapi.paths[p]) {
            overwritten += 1;
            console.log(`  覆盖已存在路径: ${p}`);
        } else {
            added += 1;
            console.log(`  新增路径: ${p}`);
        }
        openapi.paths[p] = methods;
    }

    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf8');
    console.log(`\n✓ OpenAPI 更新完成：新增 ${added} 条，覆盖 ${overwritten} 条`);
    console.log('更新后 paths 数量:', Object.keys(openapi.paths).length);
}

main();
