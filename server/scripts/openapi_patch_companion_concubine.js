/**
 * OpenAPI 文档补丁脚本：批次3 道侣/双修/侍妾/心契/心劫/远航系统
 *
 * 作用：向 docs/openapi.json 注入批次3 道侣/侍妾系统的 30 个接口定义：
 *   玩家接口 24 个：
 *     - 道侣系统 /api/companion/*        (11 个)
 *     - 侍妾系统 /api/concubine/*        (13 个)
 *   GM 接口 6 个（/api/admin/companion-concubine/*，需管理员权限）：
 *     - dao-companion/break              强制解除道侣
 *     - dao-companion/set-heart-contract 调整心契等级
 *     - heart-tribulation/trigger       触发心劫
 *     - concubine/grant                 直接发放侍妾
 *     - concubine/set-attr              调整侍妾属性
 *     - voyage/finish                   立即完成远航
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 2 个新 tag（道侣侍妾、道侣侍妾GM管理）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则跳过，保证幂等）
 *   - 在 components.schemas 中追加 6 个新响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_companion_concubine.js
 * 幂等性：可重复执行，不会产生重复定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 目标文件路径（项目根目录下的 docs/openapi.json）
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// ==================== 新增 Tag 定义 ====================
// 2 个新 tag：玩家接口与 GM 管理接口分别归类
const NEW_TAGS = [
    {
        name: '道侣侍妾',
        description: '批次3新增：道侣/双修/侍妾/心契/心劫/远航系统玩家接口'
    },
    {
        name: '道侣侍妾GM管理',
        description: '批次3新增：道侣/侍妾系统GM后台管理接口'
    }
];

// ==================== 安全响应 Schema 片段 ====================
/**
 * 构造通用响应对象（200/400/401/403/500）
 * @param {string} description - 200 响应的描述
 * @param {boolean} [include403=true] - 是否包含 403 权限不足响应（GM 接口必含）
 * @returns {object} OpenAPI responses 对象
 */
const securityResponses = (description, include403 = true) => {
    const responses = {
        200: {
            description: description,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            success: { type: 'boolean', example: true },
                            message: { type: 'string' },
                            data: { type: 'object', nullable: true }
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
                            error_code: { type: 'string' },
                            message: { type: 'string' }
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
    // GM 接口需要 403 权限不足响应
    if (include403) {
        responses[403] = {
            description: '权限不足（需要管理员权限）',
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
        };
    }
    return responses;
};

// 通用的 security 要求（需要 bearer token）
const securityRequirement = [{ bearerAuth: [] }];

// GM 接口的通用响应（含 403）
const gmResponses = (description) => securityResponses(description, true);
// 玩家接口的通用响应（不含 403）
const playerResponses = (description) => securityResponses(description, false);

// ==================== 30 个新接口定义 ====================
const NEW_PATHS = {
    // ============== 玩家接口：道侣系统（11 个，与 server/routes/companion.js 实际路由对齐） ==============

    // 1. 道侣面板（只读）
    '/api/companion/profile': {
        get: {
            summary: '道侣面板',
            description: '查看道侣关系状态、心契等级、双修次数、誓言、心劫。该接口为只读操作。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('道侣面板数据（含关系状态、心契等级、双修统计、誓言列表、心劫状态）')
        }
    },
    // 2. 寻找道侣（发起邀请）
    '/api/companion/seek': {
        post: {
            summary: '寻找道侣',
            description: '向目标玩家发起道侣邀请。若对方已有道侣或自身已有道侣则拒绝。请求体 target_player_id 为目标玩家ID。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_player_id'],
                            properties: {
                                target_player_id: { type: 'integer', description: '目标玩家ID', example: 1001 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('邀请发送结果（邀请记录ID、目标玩家信息）')
        }
    },
    // 3. 同意结侣
    '/api/companion/accept': {
        post: {
            summary: '同意结侣',
            description: '同意他人的道侣邀请。companion_id 为收到的邀请记录ID，结侣后双方进入道侣关系，触发心契等级初始化。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['companion_id'],
                            properties: {
                                companion_id: { type: 'integer', description: '道侣邀请记录ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('结侣结果（道侣关系信息、初始心契等级）')
        }
    },
    // 4. 解除道侣
    '/api/companion/break': {
        post: {
            summary: '解除道侣',
            description: '解除道侣关系。mode=agreement 协议解除（双方无惩罚，心契等级减半）；mode=vow_break 毁誓解除（单方解除，毁誓方承受心劫惩罚，对方心契等级清零）。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['mode'],
                            properties: {
                                mode: {
                                    type: 'string',
                                    enum: ['agreement', 'vow_break'],
                                    description: '解除方式：agreement(协议解除) / vow_break(毁誓解除)',
                                    example: 'agreement'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('解除结果（心契变化、是否触发心劫）')
        }
    },
    // 5. 闭关双修
    '/api/companion/dual-cultivate': {
        post: {
            summary: '闭关双修',
            description: '与道侣闭关双修，自身修为 +5%，日上限 3 次。无请求体参数。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('双修结果（修为变化、今日剩余次数、心契经验增量）')
        }
    },
    // 6. 温养
    '/api/companion/warm-nourish': {
        post: {
            summary: '温养',
            description: '与道侣温养，双方各 +3% 修为，日上限 2 次。无请求体参数。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('温养结果（双方修为变化、今日剩余次数）')
        }
    },
    // 7. 采补
    '/api/companion/pluck-supplement': {
        post: {
            summary: '采补',
            description: '对道侣采补，主方 +10% 修为，副方 -3% 修为，日上限 1 次。可能影响心契等级与忠诚度。无请求体参数。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('采补结果（双方修为变化、心契变化）')
        }
    },
    // 8. 立誓
    '/api/companion/vow': {
        post: {
            summary: '立誓',
            description: '与道侣立誓，30 天有效期内获得对应增益。vow_type 支持：protect(护道-战斗增益)、secret(守秘-隐匿增益)、cultivate(共修-修炼增益)。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['vow_type'],
                            properties: {
                                vow_type: {
                                    type: 'string',
                                    enum: ['protect', 'secret', 'cultivate'],
                                    description: '誓言类型：protect(护道) / secret(守秘) / cultivate(共修)',
                                    example: 'protect'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('立誓结果（誓言ID、有效期、增益效果）')
        }
    },
    // 9. 心契面板（只读）
    '/api/companion/heart-contract': {
        get: {
            summary: '心契面板',
            description: '查看心契等级、经验、下一级进度、解锁特权。该接口为只读操作。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('心契面板数据（等级、经验、下一级进度、特权列表）')
        }
    },
    // 10. 获取待处理心劫事件（只读）
    '/api/companion/heart-tribulation': {
        get: {
            summary: '获取待处理心劫事件',
            description: '获取当前玩家待处理的心劫事件列表。心劫由毁誓或心契等级差距触发，必须在限定时间内抉择。该接口为只读操作。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('心劫事件列表（事件ID、类型、描述、选项、截止时间）')
        }
    },
    // 11. 心劫抉择
    '/api/companion/heart-tribulation/choose': {
        post: {
            summary: '心劫抉择',
            description: '对待处理的心劫事件做出抉择。option 支持：steady(稳-保守应对)、ruthless(狠-果断处置)、deceive(骗-虚与委蛇)。不同选项对应不同的奖惩结果。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['event_id', 'option'],
                            properties: {
                                event_id: { type: 'integer', description: '心劫事件ID', example: 1 },
                                option: {
                                    type: 'string',
                                    enum: ['steady', 'ruthless', 'deceive'],
                                    description: '抉择选项：steady(稳) / ruthless(狠) / deceive(骗)',
                                    example: 'steady'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('抉择结果（奖惩详情、心契变化、是否引发后续事件）')
        }
    },

    // ============== 玩家接口：侍妾系统（13 个，与 server/routes/concubine.js 实际路由对齐） ==============

    // 12. 侍妾列表（只读）
    '/api/concubine/list': {
        get: {
            summary: '侍妾列表',
            description: '查询玩家所有侍妾及状态：亲密度、魅力、忠诚度、修为、境界、安置位置、当前状态（空闲/远航/护法）。该接口为只读操作。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('侍妾列表数据')
        }
    },
    // 13. 红尘寻缘
    '/api/concubine/seek-fate': {
        post: {
            summary: '红尘寻缘',
            description: '触发红尘寻缘事件，每日 1 次免费，额外 3 次消耗灵石。可能获得新侍妾或道具。无请求体参数。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('寻缘结果（是否获得侍妾、侍妾信息、道具奖励）')
        }
    },
    // 14. 每日问安
    '/api/concubine/ask-after': {
        post: {
            summary: '每日问安',
            description: '向侍妾问安，亲密度 +2、魅力 +1、忠诚度 +1，每日每位侍妾限 1 次。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('问安结果（亲密度、魅力、忠诚度变化）')
        }
    },
    // 15. 灵力反哺
    '/api/concubine/backfeed': {
        post: {
            summary: '灵力反哺',
            description: '消耗玩家修为 500，反哺给侍妾修为 +1000。每日每位侍妾上限受配置约束。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('反哺结果（玩家修为消耗、侍妾修为增量）')
        }
    },
    // 16. 赠予物品
    '/api/concubine/gift': {
        post: {
            summary: '赠予物品',
            description: '赠予侍妾物品，按物品价值提升亲密度/魅力。count 范围 1-99。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id', 'item_key', 'count'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 },
                                item_key: { type: 'string', description: '物品key（储物袋物品标识）', example: 'spirit_stone' },
                                count: { type: 'integer', minimum: 1, maximum: 99, description: '赠予数量（1-99）', example: 10 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('赠予结果（亲密度、魅力变化、物品消耗）')
        }
    },
    // 17. 安置侍妾
    '/api/concubine/place': {
        post: {
            summary: '安置侍妾',
            description: '将侍妾安置至指定洞府位置，安置后可触发洞府增益。location 长度 ≤ 50 字符。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id', 'location'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 },
                                location: { type: 'string', maxLength: 50, description: '安置位置（洞府内具体房间/区域）', example: '主院东侧厢房' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('安置结果（安置位置、激活的增益）')
        }
    },
    // 18. 召回侍妾
    '/api/concubine/recall': {
        post: {
            summary: '召回侍妾',
            description: '从洞府召回侍妾，取消其安置状态及对应增益。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('召回结果（旧位置、取消的增益）')
        }
    },
    // 19. 遣散侍妾
    '/api/concubine/dismiss': {
        post: {
            summary: '遣散侍妾',
            description: '解除侍妾关系，遣散后该侍妾永久消失，亲密度等数据清空。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('遣散结果（是否成功、可能的资源返还）')
        }
    },
    // 20. 侍妾远航
    '/api/concubine/voyage/start': {
        post: {
            summary: '侍妾远航',
            description: '派遣侍妾远航，根据 mode 选择风险等级。safe=稳妥（低风险低收益）、balanced=均衡、risky=冒险（高风险高收益）、moon_palace=月殿寻痕（特殊事件）。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id', 'mode'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 },
                                mode: {
                                    type: 'string',
                                    enum: ['safe', 'balanced', 'risky', 'moon_palace'],
                                    description: '远航模式：safe(稳妥) / balanced(均衡) / risky(冒险) / moon_palace(月殿寻痕)',
                                    example: 'balanced'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('远航启动结果（voyage_id、预计归来时间）')
        }
    },
    // 21. 远航状态（只读）
    '/api/concubine/voyage/status': {
        get: {
            summary: '远航状态',
            description: '查询玩家所有侍妾远航记录及状态（进行中/可领取/已超时）。该接口为只读操作。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            responses: playerResponses('远航状态列表（voyage_id、侍妾信息、模式、状态、归来时间）')
        }
    },
    // 22. 远航归来
    '/api/concubine/voyage/return': {
        post: {
            summary: '远航归来',
            description: '领取远航奖励，必须在归来后 24 小时内领取，超时奖励部分丢失。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['voyage_id'],
                            properties: {
                                voyage_id: { type: 'integer', description: '远航记录ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('归来结果（获得的物品/资源、侍妾状态变化）')
        }
    },
    // 23. 请侍妾护法
    '/api/concubine/protect': {
        post: {
            summary: '请侍妾护法',
            description: '请侍妾护法，闭关时减少被打断概率 30%。每位侍妾护法有冷却时间。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('护法结果（护法开始时间、冷却结束时间）')
        }
    },
    // 24. 觉醒婉影
    '/api/concubine/awaken': {
        post: {
            summary: '觉醒婉影',
            description: '特定侍妾觉醒为高阶形态（婉影），觉醒后属性大幅提升、解锁新交互。需满足亲密度/魅力/忠诚度阈值。',
            tags: ['道侣侍妾'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('觉醒结果（新形态属性、解锁特权）')
        }
    },

    // ============== GM 接口：道侣/侍妾系统管理（6 个） ==============

    // 25. 强制解除道侣
    '/api/admin/companion-concubine/dao-companion/break': {
        post: {
            summary: 'GM 强制解除道侣',
            description: 'GM 强制解除指定玩家的道侣关系，不触发心劫惩罚。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('解除结果（道侣关系信息）')
        }
    },
    // 26. 调整心契等级
    '/api/admin/companion-concubine/dao-companion/set-heart-contract': {
        post: {
            summary: 'GM 调整心契等级',
            description: 'GM 调整指定玩家心契等级（0-5）。用于测试或补偿。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'level'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 },
                                level: { type: 'integer', minimum: 0, maximum: 5, description: '心契目标等级（0-5）', example: 3 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（新心契等级、特权解锁状态）')
        }
    },
    // 27. 触发心劫
    '/api/admin/companion-concubine/heart-tribulation/trigger': {
        post: {
            summary: 'GM 触发心劫',
            description: 'GM 强制触发指定玩家的心劫事件。用于测试或剧情推进。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('触发结果（生成的心劫事件ID、类型）')
        }
    },
    // 28. 直接发放侍妾
    '/api/admin/companion-concubine/concubine/grant': {
        post: {
            summary: 'GM 直接发放侍妾',
            description: 'GM 向指定玩家直接发放侍妾，绕过红尘寻缘流程。concubine_key 对应侍妾配置表中的标识。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'concubine_key'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 },
                                concubine_key: { type: 'string', description: '侍妾配置key', example: 'dream_fairy' }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放结果（侍妾ID、初始属性）')
        }
    },
    // 29. 调整侍妾属性
    '/api/admin/companion-concubine/concubine/set-attr': {
        post: {
            summary: 'GM 调整侍妾属性',
            description: 'GM 调整指定侍妾的属性。attr 支持：charm(魅力)/intimacy(亲密度)/loyalty(忠诚度)/exp(经验)/realm_rank(境界)。value 为非负数。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['concubine_id', 'attr', 'value'],
                            properties: {
                                concubine_id: { type: 'integer', description: '侍妾ID', example: 1 },
                                attr: {
                                    type: 'string',
                                    enum: ['charm', 'intimacy', 'loyalty', 'exp', 'realm_rank'],
                                    description: '属性字段：charm(魅力) / intimacy(亲密度) / loyalty(忠诚度) / exp(经验) / realm_rank(境界)',
                                    example: 'charm'
                                },
                                value: { type: 'number', minimum: 0, description: '属性目标值（非负数）', example: 100 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（新属性值）')
        }
    },
    // 30. 立即完成远航
    '/api/admin/companion-concubine/voyage/finish': {
        post: {
            summary: 'GM 立即完成远航',
            description: 'GM 立即完成指定远航记录，使其进入"可领取"状态。用于测试或补偿。操作审计。',
            tags: ['道侣侍妾GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['voyage_id'],
                            properties: {
                                voyage_id: { type: 'integer', description: '远航记录ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('完成结果（远航记录状态变化）')
        }
    }
};

// ==================== 新增 Schema 定义 ====================
// 为关键响应定义专属 schema，便于前端/工具引用（仅追加，不覆盖同名 schema）
const NEW_SCHEMAS = {
    // 道侣面板响应
    DaoCompanionProfileResponse: {
        type: 'object',
        description: '道侣面板响应数据',
        properties: {
            has_companion: { type: 'boolean', description: '是否有道侣' },
            companion_id: { type: 'integer', description: '道侣关系ID' },
            partner_player_id: { type: 'integer', description: '道侣对方玩家ID' },
            partner_name: { type: 'string', description: '道侣对方昵称' },
            heart_contract_level: { type: 'integer', description: '心契等级（0-5）' },
            dual_cultivate_count_today: { type: 'integer', description: '今日双修次数' },
            dual_cultivate_limit: { type: 'integer', description: '每日双修上限' },
            vows: {
                type: 'array',
                description: '当前生效的誓言列表',
                items: {
                    type: 'object',
                    properties: {
                        vow_id: { type: 'integer' },
                        vow_type: { type: 'string', enum: ['protect', 'secret', 'cultivate'] },
                        expire_at: { type: 'string', format: 'date-time' }
                    }
                }
            },
            heart_tribulation_pending: { type: 'integer', description: '待处理心劫事件数' }
        }
    },
    // 心契面板响应
    HeartContractResponse: {
        type: 'object',
        description: '心契面板响应数据',
        properties: {
            level: { type: 'integer', description: '当前心契等级（0-5）' },
            exp: { type: 'integer', description: '当前心契经验' },
            exp_to_next: { type: 'integer', description: '升至下一级所需经验' },
            progress: { type: 'number', description: '当前等级进度（0-1）' },
            privileges: {
                type: 'array',
                description: '当前等级已解锁特权',
                items: { type: 'string' }
            }
        }
    },
    // 心劫事件响应
    HeartTribulationEventResponse: {
        type: 'object',
        description: '心劫事件响应数据',
        properties: {
            event_id: { type: 'integer', description: '心劫事件ID' },
            event_type: { type: 'string', description: '心劫类型' },
            description: { type: 'string', description: '事件描述' },
            options: {
                type: 'array',
                description: '可选项列表',
                items: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', enum: ['steady', 'ruthless', 'deceive'] },
                        label: { type: 'string', description: '选项标签' },
                        description: { type: 'string', description: '选项描述' }
                    }
                }
            },
            expire_at: { type: 'string', format: 'date-time', description: '抉择截止时间' }
        }
    },
    // 侍妾列表响应
    ConcubineListResponse: {
        type: 'object',
        description: '侍妾列表响应数据',
        properties: {
            concubines: {
                type: 'array',
                description: '侍妾列表',
                items: {
                    type: 'object',
                    properties: {
                        concubine_id: { type: 'integer', description: '侍妾ID' },
                        name: { type: 'string', description: '侍妾名号' },
                        template_key: { type: 'string', description: '侍妾模板key' },
                        charm: { type: 'integer', description: '魅力' },
                        intimacy: { type: 'integer', description: '亲密度' },
                        loyalty: { type: 'integer', description: '忠诚度' },
                        exp: { type: 'integer', description: '修为经验' },
                        realm_rank: { type: 'integer', description: '境界等级' },
                        location: { type: 'string', nullable: true, description: '安置位置（null=未安置）' },
                        status: {
                            type: 'string',
                            enum: ['idle', 'voyaging', 'protecting'],
                            description: '状态：idle(空闲) / voyaging(远航中) / protecting(护法中)'
                        },
                        awakened: { type: 'boolean', description: '是否已觉醒婉影' }
                    }
                }
            }
        }
    },
    // 远航状态响应
    ConcubineVoyageResponse: {
        type: 'object',
        description: '远航状态响应数据',
        properties: {
            voyages: {
                type: 'array',
                description: '远航记录列表',
                items: {
                    type: 'object',
                    properties: {
                        voyage_id: { type: 'integer', description: '远航记录ID' },
                        concubine_id: { type: 'integer', description: '侍妾ID' },
                        concubine_name: { type: 'string', description: '侍妾名号' },
                        mode: {
                            type: 'string',
                            enum: ['safe', 'balanced', 'risky', 'moon_palace'],
                            description: '远航模式'
                        },
                        status: {
                            type: 'string',
                            enum: ['in_progress', 'claimable', 'expired'],
                            description: '状态：in_progress(进行中) / claimable(可领取) / expired(已超时)'
                        },
                        start_at: { type: 'string', format: 'date-time', description: '出发时间' },
                        return_at: { type: 'string', format: 'date-time', description: '归来时间' },
                        claim_deadline: { type: 'string', format: 'date-time', description: '领取截止时间' }
                    }
                }
            }
        }
    },
    // 侍妾操作请求体（通用）
    ConcubineActionRequest: {
        type: 'object',
        description: '侍妾操作通用请求体',
        properties: {
            concubine_id: { type: 'integer', description: '侍妾ID', example: 1 }
        },
        required: ['concubine_id']
    }
};

// ==================== 主流程 ====================
try {
    console.log('[openapi_patch_companion_concubine] 开始更新 docs/openapi.json');

    // 1. 读取原文件
    const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const spec = JSON.parse(rawContent);
    console.log('[openapi_patch_companion_concubine] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
            console.log(`[openapi_patch_companion_concubine] 已追加 tag: ${tag.name}`);
        } else {
            console.log(`[openapi_patch_companion_concubine] tag 已存在，跳过: ${tag.name}`);
        }
    }

    // 3. 追加 paths（幂等：按 path+method 跳过已存在的）
    if (!spec.paths || typeof spec.paths !== 'object') {
        spec.paths = {};
    }
    let addedPaths = 0;
    let skippedPaths = 0;
    for (const [pathKey, methods] of Object.entries(NEW_PATHS)) {
        if (spec.paths[pathKey]) {
            // 路径已存在，检查每个方法是否已存在
            for (const [method, definition] of Object.entries(methods)) {
                if (!spec.paths[pathKey][method]) {
                    spec.paths[pathKey][method] = definition;
                    addedPaths++;
                    console.log(`[openapi_patch_companion_concubine] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
                } else {
                    skippedPaths++;
                    console.log(`[openapi_patch_companion_concubine] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
                }
            }
        } else {
            // 路径不存在，整体追加
            spec.paths[pathKey] = methods;
            addedPaths += Object.keys(methods).length;
            console.log(`[openapi_patch_companion_concubine] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
        }
    }

    // 4. 追加 schemas（幂等：跳过已存在的）
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
            console.log(`[openapi_patch_companion_concubine] 已追加 schema: ${schemaName}`);
        } else {
            console.log(`[openapi_patch_companion_concubine] schema 已存在，跳过: ${schemaName}`);
        }
    }

    // 5. 写回文件（4 空格缩进，与现有 openapi.json 格式保持一致，便于 diff 审查）
    const output = JSON.stringify(spec, null, 4);
    fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

    console.log('\n[openapi_patch_companion_concubine] 更新完成！');
    console.log(`  - 新增 tags: ${addedTags} 个`);
    console.log(`  - 新增 paths: ${addedPaths} 个方法`);
    console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
    console.log(`  - 新增 schemas: ${addedSchemas} 个`);
    console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
    console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
    console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components.schemas).length}`);
} catch (err) {
    console.error('[openapi_patch_companion_concubine] 执行失败:', err);
    process.exit(1);
}
