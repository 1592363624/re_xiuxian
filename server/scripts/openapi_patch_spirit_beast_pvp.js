/**
 * OpenAPI 文档补丁脚本：灵兽PVP竞技场系统（玩法文档第8节 灵兽PVP对战）
 *
 * 作用：向 docs/openapi.json 注入灵兽PVP竞技场系统的 8 个接口定义：
 *   路由前缀 /api/spirit-beast/pvp，对应 server/routes/spirit_beast_pvp.js
 *     玩家端（auth 鉴权）：
 *       1. GET  /api/spirit-beast/pvp/profile        - 获取PVP档案（段位/胜点/战绩/今日挑战次数）
 *       2. GET  /api/spirit-beast/pvp/ranking         - 查询赛季排行榜
 *       3. GET  /api/spirit-beast/pvp/history         - 查询对局历史
 *       4. GET  /api/spirit-beast/pvp/season          - 查询当前赛季信息
 *       5. POST /api/spirit-beast/pvp/challenge        - 发起挑战（友谊赛/押注赛）
 *       6. GET  /api/spirit-beast/pvp/tactics         - 查询可用战术列表
 *       7. GET  /api/spirit-beast/pvp/tiers           - 查询段位信息
 *       8. GET  /api/spirit-beast/pvp/match/{matchId} - 查询对局详情
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（灵兽PVP竞技场系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则覆盖，便于重新生成）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_spirit_beast_pvp.js
 * 幂等性：可重复执行，相同 path+method 会被覆盖更新
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 目标文件路径（项目根目录下的 docs/openapi.json）
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// ==================== 新增 Tag 定义 ====================
const NEW_TAGS = [
    {
        name: '灵兽PVP竞技场系统',
        description: '玩法文档第8节 - 灵兽PVP对战：1v1 自动战斗，含押注/段位/赛季排行，友谊赛不计段位但计入对局数'
    }
];

// ==================== 通用响应构造工具 ====================
/**
 * 构造通用响应对象（200/400/401/500）
 */
const securityResponses = (description, dataSchema) => {
    const resp = {
        200: {
            description: description,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            success: { type: 'boolean', description: '业务是否成功（业务失败时为 false）' },
                            message: { type: 'string', description: '提示消息' },
                            data: dataSchema || { type: 'object', nullable: true }
                        }
                    }
                }
            }
        },
        400: {
            description: '参数校验失败或业务逻辑错误',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 400 },
                            success: { type: 'boolean', example: false },
                            error_code: { type: 'string', example: 'VALIDATION_ERROR' },
                            message: { type: 'string' }
                        }
                    }
                }
            }
        },
        401: {
            description: '未授权（缺少或无效的 JWT Token）',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 401 },
                            success: { type: 'boolean', example: false },
                            message: { type: 'string', example: '未授权' }
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
                            success: { type: 'boolean', example: false },
                            message: { type: 'string' }
                        }
                    }
                }
            }
        }
    };
    return resp;
};

// 通用 Bearer 鉴权
const bearerAuth = [{ bearerAuth: [] }];

// ==================== 接口路径定义 ====================
const NEW_PATHS = {
    // 1. 获取PVP档案
    '/api/spirit-beast/pvp/profile': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '获取PVP档案',
            description: '获取当前玩家的灵兽PVP档案，包含段位、胜点、战绩、今日挑战次数等。若玩家本赛季首次访问，会自动创建排位记录（青铜0胜点）。',
            operationId: 'getSpiritBeastPvpProfile',
            security: bearerAuth,
            responses: securityResponses('PVP档案', {
                type: 'object',
                properties: {
                    ranking: {
                        type: 'object',
                        nullable: true,
                        properties: {
                            tier: { type: 'string', example: 'bronze', description: '段位key：bronze/silver/gold/platinum/diamond/king' },
                            tier_name: { type: 'string', example: '青铜' },
                            ranking_points: { type: 'integer', example: 0, description: '当前胜点' },
                            total_matches: { type: 'integer', example: 0, description: '总对局数（含友谊赛）' },
                            total_wins: { type: 'integer', example: 0 },
                            total_losses: { type: 'integer', example: 0 },
                            total_draws: { type: 'integer', example: 0 },
                            win_rate: { type: 'number', format: 'float', example: 0 },
                            daily_challenge_count: { type: 'integer', example: 0, description: '今日已挑战次数' },
                            daily_challenge_limit: { type: 'integer', example: 10, description: '每日挑战上限' },
                            daily_first_win_claimed: { type: 'boolean', example: false, description: '今日首胜奖励是否已领取' },
                            total_bet_won: { type: 'string', example: '0', description: '累计赢得押注灵石（BigInt字符串）' },
                            total_bet_lost: { type: 'string', example: '0', description: '累计输掉押注灵石（BigInt字符串）' }
                        }
                    },
                    season: {
                        type: 'object',
                        properties: {
                            id: { type: 'integer', example: 1 },
                            name: { type: 'string', example: '2026年第1季' },
                            status: { type: 'string', example: 'active' },
                            days_remaining: { type: 'integer', example: 28 }
                        }
                    }
                }
            })
        }
    },

    // 2. 查询赛季排行榜
    '/api/spirit-beast/pvp/ranking': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询赛季排行榜',
            description: '获取当前赛季的PVP排行榜，按胜点降序、胜场降序、创建时间升序排列。仅展示对局数>0的玩家。',
            operationId: 'getSpiritBeastPvpRanking',
            security: bearerAuth,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '页码' },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 20 }, description: '每页条数（最大100）' }
            ],
            responses: securityResponses('排行榜', {
                type: 'object',
                properties: {
                    ranking: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                rank: { type: 'integer', example: 1, description: '排名' },
                                player_id: { type: 'integer', example: 1 },
                                player_nickname: { type: 'string', example: '叶天帝' },
                                tier: { type: 'string', example: 'king' },
                                tier_name: { type: 'string', example: '王者' },
                                ranking_points: { type: 'integer', example: 3500 },
                                total_matches: { type: 'integer', example: 50 },
                                total_wins: { type: 'integer', example: 35 },
                                total_losses: { type: 'integer', example: 12 },
                                total_draws: { type: 'integer', example: 3 },
                                win_rate: { type: 'number', format: 'float', example: 70.0 }
                            }
                        }
                    },
                    total: { type: 'integer', example: 100 },
                    page: { type: 'integer', example: 1 },
                    page_size: { type: 'integer', example: 20 },
                    my_rank: { type: 'integer', nullable: true, example: 5, description: '我的排名（未上榜为null）' }
                }
            })
        }
    },

    // 3. 查询对局历史
    '/api/spirit-beast/pvp/history': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询对局历史',
            description: '获取当前玩家的PVP对局历史，按时间倒序排列。',
            operationId: 'getSpiritBeastPvpHistory',
            security: bearerAuth,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 10 } }
            ],
            responses: securityResponses('对局历史', {
                type: 'object',
                properties: {
                    history: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                match_id: { type: 'integer', example: 100 },
                                created_at: { type: 'string', format: 'date-time' },
                                finished_at: { type: 'string', format: 'date-time', nullable: true },
                                role: { type: 'string', example: 'challenger', description: '本局身份：challenger/defender' },
                                opponent_id: { type: 'integer', example: 9 },
                                opponent_beast_name: { type: 'string', example: '测试火焰狮' },
                                my_beast_name: { type: 'string', example: '测试青云狼' },
                                my_tactic: { type: 'string', example: 'balanced' },
                                opponent_tactic: { type: 'string', example: 'balanced' },
                                bet_spirit_stones: { type: 'string', example: '500', description: '押注灵石（BigInt字符串）' },
                                is_friendly: { type: 'boolean', example: false },
                                result: { type: 'string', example: 'win', description: 'win/lose/draw' },
                                total_rounds: { type: 'integer', example: 5 },
                                points_change: { type: 'integer', example: 10, description: '胜点变化（友谊赛为0）' }
                            }
                        }
                    },
                    total: { type: 'integer', example: 30 },
                    page: { type: 'integer', example: 1 },
                    page_size: { type: 'integer', example: 10 }
                }
            })
        }
    },

    // 4. 查询当前赛季信息
    '/api/spirit-beast/pvp/season': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询当前赛季信息',
            description: '获取当前活跃赛季的详细信息，包括赛季名称、起止时间、剩余天数、参与者数量。',
            operationId: 'getSpiritBeastPvpSeason',
            security: bearerAuth,
            responses: securityResponses('赛季信息', {
                type: 'object',
                properties: {
                    season: {
                        type: 'object',
                        properties: {
                            id: { type: 'integer', example: 1 },
                            name: { type: 'string', example: '2026年第1季' },
                            status: { type: 'string', example: 'active' },
                            start_time: { type: 'string', format: 'date-time' },
                            end_time: { type: 'string', format: 'date-time' },
                            days_remaining: { type: 'integer', example: 28 },
                            participants: { type: 'integer', example: 156, description: '本赛季参与者数量' }
                        }
                    }
                }
            })
        }
    },

    // 5. 发起挑战
    '/api/spirit-beast/pvp/challenge': {
        post: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '发起PVP挑战',
            description: '向目标玩家发起灵兽PVP挑战，系统自动执行战斗并结算。支持友谊赛（无押注、不计段位）和押注赛（扣除双方押注灵石、胜者通吃）。同对手冷却1小时，每日挑战上限10次，禁止挑战同主魂（IP相同）玩家。',
            operationId: 'spiritBeastPvpChallenge',
            security: bearerAuth,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_player_id', 'beast_id', 'tactic'],
                            properties: {
                                target_player_id: { type: 'integer', example: 9, description: '目标玩家ID' },
                                beast_id: { type: 'integer', example: 5, description: '出战灵兽ID（必须为出战状态）' },
                                tactic: { type: 'string', enum: ['all_out', 'balanced', 'counter'], example: 'balanced', description: '战术：all_out全力一击/balanced稳健输出/counter防御反击' },
                                bet_spirit_stones: { type: 'integer', default: 0, example: 500, description: '押注灵石数量（0=友谊赛；范围100-10000）' },
                                is_friendly: { type: 'boolean', default: false, example: true, description: '是否友谊赛（友谊赛不计段位、不扣灵石）' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('挑战结果', {
                type: 'object',
                properties: {
                    match_id: { type: 'integer', example: 101 },
                    result: { type: 'string', example: 'win', description: '本方结果：win/lose/draw' },
                    winner_side: { type: 'string', example: 'challenger', description: '胜方：challenger/defender/draw' },
                    total_rounds: { type: 'integer', example: 5, description: '总回合数' },
                    final_challenger_hp: { type: 'string', example: '1200', description: '挑战方最终HP（BigInt字符串）' },
                    final_defender_hp: { type: 'string', example: '0', description: '防守方最终HP（BigInt字符串）' },
                    my_beast_name: { type: 'string', example: '青云狼' },
                    opponent_beast_name: { type: 'string', example: '火焰狮' },
                    my_tactic: { type: 'string', example: 'balanced' },
                    opponent_tactic: { type: 'string', example: 'balanced' },
                    is_friendly: { type: 'boolean', example: false },
                    bet_spirit_stones: { type: 'string', example: '500', description: '押注灵石（BigInt字符串）' },
                    bet_won: { type: 'string', example: '1000', description: '赢得灵石（BigInt字符串，失败为0）' },
                    bet_lost: { type: 'string', example: '0', description: '输掉灵石（BigInt字符串，胜利为0）' },
                    points_change: { type: 'integer', example: 10, description: '胜点变化（友谊赛为0）' },
                    first_win_bonus: { type: 'integer', example: 500, description: '每日首胜奖励灵石（非首胜为0）' },
                    ranking_points: { type: 'integer', example: 10, description: '当前胜点' },
                    tier: { type: 'string', example: 'bronze', description: '当前段位' },
                    battle_log: {
                        type: 'array',
                        description: '战斗日志（关键回合摘要）',
                        items: {
                            type: 'object',
                            properties: {
                                round: { type: 'integer', example: 1 },
                                attacker: { type: 'string', example: 'challenger' },
                                damage: { type: 'integer', example: 350 },
                                is_crit: { type: 'boolean', example: false },
                                is_dodged: { type: 'boolean', example: false },
                                element_multiplier: { type: 'number', example: 1.5 },
                                challenger_hp: { type: 'string', example: '1500' },
                                defender_hp: { type: 'string', example: '1150' }
                            }
                        }
                    }
                }
            })
        }
    },

    // 6. 查询战术列表
    '/api/spirit-beast/pvp/tactics': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询可用战术列表',
            description: '获取灵兽PVP可用的战术列表，共3种战术：all_out全力一击/balanced稳健输出/counter防御反击。',
            operationId: 'getSpiritBeastPvpTactics',
            security: bearerAuth,
            responses: securityResponses('战术列表', {
                type: 'object',
                properties: {
                    tactics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', example: 'all_out' },
                                name: { type: 'string', example: '全力一击' },
                                description: { type: 'string', example: '攻击+30%，防御-20%' },
                                atk_multiplier: { type: 'number', example: 1.3 },
                                def_multiplier: { type: 'number', example: 0.8 },
                                counter_chance: { type: 'number', example: 0 }
                            }
                        }
                    }
                }
            })
        }
    },

    // 7. 查询段位信息
    '/api/spirit-beast/pvp/tiers': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询段位信息',
            description: '获取灵兽PVP的6个段位信息：青铜/白银/黄金/铂金/钻石/王者。',
            operationId: 'getSpiritBeastPvpTiers',
            security: bearerAuth,
            responses: securityResponses('段位列表', {
                type: 'object',
                properties: {
                    tiers: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', example: 'bronze' },
                                name: { type: 'string', example: '青铜' },
                                min_points: { type: 'integer', example: 0, description: '该段位最低胜点' },
                                season_reward: { type: 'integer', example: 500, description: '赛季结算奖励灵石' },
                                color: { type: 'string', example: '#9ca3af' }
                            }
                        }
                    }
                }
            })
        }
    },

    // 8. 查询对局详情
    '/api/spirit-beast/pvp/match/{matchId}': {
        get: {
            tags: ['灵兽PVP竞技场系统'],
            summary: '查询对局详情',
            description: '获取指定对局的详细信息，包含双方灵兽快照、战术、战斗日志等。仅当事人可查看。',
            operationId: 'getSpiritBeastPvpMatchDetail',
            security: bearerAuth,
            parameters: [
                { name: 'matchId', in: 'path', required: true, schema: { type: 'integer' }, description: '对局ID' }
            ],
            responses: securityResponses('对局详情', {
                type: 'object',
                properties: {
                    match_id: { type: 'integer', example: 101 },
                    season_id: { type: 'integer', example: 1 },
                    is_friendly: { type: 'boolean', example: false },
                    status: { type: 'string', example: 'finished' },
                    challenger: {
                        type: 'object',
                        properties: {
                            player_id: { type: 'integer', example: 1 },
                            beast_snapshot: {
                                type: 'object',
                                properties: {
                                    beast_name: { type: 'string', example: '青云狼' },
                                    element: { type: 'string', example: 'metal' },
                                    star_level: { type: 'integer', example: 3 },
                                    level: { type: 'integer', example: 20 },
                                    hp_max: { type: 'string', example: '1500' },
                                    atk: { type: 'integer', example: 200 },
                                    def: { type: 'integer', example: 120 },
                                    speed: { type: 'integer', example: 180 }
                                }
                            },
                            tactic: { type: 'string', example: 'balanced' },
                            final_hp: { type: 'string', example: '1200' }
                        }
                    },
                    defender: {
                        type: 'object',
                        properties: {
                            player_id: { type: 'integer', example: 9 },
                            beast_snapshot: { type: 'object' },
                            tactic: { type: 'string', example: 'balanced' },
                            final_hp: { type: 'string', example: '0' }
                        }
                    },
                    winner_side: { type: 'string', example: 'challenger' },
                    total_rounds: { type: 'integer', example: 5 },
                    bet_spirit_stones: { type: 'string', example: '500' },
                    points_change: { type: 'integer', example: 10 },
                    battle_log: { type: 'array', items: { type: 'object' } },
                    created_at: { type: 'string', format: 'date-time' },
                    finished_at: { type: 'string', format: 'date-time', nullable: true }
                }
            })
        }
    }
};

// ==================== Schema 定义 ====================
const NEW_SCHEMAS = {
    SpiritBeastPvpRanking: {
        type: 'object',
        description: '灵兽PVP赛季排位记录',
        properties: {
            id: { type: 'integer' },
            season_id: { type: 'integer' },
            player_id: { type: 'integer' },
            tier: { type: 'string', description: '段位：bronze/silver/gold/platinum/diamond/king' },
            ranking_points: { type: 'integer', description: '胜点' },
            total_matches: { type: 'integer', description: '总对局数（含友谊赛）' },
            total_wins: { type: 'integer' },
            total_losses: { type: 'integer' },
            total_draws: { type: 'integer' },
            win_rate: { type: 'number', format: 'float' },
            total_bet_won: { type: 'string', description: '累计赢得押注灵石（BigInt字符串）' },
            total_bet_lost: { type: 'string', description: '累计输掉押注灵石（BigInt字符串）' },
            daily_challenge_count: { type: 'integer' },
            daily_first_win_claimed: { type: 'boolean' }
        }
    },
    SpiritBeastPvpMatch: {
        type: 'object',
        description: '灵兽PVP对局记录',
        properties: {
            id: { type: 'integer' },
            season_id: { type: 'integer' },
            challenger_player_id: { type: 'integer' },
            challenger_beast_id: { type: 'integer' },
            challenger_beast_snapshot: { type: 'object', description: '挑战方灵兽快照' },
            challenger_tactic: { type: 'string' },
            defender_player_id: { type: 'integer' },
            defender_beast_id: { type: 'integer' },
            defender_beast_snapshot: { type: 'object' },
            defender_tactic: { type: 'string' },
            bet_spirit_stones: { type: 'string', description: '押注灵石（BigInt字符串）' },
            is_friendly: { type: 'boolean' },
            status: { type: 'string', description: 'pending/finished/cancelled' },
            winner_player_id: { type: 'integer', nullable: true },
            winner_side: { type: 'string', description: 'challenger/defender/draw' },
            total_rounds: { type: 'integer' },
            final_challenger_hp: { type: 'string' },
            final_defender_hp: { type: 'string' },
            battle_log: { type: 'array', items: { type: 'object' } },
            points_change: { type: 'integer' }
        }
    },
    SpiritBeastPvpSeason: {
        type: 'object',
        description: '灵兽PVP赛季配置',
        properties: {
            id: { type: 'integer' },
            season_name: { type: 'string' },
            start_time: { type: 'string', format: 'date-time' },
            end_time: { type: 'string', format: 'date-time' },
            status: { type: 'string', description: 'active/settled/cancelled' },
            settled_at: { type: 'string', format: 'date-time', nullable: true },
            settlement_summary: { type: 'object', nullable: true }
        }
    }
};

// ==================== 主函数 ====================
/**
 * 向 openapi.json 追加灵兽PVP系统的接口定义
 */
function applyPatch() {
    // 读取现有 OpenAPI 文档
    const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    console.log('读取 OpenAPI 文档成功');

    // 追加 tags（去重）
    if (!openapi.tags) openapi.tags = [];
    for (const tag of NEW_TAGS) {
        const idx = openapi.tags.findIndex(t => t.name === tag.name);
        if (idx >= 0) {
            openapi.tags[idx] = tag;
            console.log(`  更新 tag: ${tag.name}`);
        } else {
            openapi.tags.push(tag);
            console.log(`  追加 tag: ${tag.name}`);
        }
    }

    // 追加 paths（同 path+method 覆盖）
    if (!openapi.paths) openapi.paths = {};
    let addedPaths = 0;
    let updatedPaths = 0;
    for (const [pathKey, methods] of Object.entries(NEW_PATHS)) {
        if (!openapi.paths[pathKey]) {
            openapi.paths[pathKey] = {};
        }
        for (const [method, def] of Object.entries(methods)) {
            if (openapi.paths[pathKey][method]) {
                updatedPaths++;
            } else {
                addedPaths++;
            }
            openapi.paths[pathKey][method] = def;
        }
    }
    console.log(`  追加 ${addedPaths} 个新接口，更新 ${updatedPaths} 个已有接口`);

    // 追加 schemas（去重）
    if (!openapi.components) openapi.components = {};
    if (!openapi.components.schemas) openapi.components.schemas = {};
    let addedSchemas = 0;
    let updatedSchemas = 0;
    for (const [schemaName, schemaDef] of Object.entries(NEW_SCHEMAS)) {
        if (openapi.components.schemas[schemaName]) {
            updatedSchemas++;
        } else {
            addedSchemas++;
        }
        openapi.components.schemas[schemaName] = schemaDef;
    }
    console.log(`  追加 ${addedSchemas} 个新 Schema，更新 ${updatedSchemas} 个已有 Schema`);

    // 写回文件
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf8');
    console.log('OpenAPI 文档已更新');

    // 统计
    console.log('\n=== 统计 ===');
    console.log(`paths: ${Object.keys(openapi.paths).length}`);
    console.log(`tags: ${openapi.tags.length}`);
    console.log(`schemas: ${Object.keys(openapi.components.schemas).length}`);
}

// 执行
try {
    applyPatch();
    console.log('\n✅ 灵兽PVP竞技场系统 OpenAPI 补丁应用成功');
} catch (err) {
    console.error('\n❌ 补丁应用失败:', err.message);
    console.error(err.stack);
    process.exit(1);
}
