/**
 * OpenAPI 文档补丁脚本：神识对决系统（批次5 多人在线玩法）
 *
 * 作用：向 docs/openapi.json 注入神识对决系统的 6 个玩家接口定义：
 *   路由前缀 /api/divine-sense/duel，对应 server/routes/divine-sense.js 中的对决段
 *     1. POST /api/divine-sense/duel/challenge  - 发起神识对决挑战
 *     2. POST /api/divine-sense/duel/accept     - 接受挑战
 *     3. POST /api/divine-sense/duel/action     - 执行回合行动（凝神 focus / 固元 stabilize）
 *     4. GET  /api/divine-sense/duel/active      - 查询当前进行中的对局
 *     5. GET  /api/divine-sense/duel/history     - 查询历史对局
 *     6. POST /api/divine-sense/duel/surrender  - 投降
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（神识对决系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则覆盖，便于重新生成）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_divine_duel.js
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
        name: '神识对决系统',
        description: '批次5 多人 1v1 PvP - 同时选择博弈（凝神/固元）+ 赌注机制（灵石/神识）+ 超时自动固元'
    }
];

// ==================== 通用响应构造工具 ====================
/**
 * 构造通用响应对象（200/400/401/500）
 * @param {string} description - 200 响应的描述
 * @returns {object} OpenAPI responses 对象
 */
const securityResponses = (description) => {
    return {
        200: {
            description: description,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            success: { type: 'boolean', description: '业务是否成功（业务失败时为 false）' },
                            message: { type: 'string', description: '提示消息（成功/失败均会返回）' },
                            data: { type: 'object', nullable: true, description: '业务数据（成功时返回；失败时可能为 null 或含部分上下文）' },
                            error_code: { type: 'string', description: '业务失败时的错误码（success=false 时存在，如 BUSINESS_LOGIC_ERROR / VALIDATION_ERROR）' }
                        }
                    }
                }
            }
        },
        400: {
            description: '参数校验失败',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 400 },
                            error_code: { type: 'string', example: 'VALIDATION_ERROR' },
                            message: { type: 'string' }
                        }
                    }
                }
            }
        },
        401: {
            description: '未授权（缺少或无效 token）',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 401 },
                            message: { type: 'string' }
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
                            message: { type: 'string' }
                        }
                    }
                }
            }
        }
    };
};

// 通用 Bearer 鉴权
const BEARER_AUTH = {
    bearerAuth: []
};

// ==================== Schema 定义 ====================
const SCHEMAS = {
    // ===== 神识对决：发起挑战请求 =====
    DivineDuelChallengeRequest: {
        type: 'object',
        required: ['target_player_id', 'bet_type', 'bet_amount'],
        properties: {
            target_player_id: {
                type: 'integer',
                description: '目标玩家ID（不可为自己；目标须达化神期）',
                example: 2
            },
            bet_type: {
                type: 'string',
                enum: ['spirit_stone', 'divine_sense'],
                description: '赌注类型：spirit_stone=灵石 / divine_sense=神识',
                example: 'spirit_stone'
            },
            bet_amount: {
                type: 'integer',
                description: '赌注金额（正整数；灵石 100~10000；神识 10~100）',
                minimum: 1,
                example: 500
            }
        }
    },

    // ===== 神识对决：接受挑战请求 =====
    DivineDuelAcceptRequest: {
        type: 'object',
        required: ['duel_id'],
        properties: {
            duel_id: {
                type: 'integer',
                description: '对局ID',
                example: 1
            }
        }
    },

    // ===== 神识对决：执行行动请求 =====
    DivineDuelActionRequest: {
        type: 'object',
        required: ['duel_id', 'action'],
        properties: {
            duel_id: {
                type: 'integer',
                description: '对局ID',
                example: 1
            },
            action: {
                type: 'string',
                enum: ['focus', 'stabilize'],
                description: '行动类型：focus=凝神（消耗自身15护盾，对敌造成20伤害；遇固元减半为10）/ stabilize=固元（自身恢复10护盾，受击减半）',
                example: 'focus'
            }
        }
    },

    // ===== 神识对决：投降请求 =====
    DivineDuelSurrenderRequest: {
        type: 'object',
        required: ['duel_id'],
        properties: {
            duel_id: {
                type: 'integer',
                description: '对局ID',
                example: 1
            }
        }
    },

    // ===== 神识对决：挑战响应数据 =====
    DivineDuelChallengeData: {
        type: 'object',
        description: '挑战发起成功后返回的对局信息',
        properties: {
            duel_id: { type: 'integer', example: 1 },
            status: { type: 'string', enum: ['pending'], description: '对局状态：pending=等待对方接受' },
            bet_type: { type: 'string', enum: ['spirit_stone', 'divine_sense'] },
            bet_amount: { type: 'integer' },
            challenger_shield: { type: 'integer', description: '发起方初始护盾', example: 100 },
            defender_shield: { type: 'integer', description: '应战方初始护盾', example: 100 },
            challenge_deadline: { type: 'string', format: 'date-time', description: '对方接受的截止时间（默认 60 秒）' },
            entry_divine_sense_cost: { type: 'integer', description: '本次入场消耗的神识点（默认 50）', example: 50 }
        }
    },

    // ===== 神识对决：接受响应数据 =====
    DivineDuelAcceptData: {
        type: 'object',
        description: '接受挑战后进入 active 状态的对局信息',
        properties: {
            duel_id: { type: 'integer' },
            status: { type: 'string', enum: ['active'] },
            round_number: { type: 'integer', description: '当前回合数（从1开始）', example: 1 },
            challenger_shield: { type: 'integer' },
            defender_shield: { type: 'integer' },
            action_deadline: { type: 'string', format: 'date-time', description: '本回合行动截止时间（默认 60 秒）' }
        }
    },

    // ===== 神识对决：执行行动响应数据 =====
    DivineDuelActionData: {
        type: 'object',
        description: '执行行动后返回的信息：单方提交时 waiting_opponent=true；双方都提交时返回回合结算结果',
        properties: {
            duel_id: { type: 'integer' },
            round_number: { type: 'integer', description: '当前回合数' },
            your_action: { type: 'string', enum: ['focus', 'stabilize'], description: '本回合你提交的行动（仅单方提交时返回）' },
            waiting_opponent: { type: 'boolean', description: '是否正在等待对方行动（true=仅你已提交，等待对方；false=双方都已提交，已结算）' },
            action_deadline: { type: 'string', format: 'date-time', description: '本回合行动截止时间' },
            // 双方结算后返回的回合结果
            challenger_action: { type: 'string', enum: ['focus', 'stabilize'], nullable: true, description: '本回合发起方行动（结算后返回）' },
            defender_action: { type: 'string', enum: ['focus', 'stabilize'], nullable: true, description: '本回合应战方行动（结算后返回）' },
            challenger_shield_change: { type: 'integer', description: '发起方本回合护盾变化（含消耗/恢复/伤害）', example: -35 },
            defender_shield_change: { type: 'integer', description: '应战方本回合护盾变化', example: 10 },
            challenger_shield: { type: 'integer', description: '结算后发起方护盾值' },
            defender_shield: { type: 'integer', description: '结算后应战方护盾值' },
            challenger_damage_taken: { type: 'integer', description: '本回合发起方受到的伤害' },
            defender_damage_taken: { type: 'integer', description: '本回合应战方受到的伤害' },
            settled: { type: 'boolean', description: '本回合是否已结算' },
            duel_finished: { type: 'boolean', description: '对局是否已结束' },
            winner_id: { type: 'integer', nullable: true, description: '胜者玩家ID（平局为 null）' },
            settle_reason: { type: 'string', nullable: true, enum: ['shield_zero', 'rounds_limit', 'surrender', 'timeout'], description: '对局结束原因' },
            next_round: { type: 'integer', nullable: true, description: '下一回合编号（对局未结束时返回）' },
            next_action_deadline: { type: 'string', format: 'date-time', nullable: true, description: '下一回合行动截止时间' },
            bet_settlement: {
                type: 'object',
                nullable: true,
                description: '赌注结算结果（对局结束时返回）',
                properties: {
                    bet_type: { type: 'string', enum: ['spirit_stone', 'divine_sense'] },
                    bet_amount: { type: 'integer' },
                    winner_id: { type: 'integer', nullable: true },
                    settle_reason: { type: 'string' },
                    winner_reward: { type: 'integer', nullable: true, description: '胜者获得的赌注总额（含本金），默认为 2 * bet_amount' },
                    draw_refund: { type: 'integer', nullable: true, description: '平局时双方各退还的金额（默认为 bet_amount * 0.5）' }
                }
            }
        }
    },

    // ===== 神识对决：当前对局响应数据 =====
    DivineDuelActiveData: {
        type: 'object',
        nullable: true,
        description: '当前进行中的对局信息（无进行中对局时为 null）',
        properties: {
            duel_id: { type: 'integer' },
            status: { type: 'string', enum: ['pending', 'active'], description: 'pending=等待对方接受；active=对局进行中' },
            bet_type: { type: 'string', enum: ['spirit_stone', 'divine_sense'] },
            bet_amount: { type: 'integer' },
            round_number: { type: 'integer', description: '当前回合数（pending 状态为 0）' },
            challenger: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    nickname: { type: 'string' },
                    realm: { type: 'string' }
                }
            },
            defender: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    nickname: { type: 'string' },
                    realm: { type: 'string' }
                }
            },
            challenger_shield: { type: 'integer' },
            defender_shield: { type: 'integer' },
            your_action: { type: 'string', enum: ['focus', 'stabilize'], nullable: true, description: '本回合你已提交的行动（未提交为 null）' },
            opponent_action: { type: 'string', enum: ['focus', 'stabilize'], nullable: true, description: '本回合对方已提交的行动（结算前对玩家隐藏，但本接口为只读查询返回真实值；建议前端在结算前显示为"已提交"）' },
            action_deadline: { type: 'string', format: 'date-time', nullable: true, description: '本回合行动截止时间（pending 状态为接受截止时间）' },
            settle_reason: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' }
        }
    },

    // ===== 神识对决：历史对局响应数据 =====
    DivineDuelHistoryData: {
        type: 'object',
        description: '历史对局列表（分页）',
        properties: {
            total: { type: 'integer', description: '总对局数' },
            page: { type: 'integer', description: '当前页码' },
            page_size: { type: 'integer', description: '每页条数' },
            duels: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        duel_id: { type: 'integer' },
                        status: { type: 'string', enum: ['pending', 'active', 'finished', 'cancelled'] },
                        bet_type: { type: 'string', enum: ['spirit_stone', 'divine_sense'] },
                        bet_amount: { type: 'integer' },
                        round_number: { type: 'integer' },
                        challenger: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                nickname: { type: 'string' }
                            }
                        },
                        defender: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                nickname: { type: 'string' }
                            }
                        },
                        winner_id: { type: 'integer', nullable: true },
                        is_winner: { type: 'boolean', description: '当前玩家是否胜者' },
                        is_draw: { type: 'boolean', description: '是否平局' },
                        settle_reason: { type: 'string', nullable: true, enum: ['shield_zero', 'rounds_limit', 'surrender', 'timeout'] },
                        challenger_shield: { type: 'integer' },
                        defender_shield: { type: 'integer' },
                        created_at: { type: 'string', format: 'date-time' },
                        finished_at: { type: 'string', format: 'date-time', nullable: true }
                    }
                }
            }
        }
    },

    // ===== 神识对决：投降响应数据 =====
    DivineDuelSurrenderData: {
        type: 'object',
        description: '投降后对局立即结算，对手获胜',
        properties: {
            duel_id: { type: 'integer' },
            status: { type: 'string', enum: ['finished'] },
            winner_id: { type: 'integer', description: '对手玩家ID' },
            settle_reason: { type: 'string', enum: ['surrender'] },
            bet_settlement: {
                type: 'object',
                properties: {
                    bet_type: { type: 'string', enum: ['spirit_stone', 'divine_sense'] },
                    bet_amount: { type: 'integer' },
                    winner_id: { type: 'integer' },
                    settle_reason: { type: 'string' },
                    winner_reward: { type: 'integer', description: '对手获得的赌注总额（2 * bet_amount）' }
                }
            }
        }
    }
};

// ==================== 新增 Path 定义 ====================
const NEW_PATHS = {
    // 1. 发起挑战
    '/api/divine-sense/duel/challenge': {
        post: {
            tags: ['神识对决系统'],
            summary: '发起神识对决挑战',
            description: [
                '向另一名玩家发起神识对决挑战（1v1 同时选择博弈 PvP）。',
                '',
                '前置条件：',
                '  1. 发起方境界 ≥ 化神期（rank≥23）',
                '  2. 发起方神识余额 ≥ 50（入场消耗，与赌注独立）',
                '  3. 灵石赌注：余额 ≥ bet_amount（范围 100~10000）',
                '     神识赌注：余额 ≥ 50 + bet_amount（范围 10~100，含入场消耗）',
                '  4. 双方均无进行中的对局',
                '  5. 今日发起次数 < 3 次（每日 0 点重置）',
                '',
                '挑战发出后 60 秒内未接受，对局自动取消并退还赌注+入场神识。'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/DivineDuelChallengeRequest' }
                    }
                }
            },
            responses: securityResponses('挑战已发起，等待对方接受')
        }
    },

    // 2. 接受挑战
    '/api/divine-sense/duel/accept': {
        post: {
            tags: ['神识对决系统'],
            summary: '接受神识对决挑战',
            description: [
                '应战方接受挑战，对局进入 active 状态，开始第 1 回合。',
                '',
                '前置条件：',
                '  1. 调用方为对局的 defender',
                '  2. 对局状态为 pending 且未超时',
                '  3. 今日接受次数 < 5 次（每日 0 点重置）',
                '  4. 赌注余额充足（与发起方同等校验，但不另扣入场神识）',
                '',
                '接受后对局进入第 1 回合，双方需在 60 秒内提交行动（凝神/固元）。'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/DivineDuelAcceptRequest' }
                    }
                }
            },
            responses: securityResponses('已接受挑战，第 1 回合开始')
        }
    },

    // 3. 执行回合行动
    '/api/divine-sense/duel/action': {
        post: {
            tags: ['神识对决系统'],
            summary: '执行回合行动（凝神/固元）',
            description: [
                '提交本回合的行动选择。双方都提交后触发回合结算。',
                '',
                '行动类型：',
                '  - focus（凝神）：消耗自身 15 护盾，对敌造成 20 伤害；若对方固元则伤害减半为 10',
                '  - stabilize（固元）：自身恢复 10 护盾，受击伤害减半；双方都固元时恢复量减半为 5',
                '',
                '结算矩阵（A=发起方，B=应战方）：',
                '  凝神 vs 凝神：A -15护盾 + 受20伤害，B -15护盾 + 受20伤害',
                '  凝神 vs 固元：A -15护盾 + 受10伤害（减半），B +10护盾 + 受20伤害',
                '  固元 vs 凝神：A +10护盾 + 受20伤害，B -15护盾 + 受10伤害（减半）',
                '  固元 vs 固元：A +5护盾（减半），B +5护盾（减半）',
                '',
                '幂等性：本回合已提交过行动返回错误，等待对方。',
                '超时：本回合 60 秒内未行动方自动固元。'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/DivineDuelActionRequest' }
                    }
                }
            },
            responses: securityResponses('行动已提交，等待对方或回合已结算')
        }
    },

    // 4. 查询当前对局
    '/api/divine-sense/duel/active': {
        get: {
            tags: ['神识对决系统'],
            summary: '查询当前进行中的对局',
            description: '查询调用方当前进行中（pending/active）的对局。无进行中对局时返回 data=null。对局数据包括双方护盾、本回合自己已提交的行动、回合截止时间等。',
            security: [BEARER_AUTH],
            responses: securityResponses('返回当前进行中的对局信息')
        }
    },

    // 5. 查询历史
    '/api/divine-sense/duel/history': {
        get: {
            tags: ['神识对决系统'],
            summary: '查询神识对决历史',
            description: '分页查询调用方的历史对局（含 finished/cancelled）。按 created_at 倒序。',
            security: [BEARER_AUTH],
            parameters: [
                {
                    name: 'page',
                    in: 'query',
                    required: false,
                    schema: { type: 'integer', minimum: 1, default: 1 },
                    description: '页码（1-based，默认 1）'
                },
                {
                    name: 'page_size',
                    in: 'query',
                    required: false,
                    schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
                    description: '每页条数（默认 10，最大 50）'
                }
            ],
            responses: securityResponses('返回分页历史对局列表')
        }
    },

    // 6. 投降
    '/api/divine-sense/duel/surrender': {
        post: {
            tags: ['神识对决系统'],
            summary: '投降',
            description: [
                '立即结束对局，对手获胜。',
                '',
                '前置条件：',
                '  1. 对局状态为 active',
                '  2. 调用方为对局参与方',
                '',
                '投降后立即触发赌注结算：对手获得 2 * bet_amount 赌注（灵石或神识）。'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/DivineDuelSurrenderRequest' }
                    }
                }
            },
            responses: securityResponses('已投降，对手获胜')
        }
    }
};

// ==================== 主函数 ====================
/**
 * 主函数：读取 openapi.json -> 注入 tag + path + schema -> 写回
 * 幂等性：相同 path+method 会被覆盖更新；schema 同名会被覆盖
 */
function main() {
    console.log('[OpenAPI Patch] 开始注入神识对决系统接口...');

    // 1. 读取现有 openapi.json
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error(`[OpenAPI Patch] 错误：文件不存在 ${OPENAPI_PATH}`);
        process.exit(1);
    }
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
    const openapi = JSON.parse(raw);
    console.log(`[OpenAPI Patch] 原始 paths=${Object.keys(openapi.paths || {}).length}, tags=${(openapi.tags || []).length}, schemas=${Object.keys((openapi.components && openapi.components.schemas) || {}).length}`);

    // 2. 注入 tags（去重：同名 tag 不重复添加）
    if (!Array.isArray(openapi.tags)) openapi.tags = [];
    const existingTagNames = new Set(openapi.tags.map(t => t.name));
    for (const newTag of NEW_TAGS) {
        if (!existingTagNames.has(newTag.name)) {
            openapi.tags.push(newTag);
            console.log(`[OpenAPI Patch] 新增 tag: ${newTag.name}`);
        } else {
            // 已存在则更新（按 name 覆盖）
            const idx = openapi.tags.findIndex(t => t.name === newTag.name);
            openapi.tags[idx] = newTag;
            console.log(`[OpenAPI Patch] 更新 tag: ${newTag.name}`);
        }
    }

    // 3. 注入 paths（覆盖同名 path+method）
    if (!openapi.paths) openapi.paths = {};
    let addedPaths = 0;
    let updatedPaths = 0;
    for (const [pathUrl, pathItem] of Object.entries(NEW_PATHS)) {
        if (!openapi.paths[pathUrl]) {
            openapi.paths[pathUrl] = pathItem;
            addedPaths++;
        } else {
            // 合并：覆盖已有 method
            for (const [method, operation] of Object.entries(pathItem)) {
                if (openapi.paths[pathUrl][method]) {
                    updatedPaths++;
                } else {
                    addedPaths++;
                }
                openapi.paths[pathUrl][method] = operation;
            }
        }
    }
    console.log(`[OpenAPI Patch] paths 注入完成：新增 ${addedPaths} 个，更新 ${updatedPaths} 个`);

    // 4. 注入 schemas（覆盖同名 schema）
    if (!openapi.components) openapi.components = {};
    if (!openapi.components.schemas) openapi.components.schemas = {};
    let addedSchemas = 0;
    let updatedSchemas = 0;
    for (const [schemaName, schemaDef] of Object.entries(SCHEMAS)) {
        if (openapi.components.schemas[schemaName]) {
            updatedSchemas++;
        } else {
            addedSchemas++;
        }
        openapi.components.schemas[schemaName] = schemaDef;
    }
    console.log(`[OpenAPI Patch] schemas 注入完成：新增 ${addedSchemas} 个，更新 ${updatedSchemas} 个`);

    // 5. 写回文件（保留 2 空格缩进）
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf-8');
    console.log(`[OpenAPI Patch] 写回完成：${OPENAPI_PATH}`);
    console.log(`[OpenAPI Patch] 最终 paths=${Object.keys(openapi.paths).length}, tags=${openapi.tags.length}, schemas=${Object.keys(openapi.components.schemas).length}`);
    console.log('[OpenAPI Patch] 神识对决系统接口注入完成');
}

main();
