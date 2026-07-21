/**
 * OpenAPI 文档补丁脚本：慕兰战线系统（批次5 多人在线玩法）
 *
 * 作用：向 docs/openapi.json 注入慕兰战线系统的 19 个玩家接口定义：
 *   路由前缀 /api/border-military，对应 server/routes/border_military.js
 *     1.  GET  /api/border-military/status                - 查询玩家战线状态（军衔/军议/今日行动/里程碑）
 *     2.  POST /api/border-military/support               - 执行支援慕兰（4 种路线）
 *     3.  GET  /api/border-military/briefing              - 查询今日军议（密令/险棋/粮道路线）
 *     4.  GET  /api/border-military/rank                  - 查询军衔信息
 *     5.  GET  /api/border-military/intel                 - 查询军报列表
 *     6.  POST /api/border-military/intel/collect         - 搜集军报（每日1次）
 *     7.  POST /api/border-military/intel/identify        - 辨报
 *     8.  POST /api/border-military/intel/public          - 公开军报
 *     9.  GET  /api/border-military/shop                  - 查询军功司兑换列表
 *    10.  POST /api/border-military/exchange              - 军功兑换
 *    11.  GET  /api/border-military/history               - 查询支援历史
 *    12.  GET  /api/border-military/beast-patrol          - 查询灵兽巡边状态
 *    13.  POST /api/border-military/beast-patrol          - 派出灵兽巡边
 *    14.  POST /api/border-military/beast-patrol/return   - 灵兽巡边归来结算
 *    15.  GET  /api/border-military/remnant-map           - 查询残图匣状态
 *    16.  POST /api/border-military/remnant-map/combine   - 拼残图
 *    17.  POST /api/border-military/remnant-map/explore   - 按图探禁
 *    18.  GET  /api/border-military/imprint               - 查询临战刻印状态
 *    19.  POST /api/border-military/imprint/apply         - 施加临战刻印
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（慕兰战线系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则覆盖，便于重新生成）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_border_military.js
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
        name: '慕兰战线系统',
        description: '批次5 多人在线玩法 - 慕兰烽烟+慕兰谍影+军功司+灵兽边境+残图匣+临战刻印 7 大子系统完整闭环'
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
                            message: { type: 'string', example: 'route 必填，可选：scout/lamp_breaker/array_guard/raid' }
                        }
                    }
                }
            }
        },
        401: {
            description: '未认证或 token 无效',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 401 },
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
                            message: { type: 'string' }
                        }
                    }
                }
            }
        }
    };
};

// 通用的 security 要求（需要 bearer token）
const securityRequirement = [{ bearerAuth: [] }];

// 玩家接口的通用响应（同 securityResponses，保留命名一致性）
const playerResponses = (description) => securityResponses(description);

// ==================== 19 个新接口定义 ====================
const NEW_PATHS = {
    // ============== 1. 查询玩家战线状态 ==============
    '/api/border-military/status': {
        get: {
            summary: '查询玩家战线状态',
            description: '查询玩家战线状态：军衔信息（含累计/可用军功）、今日军议（密令/险棋/粮道路线）、今日各行动状态（支援/军报搜集/军报公开/灵兽巡边/残图探禁/临战刻印）、里程碑已发放列表及下一里程碑。该接口为只读操作，会自动初始化今日军议缓存。境界不足时返回 can_participate=false 及原因。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('战线状态（can_participate、rank、daily_briefing、today_actions、milestones）')
        }
    },

    // ============== 2. 执行支援慕兰 ==============
    '/api/border-military/support': {
        post: {
            summary: '执行支援慕兰',
            description: '执行支援慕兰（每日 1 次）。4 种路线：scout=斥候（稳健探路）/ lamp_breaker=破灯（克制慕兰圣灯，低概率获得【慕兰圣灯残焰】）/ array_guard=护阵（风险最低，偏灵石和阵旗残片）/ raid=奇袭（收益和风险更高，偏妖丹、蛇胆和稀有战利品）。失败概率按路线配置：scout 5% / lamp_breaker 15% / array_guard 2% / raid 25%。加成计算：军衔加成 + 临战刻印加成 + 军报加成 + 密令路线加成 + 险棋路线加成（成功时）。境界需≥结丹期。事务+行级锁保证原子性。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['route'],
                            properties: {
                                route: {
                                    type: 'string',
                                    enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'],
                                    description: '支援路线：scout=斥候 / lamp_breaker=破灯 / array_guard=护阵 / raid=奇袭',
                                    example: 'scout'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('支援结果（route、route_name、base_merit、final_merit、merit_bonus_rate、spirit_stones_gained、items_dropped、is_secret_order、is_risky_route、is_grain_route、imprint_triggered、intel_bonus_rate、new_rank、milestone；失败时为 failed=true、spirit_stones_loss、hp_loss）')
        }
    },

    // ============== 3. 查询今日军议 ==============
    '/api/border-military/briefing': {
        get: {
            summary: '查询今日军议',
            description: '查询今日军议（每日0点后首次访问时随机生成并缓存，跨日自动重置）：3 个特殊路线及其加成说明。密令路线：押中后军功+50%；险棋路线：失败惩罚+30%，成功额外+50%军功；粮道路线：灵石收益+50%。返回字段 date / secret_order / risky_route / grain_route / description。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('今日军议（date、secret_order、risky_route、grain_route、description）')
        }
    },

    // ============== 4. 查询军衔信息 ==============
    '/api/border-military/rank': {
        get: {
            summary: '查询军衔信息',
            description: '查询军衔信息（按累计军功自动晋升，军衔不可倒退）：军衔等级（0-6）、军衔名称（白丁/戍卒/伍长/什长/百户/千户/天南边军）、所需最低军功、每日支援军功加成比例、辨报成功率加成比例、是否为里程碑军衔、累计军功、可用军功。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('军衔信息（rank、name、min_merit、daily_support_bonus、intel_identify_bonus、is_milestone、merit_total、merit_available）')
        }
    },

    // ============== 5. 查询军报列表 ==============
    '/api/border-military/intel': {
        get: {
            summary: '查询军报列表',
            description: '查询玩家搜集过的军报列表（慕兰谍影子系统）。默认仅返回今日军报，可通过 only_today=0 查询历史所有军报。每条军报返回：id、report_date、index、type（troop_movement/supply_line/lamp_status/array_intel/elite_movement）、content、是否已辨报、辨报结果、公开状态、军功变化。仅当已辨报或已公开后才能看到 is_true 真伪字段。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            parameters: [
                {
                    name: 'only_today',
                    in: 'query',
                    required: false,
                    schema: { type: 'string', enum: ['0', '1', 'true', 'false'], default: '1' },
                    description: '是否仅查询今日军报：1/true=仅今日（默认），0/false=全部历史'
                }
            ],
            responses: playerResponses('军报列表（reports 数组、today_public_done）')
        }
    },

    // ============== 6. 搜集军报 ==============
    '/api/border-military/intel/collect': {
        post: {
            summary: '搜集军报',
            description: '搜集军报（每日 1 次）：从 5 种军报类型（敌军动向/粮道情报/圣灯状态/阵法情报/精锐动向）中随机不重复抽取 3 条，真假概率各 50%。每条军报含 confusion_rate 混淆度（影响辨报成功率）。境界需≥结丹期。无请求体参数。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: playerResponses('搜集结果（reports 数组含 id/index/type/type_description/content/identified/public_status）')
        }
    },

    // ============== 7. 辨报 ==============
    '/api/border-military/intel/identify': {
        post: {
            summary: '辨报',
            description: '辨报（研判某条军报的真伪）。成功率 = 基础50% + 军衔加成 - 报告混淆度（clamp 至 10%-95%）。辨报后揭示实际真伪（is_true），辨报结果 correct=正确 / wrong=失误。仅可辨报自己搜集且未辨报过的军报。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['report_id'],
                            properties: {
                                report_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '军报ID',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('辨报结果（report_id、identified_as、actual、is_correct、identified_result、success_rate）')
        }
    },

    // ============== 8. 公开军报 ==============
    '/api/border-military/intel/public': {
        post: {
            summary: '公开军报',
            description: '公开军报（将辨报后的军报交给前线，每日限 1 次）。真军报且辨报正确：+3 军功 + 当日支援加成 +20%；假军报且辨报正确：+1 军功，无支援影响；辨报失误：-1 军功 + 当日支援惩罚 -20%。仅可公开今日搜集、已辨报且未公开过的军报。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['report_id'],
                            properties: {
                                report_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '军报ID',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('公开结果（report_id、is_true、identified_correct、merit_change、support_effect、support_rate）')
        }
    },

    // ============== 9. 查询军功司兑换列表 ==============
    '/api/border-military/shop': {
        get: {
            summary: '查询军功司兑换列表',
            description: '查询军功司兑换物品列表（含可兑换状态）：每项物品返回 key/name/cost_merit/description/daily_limit/requires_rank/can_exchange。军衔不足时 can_exchange=false。返回当前军衔信息。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('兑换列表（rank 军衔信息、items 物品数组）')
        }
    },

    // ============== 10. 军功兑换 ==============
    '/api/border-military/exchange': {
        post: {
            summary: '军功兑换',
            description: '军功兑换：消耗可用军功兑换物品。校验：物品存在性、军衔等级是否满足 requires_rank、兑换数量在 1-daily_limit 之间、可用军功是否充足。扣减军功（仅扣 available，不影响 total 累计军功）+ 发放物品到背包。事务+行级锁保证原子性。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['item_key'],
                            properties: {
                                item_key: {
                                    type: 'string',
                                    description: '物品 key（如 huiling_pill / huanglong_merit_token / mulan_lamp_remnant / divine_sense_jade_slip / tianan_border_badge）',
                                    example: 'huiling_pill'
                                },
                                quantity: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '兑换数量（默认 1，不超过物品 daily_limit）',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('兑换结果（item_key、item_name、quantity、cost_merit、merit_available）')
        }
    },

    // ============== 11. 查询支援历史 ==============
    '/api/border-military/history': {
        get: {
            summary: '查询支援历史',
            description: '查询支援慕兰的历史记录（按时间倒序），含每次支援的路线、是否密令/险棋/粮道路线、基础军功、最终军功、加成比例、灵石收益、物品掉落、临战刻印是否触发、军报加成比例、是否失败。默认 20 条，最多 100 条。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            parameters: [
                {
                    name: 'limit',
                    in: 'query',
                    required: false,
                    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    description: '返回条数（默认 20，最多 100）'
                }
            ],
            responses: playerResponses('支援历史（logs 数组）')
        }
    },

    // ============== 12. 查询灵兽巡边状态 + 13. 派出灵兽巡边（同 path 不同 method） ==============
    '/api/border-military/beast-patrol': {
        get: {
            summary: '查询灵兽巡边状态',
            description: '查询灵兽边境巡边状态：今日是否已派出（today_done）、当前未结算的巡边记录（active_patrols，含可否结算 can_settle）、最近 10 条已结算的巡边历史（recent_patrols，含军功/灵石/灵兽经验/物品收益）。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('巡边状态（today_done、active_patrols 数组、recent_patrols 数组）')
        },
        post: {
            summary: '派出灵兽巡边',
            description: '派出灵兽参与巡边（每日 1 次，每只灵兽仅可同时有 1 个未结算巡边）。3 种路线：scout=斥候（偏残图路线，1-3 军功+残片掉落）/ grain_guard=护粮（偏灵石补给，1-2 军功+100-300 灵石）/ camp_raid=袭营（风险更高，2-5 军功+稀有材料，失败率 20%）。巡边时长 1 小时，到期才能结算。校验：境界≥结丹期、玩家未死亡、灵兽归属、灵兽等级≥1、忠诚度≥30、无同灵兽未结算巡边。事务+行级锁保证原子性。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['beast_id', 'route'],
                            properties: {
                                beast_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '灵兽实例ID（spirit_beasts.id）',
                                    example: 1
                                },
                                route: {
                                    type: 'string',
                                    enum: ['scout', 'grain_guard', 'camp_raid'],
                                    description: '巡边路线：scout=斥候 / grain_guard=护粮 / camp_raid=袭营',
                                    example: 'scout'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('派出结果（patrol_id、beast_id、beast_name、route、route_name、start_time、end_time、duration_seconds）')
        }
    },

    // ============== 14. 灵兽巡边归来结算 ==============
    '/api/border-military/beast-patrol/return': {
        post: {
            summary: '灵兽巡边归来结算',
            description: '灵兽巡边归来结算（必须到达 end_time 后才可结算）。袭营路线有 20% 失败概率，失败扣 HP/灵石无奖励。成功：获得军功（按路线 merit_range）+ 灵石（仅护粮路线）+ 玩家修为（约为探禁的 1/5）+ 灵兽经验（按路线 beast_exp 配置）+ 物品掉落。自动检查里程碑奖励。事务+行级锁保证原子性。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['patrol_id'],
                            properties: {
                                patrol_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '巡边记录ID',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('结算结果（patrol_id、route、route_name、merit_gained、spirit_stones_gained、player_exp_gained、beast_exp_gained、items_dropped、new_rank、milestone；失败时为 failed=true、spirit_stones_loss、hp_loss）')
        }
    },

    // ============== 15. 查询残图匣状态 ==============
    '/api/border-military/remnant-map': {
        get: {
            summary: '查询残图匣状态',
            description: '查询残图匣状态：4 类残片（A/B/C/D 对应苍坤残片·甲/乙/丙/丁）持有数量、完整残图数量、拼图消耗灵石（默认 500）、是否可拼图（4 类残片各≥1 且灵石足够）、可探禁状态（有完整残图且今日未探禁）、今日是否已探禁。缺失残片类型通过 can_combine_missing 返回。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('残图匣状态（fragments 4 类对象、complete_maps、combine_cost_spirit_stones、can_combine、can_combine_missing、can_explore、explore_block_reason、today_explored）')
        }
    },

    // ============== 16. 拼残图 ==============
    '/api/border-military/remnant-map/combine': {
        post: {
            summary: '拼残图',
            description: '拼残图（消耗 4 类残片各 1 个 + 灵石（默认 500），获得 1 张完整残图【苍坤残图】）。校验：境界≥结丹期、玩家未死亡、4 类残片各≥1、灵石≥消耗。事务+行级锁保证原子性。无请求体参数。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: playerResponses('拼图结果（complete_maps、spirit_stones_cost、spirit_stones_remaining）')
        }
    },

    // ============== 17. 按图探禁 ==============
    '/api/border-military/remnant-map/explore': {
        post: {
            summary: '按图探禁',
            description: '按图探禁（每日限 1 次）：消耗 1 张完整残图，进入苍坤旧禁边缘。10% 失败概率，失败扣 HP/灵石。成功：获得军功 3-8、灵石 200-800、修为 100-500、物品掉落（苍坤旧料 30% / 神识玉简 5% / 黄龙军功牌 10%）。自动检查里程碑奖励。境界需≥结丹期。事务+行级锁保证原子性。无请求体参数。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: playerResponses('探禁结果（merit_gained、spirit_stones_gained、exp_gained、items_dropped、new_rank、milestone；失败时为 failed=true、spirit_stones_loss、hp_loss）')
        }
    },

    // ============== 18. 查询临战刻印状态 ==============
    '/api/border-military/imprint': {
        get: {
            summary: '查询临战刻印状态',
            description: '查询临战刻印状态：今日是否已施加（today_done）、active 刻印数量上限（默认 1）、当前未触发且未过期的 active 刻印列表（active_imprints，含 artifact_id/artifact_name/imprint_type/matched_route/bonus_rate/materials_consumed/expires_at）、最近 10 条历史刻印记录（recent_imprints，含是否触发及触发路线）、可用刻印类型（available_types：lamp_breaker=破灯刻印 / array_guard=护阵刻印 / scout_stealth=潜行刻印）。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            responses: playerResponses('刻印状态（today_done、max_active_imprints、active_count、active_imprints 数组、recent_imprints 数组、available_types 数组）')
        }
    },

    // ============== 19. 施加临战刻印 ==============
    '/api/border-military/imprint/apply': {
        post: {
            summary: '施加临战刻印',
            description: '给已有法宝施加一次性临战刻印（每日 1 次，同时最多 1 个 active 刻印）。3 种刻印：lamp_breaker=破灯刻印（适配破灯路线，加成+30%，消耗阵旗残片×3）/ array_guard=护阵刻印（适配护阵路线，加成+25%，消耗阵旗残片×2）/ scout_stealth=潜行刻印（适配斥候或奇袭路线，加成+20%，消耗灵草×5）。刻印 24 小时过期，支援对应路线时自动触发并标记 triggered=true。校验：境界≥结丹期、玩家未死亡、刻印类型合法、今日未刻印、法宝归属、法宝耐久>0、active 刻印数<上限、材料充足。事务+行级锁保证原子性。',
            tags: ['慕兰战线系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['artifact_id', 'imprint_type'],
                            properties: {
                                artifact_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '玩家装备实例ID（PlayerEquipment.id）',
                                    example: 1
                                },
                                imprint_type: {
                                    type: 'string',
                                    enum: ['lamp_breaker', 'array_guard', 'scout_stealth'],
                                    description: '刻印类型：lamp_breaker=破灯刻印 / array_guard=护阵刻印 / scout_stealth=潜行刻印',
                                    example: 'lamp_breaker'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('刻印结果（imprint_id、artifact_id、artifact_name、imprint_type、imprint_name、matched_route、bonus_rate、materials_consumed、expires_at）')
        }
    }
};

// ==================== 新增 Schema 定义 ====================
// 为关键响应定义专属 schema，便于前端/工具引用（仅追加，不覆盖同名 schema）
const NEW_SCHEMAS = {
    // 军衔信息
    BorderMilitaryRank: {
        type: 'object',
        description: '军衔信息',
        properties: {
            rank: { type: 'integer', minimum: 0, maximum: 6, description: '军衔等级（0=白丁，6=天南边军）' },
            name: { type: 'string', description: '军衔名称' },
            min_merit: { type: 'integer', description: '该军衔所需最低累计军功' },
            daily_support_bonus: { type: 'number', description: '每日支援军功加成比例（如 0.05 表示 +5%）' },
            intel_identify_bonus: { type: 'number', description: '辨报成功率加成比例' },
            is_milestone: { type: 'boolean', description: '是否为里程碑军衔（如天南边军）' },
            merit_total: { type: 'integer', description: '累计军功（只增不减，决定军衔）' },
            merit_available: { type: 'integer', description: '可用军功（可兑换消耗）' }
        }
    },
    // 今日军议
    BorderMilitaryBriefing: {
        type: 'object',
        description: '今日军议（每日0点后随机生成并缓存）',
        properties: {
            date: { type: 'string', format: 'date', description: '军议日期 YYYY-MM-DD' },
            secret_order: { type: 'string', enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'], description: '密令路线（押中后军功+50%）' },
            risky_route: { type: 'string', enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'], description: '险棋路线（失败惩罚+30%，成功额外+50%军功）' },
            grain_route: { type: 'string', enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'], description: '粮道路线（灵石收益+50%）' },
            description: { type: 'string', description: '军议描述文本' }
        }
    },
    // 战线状态响应数据
    BorderMilitaryStatusResponse: {
        type: 'object',
        description: '战线状态响应数据',
        properties: {
            can_participate: { type: 'boolean', description: '是否可参与（境界是否满足）' },
            reason: { type: 'string', description: '不可参与原因（can_participate=false 时存在）', nullable: true },
            min_realm: { type: 'string', description: '参与所需最低境界（如"结丹期"）', nullable: true },
            rank: { $ref: '#/components/schemas/BorderMilitaryRank' },
            daily_briefing: { $ref: '#/components/schemas/BorderMilitaryBriefing' },
            today_actions: {
                type: 'object',
                description: '今日各行动状态',
                properties: {
                    supported: { type: 'boolean', description: '今日是否已支援' },
                    support_route: { type: 'string', enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'], description: '今日已支援的路线', nullable: true },
                    intel_collected: { type: 'boolean', description: '今日是否已搜集军报' },
                    intel_public_done: { type: 'boolean', description: '今日是否已公开军报' },
                    beast_patrol_done: { type: 'boolean', description: '今日是否已派出灵兽巡边' },
                    remnant_explored: { type: 'boolean', description: '今日是否已按图探禁' },
                    imprint_done: { type: 'boolean', description: '今日是否已施加临战刻印' }
                }
            },
            milestones: {
                type: 'object',
                description: '里程碑进度',
                properties: {
                    granted: {
                        type: 'array',
                        description: '已发放的里程碑列表',
                        items: {
                            type: 'object',
                            properties: {
                                merit: { type: 'integer', description: '里程碑军功阈值' },
                                title: { type: 'string', description: '里程碑称号' },
                                granted_at: { type: 'string', format: 'date-time', description: '发放时间' }
                            }
                        }
                    },
                    next: {
                        type: 'object',
                        description: '下一个未达成的里程碑',
                        nullable: true,
                        properties: {
                            merit: { type: 'integer', description: '里程碑军功阈值' },
                            title: { type: 'string', description: '里程碑称号' },
                            rewards: { type: 'object', description: '奖励内容' }
                        }
                    }
                }
            }
        }
    },
    // 支援结果数据
    BorderMilitarySupportResult: {
        type: 'object',
        description: '支援慕兰结果数据（成功）',
        properties: {
            route: { type: 'string', enum: ['scout', 'lamp_breaker', 'array_guard', 'raid'], description: '支援路线' },
            route_name: { type: 'string', description: '路线中文名（斥候/破灯/护阵/奇袭）' },
            base_merit: { type: 'integer', description: '基础军功' },
            final_merit: { type: 'integer', description: '最终军功（含加成）' },
            merit_bonus_rate: { type: 'number', description: '总军功加成比例' },
            spirit_stones_gained: { type: 'integer', description: '获得灵石数量' },
            items_dropped: {
                type: 'array',
                description: '掉落物品列表',
                items: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: '物品 key' },
                        quantity: { type: 'integer', description: '数量' }
                    }
                }
            },
            is_secret_order: { type: 'boolean', description: '是否为密令路线' },
            is_risky_route: { type: 'boolean', description: '是否为险棋路线' },
            is_grain_route: { type: 'boolean', description: '是否为粮道路线' },
            imprint_triggered: { type: 'boolean', description: '是否触发了临战刻印' },
            intel_bonus_rate: { type: 'number', description: '军报加成比例' },
            new_rank: { $ref: '#/components/schemas/BorderMilitaryRank' },
            milestone: {
                type: 'object',
                description: '里程碑达成情况',
                properties: {
                    triggered: { type: 'boolean', description: '是否触发里程碑' },
                    title: { type: 'string', description: '里程碑称号（触发时存在）' },
                    merit: { type: 'integer', description: '里程碑军功阈值（触发时存在）' },
                    rewards: { type: 'object', description: '奖励内容（触发时存在）' }
                }
            }
        }
    },
    // 支援失败结果数据
    BorderMilitarySupportFailure: {
        type: 'object',
        description: '支援慕兰失败结果数据',
        properties: {
            route: { type: 'string', description: '支援路线' },
            route_name: { type: 'string', description: '路线中文名' },
            is_secret_order: { type: 'boolean', description: '是否为密令路线' },
            is_risky_route: { type: 'boolean', description: '是否为险棋路线' },
            spirit_stones_loss: { type: 'integer', description: '损失灵石数量' },
            hp_loss: { type: 'string', description: '损失 HP 数量（BigInt 序列化为字符串）' }
        }
    },
    // 军报项
    BorderMilitaryIntelReport: {
        type: 'object',
        description: '军报项',
        properties: {
            id: { type: 'integer', description: '军报ID' },
            report_date: { type: 'string', format: 'date', description: '军报日期 YYYY-MM-DD' },
            index: { type: 'integer', description: '当日序号（1-3）' },
            type: { type: 'string', enum: ['troop_movement', 'supply_line', 'lamp_status', 'array_intel', 'elite_movement'], description: '军报类型' },
            content: { type: 'string', description: '军报内容文本' },
            identified: { type: 'boolean', description: '是否已辨报' },
            identified_result: { type: 'string', enum: ['correct', 'wrong'], description: '辨报结果（已辨报时存在）', nullable: true },
            public_status: { type: 'string', enum: ['pending', 'publiced'], description: '公开状态' },
            merit_change: { type: 'integer', description: '公开后的军功变化' },
            is_true: { type: 'boolean', description: '是否为真军报（仅已辨报或已公开后可见，否则为 null）', nullable: true }
        }
    },
    // 军报列表响应数据
    BorderMilitaryIntelListResponse: {
        type: 'object',
        description: '军报列表响应数据',
        properties: {
            reports: {
                type: 'array',
                description: '军报列表',
                items: { $ref: '#/components/schemas/BorderMilitaryIntelReport' }
            },
            today_public_done: { type: 'boolean', description: '今日是否已公开军报' }
        }
    },
    // 搜集军报结果数据
    BorderMilitaryIntelCollectResult: {
        type: 'object',
        description: '搜集军报结果数据',
        properties: {
            reports: {
                type: 'array',
                description: '新生成的军报列表',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer', description: '军报ID' },
                        index: { type: 'integer', description: '当日序号（1-3）' },
                        type: { type: 'string', description: '军报类型' },
                        type_description: { type: 'string', description: '军报类型中文名' },
                        content: { type: 'string', description: '军报内容' },
                        identified: { type: 'boolean', description: '是否已辨报（新搜集时为 false）' },
                        public_status: { type: 'string', description: '公开状态（新搜集时为 pending）' }
                    }
                }
            }
        }
    },
    // 辨报结果数据
    BorderMilitaryIntelIdentifyResult: {
        type: 'object',
        description: '辨报结果数据',
        properties: {
            report_id: { type: 'integer', description: '军报ID' },
            identified_as: { type: 'string', enum: ['true', 'false'], description: '辨报判定结果（玩家研判的真伪）' },
            actual: { type: 'string', enum: ['true', 'false'], description: '实际真伪（辨报后揭示）' },
            is_correct: { type: 'boolean', description: '辨报是否正确' },
            identified_result: { type: 'string', enum: ['correct', 'wrong'], description: '辨报结果代号' },
            success_rate: { type: 'number', description: '辨报成功率（0-1）' }
        }
    },
    // 公开军报结果数据
    BorderMilitaryIntelPublicResult: {
        type: 'object',
        description: '公开军报结果数据',
        properties: {
            report_id: { type: 'integer', description: '军报ID' },
            is_true: { type: 'boolean', description: '是否为真军报' },
            identified_correct: { type: 'boolean', description: '辨报是否正确' },
            merit_change: { type: 'integer', description: '军功变化（正为奖励，负为惩罚）' },
            support_effect: { type: 'string', enum: ['bonus', 'penalty', 'none'], description: '对当日支援的影响：bonus=加成 / penalty=惩罚 / none=无影响' },
            support_rate: { type: 'number', description: '支援加成/惩罚比例（正为加成，负为惩罚）' }
        }
    },
    // 军功司物品项
    BorderMilitaryShopItem: {
        type: 'object',
        description: '军功司兑换物品项',
        properties: {
            key: { type: 'string', description: '物品 key' },
            name: { type: 'string', description: '物品名称' },
            cost_merit: { type: 'integer', description: '兑换所需军功' },
            description: { type: 'string', description: '物品描述' },
            daily_limit: { type: 'integer', description: '每日限兑数量' },
            requires_rank: { type: 'integer', description: '所需军衔等级' },
            can_exchange: { type: 'boolean', description: '当前是否可兑换（军衔是否满足）' }
        }
    },
    // 军功司兑换列表响应
    BorderMilitaryShopResponse: {
        type: 'object',
        description: '军功司兑换列表响应',
        properties: {
            rank: { $ref: '#/components/schemas/BorderMilitaryRank' },
            items: {
                type: 'array',
                description: '物品列表',
                items: { $ref: '#/components/schemas/BorderMilitaryShopItem' }
            }
        }
    },
    // 军功兑换结果数据
    BorderMilitaryExchangeResult: {
        type: 'object',
        description: '军功兑换结果数据',
        properties: {
            item_key: { type: 'string', description: '物品 key' },
            item_name: { type: 'string', description: '物品名称' },
            quantity: { type: 'integer', description: '兑换数量' },
            cost_merit: { type: 'integer', description: '消耗军功总数' },
            merit_available: { type: 'integer', description: '兑换后剩余可用军功' }
        }
    },
    // 支援历史项
    BorderMilitarySupportLogItem: {
        type: 'object',
        description: '支援历史项',
        properties: {
            id: { type: 'integer', description: '记录ID' },
            support_date: { type: 'string', format: 'date', description: '支援日期' },
            route: { type: 'string', description: '支援路线' },
            route_name: { type: 'string', description: '路线中文名' },
            is_secret_order: { type: 'boolean', description: '是否为密令路线' },
            is_risky_route: { type: 'boolean', description: '是否为险棋路线' },
            is_grain_route: { type: 'boolean', description: '是否为粮道路线' },
            base_merit: { type: 'integer', description: '基础军功' },
            final_merit: { type: 'integer', description: '最终军功' },
            spirit_stones_gained: { type: 'string', description: '获得灵石（BigInt 序列化为字符串）', nullable: true },
            items_dropped: { type: 'array', description: '掉落物品列表', nullable: true, items: { type: 'object' } },
            imprint_triggered: { type: 'boolean', description: '是否触发临战刻印' },
            intel_bonus_rate: { type: 'number', description: '军报加成比例' },
            failed: { type: 'boolean', description: '是否失败' },
            created_at: { type: 'string', format: 'date-time', description: '记录时间' }
        }
    },
    // 支援历史响应
    BorderMilitaryHistoryResponse: {
        type: 'object',
        description: '支援历史响应',
        properties: {
            logs: {
                type: 'array',
                description: '支援历史列表',
                items: { $ref: '#/components/schemas/BorderMilitarySupportLogItem' }
            }
        }
    },
    // 灵兽巡边记录项（active）
    BorderBeastPatrolActiveItem: {
        type: 'object',
        description: '未结算的灵兽巡边记录',
        properties: {
            id: { type: 'integer', description: '巡边记录ID' },
            beast_id: { type: 'integer', description: '灵兽实例ID' },
            route: { type: 'string', enum: ['scout', 'grain_guard', 'camp_raid'], description: '巡边路线' },
            route_name: { type: 'string', description: '路线中文名（斥候/护粮/袭营）' },
            start_time: { type: 'string', format: 'date-time', description: '派出时间' },
            end_time: { type: 'string', format: 'date-time', description: '预计归来时间' },
            can_settle: { type: 'boolean', description: '当前是否可结算（已到达 end_time）' }
        }
    },
    // 灵兽巡边记录项（recent，已结算）
    BorderBeastPatrolRecentItem: {
        type: 'object',
        description: '已结算的灵兽巡边历史项',
        properties: {
            id: { type: 'integer', description: '巡边记录ID' },
            beast_id: { type: 'integer', description: '灵兽实例ID' },
            route: { type: 'string', description: '巡边路线' },
            route_name: { type: 'string', description: '路线中文名' },
            settled_at: { type: 'string', format: 'date-time', description: '结算时间' },
            merit_gained: { type: 'integer', description: '获得军功' },
            spirit_stones_gained: { type: 'string', description: '获得灵石（BigInt 序列化为字符串）', nullable: true },
            beast_exp_gained: { type: 'integer', description: '灵兽经验增加量' },
            failed: { type: 'boolean', description: '是否失败' }
        }
    },
    // 灵兽巡边状态响应
    BorderBeastPatrolStatusResponse: {
        type: 'object',
        description: '灵兽巡边状态响应',
        properties: {
            today_done: { type: 'boolean', description: '今日是否已派出灵兽巡边' },
            active_patrols: {
                type: 'array',
                description: '未结算的巡边列表',
                items: { $ref: '#/components/schemas/BorderBeastPatrolActiveItem' }
            },
            recent_patrols: {
                type: 'array',
                description: '最近 10 条已结算的巡边历史',
                items: { $ref: '#/components/schemas/BorderBeastPatrolRecentItem' }
            }
        }
    },
    // 派出灵兽巡边结果
    BorderBeastPatrolDispatchResult: {
        type: 'object',
        description: '派出灵兽巡边结果',
        properties: {
            patrol_id: { type: 'integer', description: '巡边记录ID' },
            beast_id: { type: 'integer', description: '灵兽实例ID' },
            beast_name: { type: 'string', description: '灵兽名称' },
            route: { type: 'string', description: '巡边路线' },
            route_name: { type: 'string', description: '路线中文名' },
            start_time: { type: 'string', format: 'date-time', description: '派出时间' },
            end_time: { type: 'string', format: 'date-time', description: '预计归来时间' },
            duration_seconds: { type: 'integer', description: '巡边时长（秒）' }
        }
    },
    // 灵兽巡边归来结算结果（成功）
    BorderBeastPatrolReturnResult: {
        type: 'object',
        description: '灵兽巡边归来结算结果（成功）',
        properties: {
            patrol_id: { type: 'integer', description: '巡边记录ID' },
            route: { type: 'string', description: '巡边路线' },
            route_name: { type: 'string', description: '路线中文名' },
            merit_gained: { type: 'integer', description: '获得军功' },
            spirit_stones_gained: { type: 'integer', description: '获得灵石' },
            player_exp_gained: { type: 'integer', description: '玩家修为增加量' },
            beast_exp_gained: { type: 'integer', description: '灵兽经验增加量' },
            items_dropped: { type: 'array', description: '掉落物品列表', items: { type: 'object' } },
            new_rank: { $ref: '#/components/schemas/BorderMilitaryRank' },
            milestone: { type: 'object', description: '里程碑达成情况' }
        }
    },
    // 灵兽巡边归来结算结果（失败）
    BorderBeastPatrolReturnFailure: {
        type: 'object',
        description: '灵兽巡边归来结算结果（失败）',
        properties: {
            patrol_id: { type: 'integer', description: '巡边记录ID' },
            route: { type: 'string', description: '巡边路线' },
            route_name: { type: 'string', description: '路线中文名' },
            failed: { type: 'boolean', description: '是否失败（恒为 true）' },
            spirit_stones_loss: { type: 'integer', description: '损失灵石数量' },
            hp_loss: { type: 'string', description: '损失 HP（BigInt 序列化为字符串）' }
        }
    },
    // 残图匣状态响应
    BorderRemnantMapStatusResponse: {
        type: 'object',
        description: '残图匣状态响应',
        properties: {
            fragments: {
                type: 'object',
                description: '4 类残片持有情况（key 为 A/B/C/D）',
                properties: {
                    A: { type: 'object', properties: { item_key: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' } } },
                    B: { type: 'object', properties: { item_key: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' } } },
                    C: { type: 'object', properties: { item_key: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' } } },
                    D: { type: 'object', properties: { item_key: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' } } }
                }
            },
            complete_maps: { type: 'integer', description: '完整残图数量' },
            combine_cost_spirit_stones: { type: 'integer', description: '拼图所需灵石' },
            can_combine: { type: 'boolean', description: '是否可拼图（4 类残片各≥1 且灵石足够）' },
            can_combine_missing: { type: 'array', description: '缺失残片类型列表（可拼图时为 null）', nullable: true, items: { type: 'string' } },
            can_explore: { type: 'boolean', description: '是否可按图探禁' },
            explore_block_reason: { type: 'string', description: '不可探禁原因（可探禁时为 null）', nullable: true },
            today_explored: { type: 'boolean', description: '今日是否已探禁' }
        }
    },
    // 拼残图结果
    BorderRemnantMapCombineResult: {
        type: 'object',
        description: '拼残图结果',
        properties: {
            complete_maps: { type: 'integer', description: '拼图后完整残图数量' },
            spirit_stones_cost: { type: 'integer', description: '消耗灵石数量' },
            spirit_stones_remaining: { type: 'string', description: '剩余灵石（BigInt 序列化为字符串）' }
        }
    },
    // 按图探禁结果（成功）
    BorderRemnantMapExploreResult: {
        type: 'object',
        description: '按图探禁结果（成功）',
        properties: {
            merit_gained: { type: 'integer', description: '获得军功' },
            spirit_stones_gained: { type: 'integer', description: '获得灵石' },
            exp_gained: { type: 'integer', description: '获得修为' },
            items_dropped: { type: 'array', description: '掉落物品列表', items: { type: 'object' } },
            new_rank: { $ref: '#/components/schemas/BorderMilitaryRank' },
            milestone: { type: 'object', description: '里程碑达成情况' }
        }
    },
    // 按图探禁结果（失败）
    BorderRemnantMapExploreFailure: {
        type: 'object',
        description: '按图探禁结果（失败，触发苍坤旧禁反噬）',
        properties: {
            failed: { type: 'boolean', description: '是否失败（恒为 true）' },
            spirit_stones_loss: { type: 'integer', description: '损失灵石数量' },
            hp_loss: { type: 'string', description: '损失 HP（BigInt 序列化为字符串）' }
        }
    },
    // 临战刻印 active 项
    BorderWarImprintActiveItem: {
        type: 'object',
        description: 'active 临战刻印（未触发且未过期）',
        properties: {
            id: { type: 'integer', description: '刻印记录ID' },
            artifact_id: { type: 'integer', description: '法宝实例ID' },
            artifact_name: { type: 'string', description: '法宝名称' },
            imprint_type: { type: 'string', enum: ['lamp_breaker', 'array_guard', 'scout_stealth'], description: '刻印类型' },
            matched_route: { type: 'string', description: '匹配路线（逗号分隔，如 "scout,raid"）' },
            bonus_rate: { type: 'number', description: '加成比例（如 0.30 表示 +30%）' },
            materials_consumed: { type: 'array', description: '消耗材料列表', items: { type: 'object' } },
            expires_at: { type: 'string', format: 'date-time', description: '过期时间' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' }
        }
    },
    // 临战刻印 recent 项
    BorderWarImprintRecentItem: {
        type: 'object',
        description: '历史临战刻印项',
        properties: {
            id: { type: 'integer', description: '刻印记录ID' },
            artifact_id: { type: 'integer', description: '法宝实例ID' },
            artifact_name: { type: 'string', description: '法宝名称' },
            imprint_type: { type: 'string', description: '刻印类型' },
            matched_route: { type: 'string', description: '匹配路线' },
            bonus_rate: { type: 'number', description: '加成比例' },
            triggered: { type: 'boolean', description: '是否已触发' },
            triggered_at: { type: 'string', format: 'date-time', description: '触发时间', nullable: true },
            trigger_route: { type: 'string', description: '触发时的支援路线', nullable: true },
            expires_at: { type: 'string', format: 'date-time', description: '过期时间' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' }
        }
    },
    // 临战刻印可用类型项
    BorderWarImprintAvailableType: {
        type: 'object',
        description: '临战刻印可用类型',
        properties: {
            type: { type: 'string', enum: ['lamp_breaker', 'array_guard', 'scout_stealth'], description: '刻印类型 key' },
            name: { type: 'string', description: '刻印中文名（破灯刻印/护阵刻印/潜行刻印）' },
            description: { type: 'string', description: '刻印描述' },
            matched_route: { type: 'string', description: '匹配路线（逗号分隔）' },
            materials: { type: 'array', description: '所需材料列表', items: { type: 'object' } },
            bonus_rate: { type: 'number', description: '加成比例' }
        }
    },
    // 临战刻印状态响应
    BorderWarImprintStatusResponse: {
        type: 'object',
        description: '临战刻印状态响应',
        properties: {
            today_done: { type: 'boolean', description: '今日是否已施加临战刻印' },
            max_active_imprints: { type: 'integer', description: 'active 刻印数量上限（默认 1）' },
            active_count: { type: 'integer', description: '当前 active 刻印数量' },
            active_imprints: {
                type: 'array',
                description: 'active 刻印列表',
                items: { $ref: '#/components/schemas/BorderWarImprintActiveItem' }
            },
            recent_imprints: {
                type: 'array',
                description: '最近 10 条历史刻印',
                items: { $ref: '#/components/schemas/BorderWarImprintRecentItem' }
            },
            available_types: {
                type: 'array',
                description: '可用刻印类型',
                items: { $ref: '#/components/schemas/BorderWarImprintAvailableType' }
            }
        }
    },
    // 施加临战刻印结果
    BorderWarImprintApplyResult: {
        type: 'object',
        description: '施加临战刻印结果',
        properties: {
            imprint_id: { type: 'integer', description: '刻印记录ID' },
            artifact_id: { type: 'integer', description: '法宝实例ID' },
            artifact_name: { type: 'string', description: '法宝名称' },
            imprint_type: { type: 'string', description: '刻印类型' },
            imprint_name: { type: 'string', description: '刻印中文名' },
            matched_route: { type: 'string', description: '匹配路线（逗号分隔）' },
            bonus_rate: { type: 'number', description: '加成比例' },
            materials_consumed: { type: 'array', description: '消耗材料列表', items: { type: 'object' } },
            expires_at: { type: 'string', format: 'date-time', description: '过期时间（24 小时后）' }
        }
    }
};

// ==================== 主流程 ====================
console.log('[openapi_patch_border_military] 开始更新 docs/openapi.json');

// 1. 读取原文件
if (!fs.existsSync(OPENAPI_PATH)) {
    console.error('[openapi_patch_border_military] 错误：docs/openapi.json 不存在');
    process.exit(1);
}
const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
const spec = JSON.parse(rawContent);
console.log('[openapi_patch_border_military] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

// 2. 追加 tags（幂等：跳过已存在的）
if (!Array.isArray(spec.tags)) {
    spec.tags = [];
}
let addedTags = 0;
for (const tag of NEW_TAGS) {
    const exists = spec.tags.find(t => t.name === tag.name);
    if (!exists) {
        spec.tags.push(tag);
        addedTags++;
        console.log(`[openapi_patch_border_military] 已追加 tag: ${tag.name}`);
    } else {
        // 已存在则更新描述（保持幂等，覆盖式更新）
        exists.description = tag.description;
        console.log(`[openapi_patch_border_military] tag 已存在，已更新描述: ${tag.name}`);
    }
}

// 3. 追加 paths（幂等：相同 path+method 覆盖更新，便于重新生成）
if (!spec.paths || typeof spec.paths !== 'object') {
    spec.paths = {};
}
let addedPaths = 0;
let overwrittenPaths = 0;
for (const [pathKey, methods] of Object.entries(NEW_PATHS)) {
    if (spec.paths[pathKey]) {
        // 路径已存在，覆盖每个方法（便于重新生成时同步最新定义）
        for (const [method, definition] of Object.entries(methods)) {
            if (spec.paths[pathKey][method]) {
                spec.paths[pathKey][method] = definition;
                overwrittenPaths++;
                console.log(`[openapi_patch_border_military] 已覆盖方法: ${method.toUpperCase()} ${pathKey}`);
            } else {
                spec.paths[pathKey][method] = definition;
                addedPaths++;
                console.log(`[openapi_patch_border_military] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
            }
        }
    } else {
        // 路径不存在，整体追加
        spec.paths[pathKey] = methods;
        addedPaths += Object.keys(methods).length;
        console.log(`[openapi_patch_border_military] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
    }
}

// 4. 追加 schemas（幂等：跳过已存在的，避免覆盖其他模块的同名 schema）
if (!spec.components) {
    spec.components = {};
}
if (!spec.components.schemas || typeof spec.components.schemas !== 'object') {
    spec.components.schemas = {};
}
let addedSchemas = 0;
for (const [schemaName, schemaDef] of Object.entries(NEW_SCHEMAS)) {
    if (!spec.components.schemas[schemaName]) {
        spec.components.schemas[schemaName] = schemaDef;
        addedSchemas++;
        console.log(`[openapi_patch_border_military] 已追加 schema: ${schemaName}`);
    } else {
        console.log(`[openapi_patch_border_military] schema 已存在，跳过: ${schemaName}`);
    }
}

// 5. 写回文件（4 空格缩进，与现有 openapi.json 风格保持一致，保留中文可读性）
const output = JSON.stringify(spec, null, 4);
fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

console.log('\n[openapi_patch_border_military] 更新完成！');
console.log(`  - 新增 tags: ${addedTags} 个`);
console.log(`  - 新增 paths: ${addedPaths} 个方法`);
console.log(`  - 覆盖（已存在）: ${overwrittenPaths} 个方法`);
console.log(`  - 新增 schemas: ${addedSchemas} 个`);
console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components.schemas).length}`);
