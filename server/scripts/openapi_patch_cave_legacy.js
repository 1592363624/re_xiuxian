/**
 * OpenAPI 文档补丁脚本：坐化遗府系统（批次5 异步多人 PvP/协作玩法）
 *
 * 作用：向 docs/openapi.json 注入坐化遗府系统的 7 个接口定义：
 *   路由前缀 /api/cave-legacy，对应 server/routes/cave_legacy.js
 *     玩家端（auth 鉴权）：
 *       1. GET  /api/cave-legacy/active         - 查看当前开启的遗府
 *       2. POST /api/cave-legacy/spin           - 转动分宝（每期每人一次）
 *       3. GET  /api/cave-legacy/history        - 查询分宝记录
 *     管理员端（auth + adminCheck 双层鉴权）：
 *       4. POST /api/cave-legacy/admin/preview  - 预览遗府（查询可分配物品 + 合格玩家估算）
 *       5. POST /api/cave-legacy/admin/open     - 开启遗府活动
 *       6. POST /api/cave-legacy/admin/close    - 手动关闭遗府
 *       7. GET  /api/cave-legacy/admin/status   - 查看后台状态
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（坐化遗府系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则覆盖，便于重新生成）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_cave_legacy.js
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
        name: '坐化遗府系统',
        description: '批次5 异步多人 PvP/协作玩法 - 退坑/死亡玩家资产由管理员开启遗府活动，合格玩家可参与分宝（每期每人一次，加权随机分配）'
    }
];

// ==================== 通用响应构造工具 ====================
/**
 * 构造通用响应对象（200/400/401/403/500）
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
                            error_code: { type: 'string', description: '业务失败时的错误码（success=false 时存在，如 BUSINESS_LOGIC_ERROR / NOT_FOUND / VALIDATION_ERROR）' }
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
        403: {
            description: '权限不足（需要管理员权限，仅管理员接口返回）',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 403 },
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
                            error_code: { type: 'string', example: 'INTERNAL_ERROR' },
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
    // ===== 玩家：转动分宝请求 =====
    CaveLegacySpinRequest: {
        type: 'object',
        required: ['legacy_id'],
        properties: {
            legacy_id: {
                type: 'integer',
                description: '遗府活动ID',
                example: 1
            }
        }
    },

    // ===== 管理员：预览遗府请求 =====
    CaveLegacyPreviewRequest: {
        type: 'object',
        required: ['owner_player_id'],
        properties: {
            owner_player_id: {
                type: 'integer',
                description: '坐化玩家ID（即将开放遗府的物主）',
                example: 2
            }
        }
    },

    // ===== 管理员：开启遗府请求 =====
    CaveLegacyOpenRequest: {
        type: 'object',
        required: ['owner_player_id'],
        properties: {
            owner_player_id: {
                type: 'integer',
                description: '坐化玩家ID',
                example: 2
            },
            duration_hours: {
                type: 'integer',
                description: '开放时长（小时），默认 24，最大 168（7 天）',
                minimum: 1,
                maximum: 168,
                default: 24,
                example: 24
            }
        }
    },

    // ===== 管理员：关闭遗府请求 =====
    CaveLegacyCloseRequest: {
        type: 'object',
        required: ['legacy_id'],
        properties: {
            legacy_id: {
                type: 'integer',
                description: '遗府活动ID',
                example: 1
            }
        }
    },

    // ===== 预览响应数据 =====
    CaveLegacyPreviewData: {
        type: 'object',
        description: '预览遗府响应数据',
        properties: {
            owner: {
                type: 'object',
                description: '坐化玩家信息',
                properties: {
                    id: { type: 'integer' },
                    nickname: { type: 'string' },
                    realm: { type: 'string' },
                    is_dead: { type: 'boolean' },
                    last_online: { type: 'string', format: 'date-time', nullable: true }
                }
            },
            items: {
                type: 'array',
                description: '可分配物品列表（已应用 item_filter 规则筛选）',
                items: {
                    type: 'object',
                    properties: {
                        item_key: { type: 'string' },
                        name: { type: 'string' },
                        type: { type: 'string', description: '物品类型（material/consumable）' },
                        subtype: { type: 'string' },
                        quality: { type: 'string', description: '品质（common/uncommon/rare/epic）' },
                        quantity: { type: 'integer', description: '数量' }
                    }
                }
            },
            items_count: { type: 'integer', description: '可分配物品种数' },
            items_total_quantity: { type: 'integer', description: '可分配物品总件数' },
            eligible_players_estimate: { type: 'integer', description: '合格玩家估算数量' }
        }
    },

    // ===== 开启遗府响应数据 =====
    CaveLegacyOpenData: {
        type: 'object',
        description: '遗府开启成功响应数据',
        properties: {
            legacy_id: { type: 'integer', description: '遗府活动ID', example: 1 },
            status: { type: 'string', enum: ['open'], description: '状态：open=开放中' },
            owner_player_id: { type: 'integer' },
            owner_nickname: { type: 'string' },
            started_at: { type: 'string', format: 'date-time' },
            ends_at: { type: 'string', format: 'date-time' },
            duration_hours: { type: 'integer' },
            items_count: { type: 'integer', description: '可分配物品种数' },
            items_total_quantity: { type: 'integer', description: '可分配物品总件数' }
        }
    },

    // ===== 当前遗府列表响应数据 =====
    CaveLegacyActiveData: {
        type: 'object',
        description: '当前开启遗府查询响应数据',
        properties: {
            active_legacies: {
                type: 'array',
                description: '当前开启的遗府列表',
                items: {
                    type: 'object',
                    properties: {
                        legacy_id: { type: 'integer' },
                        owner_player_id: { type: 'integer' },
                        owner_nickname: { type: 'string' },
                        status: { type: 'string', enum: ['open'] },
                        started_at: { type: 'string', format: 'date-time' },
                        ends_at: { type: 'string', format: 'date-time' },
                        items_count: { type: 'integer' },
                        items_remaining_quantity: { type: 'integer', description: '剩余可分配总件数' },
                        participants_count: { type: 'integer' },
                        quality_summary: {
                            type: 'array',
                            description: '品质摘要（按品质分组统计剩余件数）',
                            items: {
                                type: 'object',
                                properties: {
                                    quality: { type: 'string' },
                                    remaining_quantity: { type: 'integer' }
                                }
                            }
                        },
                        player_status: {
                            type: 'object',
                            description: '当前玩家在此遗府的参与状态',
                            properties: {
                                has_participated: { type: 'boolean', description: '是否已参与（创建过 participant 记录）' },
                                has_spun: { type: 'boolean', description: '是否已转动分宝' },
                                eligible: { type: 'boolean', description: '是否合格' },
                                eligibility_status: { type: 'string', description: '资格状态描述' },
                                ineligibility_reason: { type: 'string', nullable: true, description: '不合格原因（合格时为 null）' }
                            }
                        }
                    }
                }
            },
            total: { type: 'integer', description: '当前开启遗府总数' }
        }
    },

    // ===== 转动分宝响应数据 =====
    CaveLegacySpinData: {
        type: 'object',
        description: '分宝成功响应数据',
        properties: {
            legacy_id: { type: 'integer' },
            player_id: { type: 'integer' },
            distributed_items: {
                type: 'array',
                description: '本次分得的物品列表',
                items: {
                    type: 'object',
                    properties: {
                        item_key: { type: 'string' },
                        item_name: { type: 'string' },
                        quantity: { type: 'integer' }
                    }
                }
            },
            total_item_types: { type: 'integer', description: '本次分得物品种数' },
            total_quantity: { type: 'integer', description: '本次分得物品总件数' },
            lucky_factor: { type: 'number', format: 'float', description: '幸运因子（0.8~1.2）' },
            weight: { type: 'number', description: '玩家权重（基于修为和在线时长）' }
        }
    },

    // ===== 分宝历史响应数据 =====
    CaveLegacyHistoryData: {
        type: 'object',
        description: '分宝历史响应数据',
        properties: {
            history: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        legacy_id: { type: 'integer' },
                        owner_player_id: { type: 'integer' },
                        owner_nickname: { type: 'string' },
                        status: { type: 'string', description: '遗府状态（open/closed/expired）' },
                        started_at: { type: 'string', format: 'date-time' },
                        closed_at: { type: 'string', format: 'date-time', nullable: true },
                        participant: {
                            type: 'object',
                            properties: {
                                eligible: { type: 'boolean' },
                                has_spun: { type: 'boolean' },
                                spun_at: { type: 'string', format: 'date-time', nullable: true },
                                total_item_types: { type: 'integer' },
                                total_quantity: { type: 'integer' }
                            }
                        },
                        distributed_items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    item_key: { type: 'string' },
                                    item_name: { type: 'string' },
                                    quantity: { type: 'integer' },
                                    distributed_at: { type: 'string', format: 'date-time' }
                                }
                            }
                        }
                    }
                }
            },
            total: { type: 'integer' },
            currentPage: { type: 'integer' },
            totalPages: { type: 'integer' }
        }
    },

    // ===== 关闭遗府响应数据 =====
    CaveLegacyCloseData: {
        type: 'object',
        description: '遗府关闭响应数据（含未分配物品结算摘要）',
        properties: {
            legacy_id: { type: 'integer' },
            status: { type: 'string', enum: ['closed'] },
            closed_at: { type: 'string', format: 'date-time' },
            close_reason: { type: 'string', description: '关闭原因（manual/expired）' },
            summary: {
                type: 'object',
                description: '未分配物品结算摘要',
                properties: {
                    unclaimed_items_count: { type: 'integer', description: '未分配物品种数' },
                    unclaimed_total_quantity: { type: 'integer', description: '未分配物品总件数' },
                    action: { type: 'string', enum: ['destroy', 'return_to_owner'], description: '处理方式：destroy=销毁 / return_to_owner=退回原主' },
                    returned_to_owner: { type: 'integer', description: '退回原主的件数' },
                    destroyed: { type: 'integer', description: '销毁的件数' }
                }
            }
        }
    },

    // ===== 后台状态响应数据 =====
    CaveLegacyAdminStatusData: {
        type: 'object',
        description: '管理员后台状态响应数据',
        properties: {
            legacies: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        owner_player_id: { type: 'integer' },
                        owner_nickname: { type: 'string' },
                        status: { type: 'string', enum: ['preview', 'open', 'closed', 'expired'] },
                        duration_hours: { type: 'integer' },
                        started_at: { type: 'string', format: 'date-time' },
                        ends_at: { type: 'string', format: 'date-time' },
                        closed_at: { type: 'string', format: 'date-time', nullable: true },
                        close_reason: { type: 'string', nullable: true },
                        items_count: { type: 'integer' },
                        items_total_quantity: { type: 'integer' },
                        participants_count: { type: 'integer' },
                        settled: { type: 'boolean' }
                    }
                }
            },
            total: { type: 'integer' },
            currentPage: { type: 'integer' },
            totalPages: { type: 'integer' }
        }
    }
};

// ==================== 新增 Path 定义 ====================
const NEW_PATHS = {
    // ==================== 玩家端接口 ====================

    // 1. 查看当前开启的遗府
    '/api/cave-legacy/active': {
        get: {
            tags: ['坐化遗府系统'],
            summary: '查看当前开启的遗府（玩家端）',
            description: [
                '查询当前所有 status=open 的遗府活动列表，含玩家本人在每个遗府的参与状态、剩余物品摘要、品质摘要。',
                '',
                '前端用途：',
                '  - 进入"坐化遗府"主界面时调用',
                '  - 显示当前可参与的遗府列表，含是否合格、是否已转动等信息',
                '',
                '前端展示建议：',
                '  - 列表为空时显示"暂无开启的遗府活动"',
                '  - 不合格时显示原因（如"累计在线时长不足"）',
                '  - 已转动时禁用分宝按钮并显示"已转动"'
            ].join('\n'),
            security: [BEARER_AUTH],
            responses: securityResponses('返回当前开启遗府列表')
        }
    },

    // 2. 转动分宝
    '/api/cave-legacy/spin': {
        post: {
            tags: ['坐化遗府系统'],
            summary: '转动分宝（玩家端，每期每人一次）',
            description: [
                '玩家参与指定遗府的分宝活动，按加权随机算法分配物品到玩家储物袋。',
                '',
                '业务规则：',
                '  1. 每期遗府每人只能转动一次',
                '  2. 必须通过资格校验（活跃度/在线时长/指令数/修为/首次记录）',
                '  3. 同主魂（IP 相同）唯一领取，防止小号重复领取',
                '  4. 不可分宝自己的遗府',
                '  5. 储物袋满时跳过该物品分配（恢复 remaining_quantity，继续分配其他物品）',
                '  6. 分配算法：ratio = min(0.3, maxItemTypes / items.length)，每物品分配 ceil(remaining * ratio * luckyFactor)',
                '  7. 权重 = log10(exp+10)*coeff_exp + log10(online_min+1)*coeff_online，乘以幸运因子',
                '',
                '事务保证：分宝使用事务 + 行级锁（LOCK.UPDATE）',
                'WebSocket 推送：分宝成功后推送通知（事务提交后）'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/CaveLegacySpinRequest' }
                    }
                }
            },
            responses: securityResponses('返回本次分得的物品列表')
        }
    },

    // 3. 查询分宝历史
    '/api/cave-legacy/history': {
        get: {
            tags: ['坐化遗府系统'],
            summary: '查询分宝历史（玩家端）',
            description: '分页查询玩家本人参与过的遗府历史记录，按 created_at 倒序。',
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
            responses: securityResponses('返回分页分宝历史')
        }
    },

    // ==================== 管理员端接口 ====================

    // 4. 预览遗府
    '/api/cave-legacy/admin/preview': {
        post: {
            tags: ['坐化遗府系统'],
            summary: '预览遗府（管理员端）',
            description: [
                '查询指定坐化玩家的可分配资产和合格玩家估算，不实际开启遗府。',
                '',
                '用途：管理员决定是否开启遗府前的预检查。',
                '',
                '物品筛选规则（item_filter）：',
                '  - include_types：物品类型白名单（material/consumable）',
                '  - exclude_subtypes：子类型黑名单（quest/badge）',
                '  - include_qualities：品质白名单（common/uncommon/rare/epic）',
                '  - skip_equipped：排除已装备物品'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/CaveLegacyPreviewRequest' }
                    }
                }
            },
            responses: securityResponses('返回可分配物品列表和合格玩家估算')
        }
    },

    // 5. 开启遗府
    '/api/cave-legacy/admin/open': {
        post: {
            tags: ['坐化遗府系统'],
            summary: '开启遗府活动（管理员端）',
            description: [
                '为指定坐化玩家开启遗府活动，将储物袋中符合条件的物品转移到遗府可分配物品表。',
                '',
                '业务流程：',
                '  1. 校验管理员权限',
                '  2. 校验坐化玩家存在性',
                '  3. 事务内：创建 CaveLegacy 记录 + 写入 CaveLegacyItem + 从储物袋扣除物品',
                '  4. 事务提交后推送 WebSocket 全服通知"遗府开启"',
                '',
                '限制：',
                '  - 同时开启的遗府数量不超过 max_active_legacies（默认 3）',
                '  - 坐化玩家不能有进行中的遗府',
                '  - duration_hours 默认 24，最大 168'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/CaveLegacyOpenRequest' }
                    }
                }
            },
            responses: securityResponses('返回遗府活动ID和基本信息')
        }
    },

    // 6. 手动关闭遗府
    '/api/cave-legacy/admin/close': {
        post: {
            tags: ['坐化遗府系统'],
            summary: '手动关闭遗府（管理员端）',
            description: [
                '管理员手动关闭指定遗府，触发未分配物品结算。',
                '',
                '结算规则（settlement.unclaimed_items）：',
                '  - destroy：销毁所有未分配物品',
                '  - return_to_owner：退回原主储物袋（原主已死或储物袋满则销毁）',
                '',
                '事务保证：关闭使用事务 + 行级锁',
                'WebSocket 推送：关闭后推送全服通知"遗府关闭"'
            ].join('\n'),
            security: [BEARER_AUTH],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/CaveLegacyCloseRequest' }
                    }
                }
            },
            responses: securityResponses('返回关闭结果和结算摘要')
        }
    },

    // 7. 后台状态查询
    '/api/cave-legacy/admin/status': {
        get: {
            tags: ['坐化遗府系统'],
            summary: '查看后台状态（管理员端）',
            description: '分页查询所有遗府列表（含已关闭），支持按状态过滤。',
            security: [BEARER_AUTH],
            parameters: [
                {
                    name: 'status',
                    in: 'query',
                    required: false,
                    schema: {
                        type: 'string',
                        enum: ['all', 'preview', 'open', 'closed', 'expired'],
                        default: 'all'
                    },
                    description: '状态过滤（默认 all：全部）'
                },
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
                    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    description: '每页条数（默认 20，最大 100）'
                }
            ],
            responses: securityResponses('返回分页遗府列表')
        }
    }
};

// ==================== 主函数 ====================
/**
 * 主函数：读取 openapi.json -> 注入 tag + path + schema -> 写回
 * 幂等性：相同 path+method 会被覆盖更新；schema 同名会被覆盖
 */
function main() {
    console.log('[OpenAPI Patch] 开始注入坐化遗府系统接口...');

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
    console.log('[OpenAPI Patch] 坐化遗府系统接口注入完成');
}

main();
