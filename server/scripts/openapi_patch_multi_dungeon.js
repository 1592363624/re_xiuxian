/**
 * OpenAPI 文档补丁脚本：批次3 多人副本系统
 *
 * 作用：向 docs/openapi.json 注入批次3 多人副本系统的 16 个接口定义：
 *   玩家接口 12 个（/api/multi-dungeon/*，需 JWT 鉴权）：
 *     - help                副本规则说明（GET）
 *     - create              队长开启副本（POST）
 *     - join                队员加入副本（POST）
 *     - enter               队长进入开打（POST）
 *     - status              查看当前副本进度（GET）
 *     - choose              队长推进抉择（POST）
 *     - throw-zongzi        端午投粽（POST）
 *     - dissolve            队长解散副本（POST）
 *     - kick                队长踢人（POST）
 *     - rewards             查看奖励池（GET）
 *     - history             历史副本记录（GET）
 *     - cooldown            查询冷却状态（GET）
 *   GM 接口 4 个（/api/admin/multi-dungeon/*，需管理员权限）：
 *     - force-dissolve      强制解散副本
 *     - adjust-variable     调整副本变量
 *     - grant-reward        直接发放副本奖励
 *     - reset-cooldown      重置玩家冷却
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 2 个新 tag（多人副本系统、多人副本系统GM管理）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则跳过，保证幂等）
 *   - 在 components.schemas 中追加 4 个新响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_multi_dungeon.js
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
        name: '多人副本系统',
        description: '批次3新增：掩月抢亲/端午镇蛟多人副本系统玩家接口'
    },
    {
        name: '多人副本系统GM管理',
        description: '批次3新增：多人副本系统GM后台管理接口'
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

// 副本键的通用枚举（玩家创建/奖励池查询使用）
const DUNGEON_KEY_ENUM = ['yanyue', 'duanwu'];
// 重置冷却接口允许 'all'（与后端 admin_multi_dungeon.js 中 enum 一致）
const DUNGEON_KEY_ENUM_WITH_ALL = ['yanyue', 'duanwu', 'all'];
// 副本变量枚举（与后端 admin_multi_dungeon.js allowedVars 一致）
const VARIABLE_ENUM = [
    'morale',
    'vigilance',
    'demon_corruption',
    'seal_stability',
    'soul_stability',
    'harvest_multiplier'
];

// ==================== 16 个新接口定义 ====================
const NEW_PATHS = {
    // ============== 玩家接口：多人副本系统（12 个，与 server/routes/multi_dungeon.js 实际路由对齐） ==============

    // 1. 副本规则说明（只读）
    '/api/multi-dungeon/help': {
        get: {
            summary: '副本规则说明',
            description: '返回所有副本（掩月抢亲/端午镇蛟）的玩法概要、前置条件、状态机说明。该接口为只读操作。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            responses: playerResponses('副本规则说明数据（玩法概要、前置条件、状态机）')
        }
    },
    // 2. 队长开启副本
    '/api/multi-dungeon/create': {
        post: {
            summary: '队长开启副本',
            description: '队长开启掩月抢亲或端午镇蛟副本，校验前置条件并消耗物品。校验通过后创建副本实例，队长自动加入。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['dungeon_key'],
                            properties: {
                                dungeon_key: {
                                    type: 'string',
                                    enum: DUNGEON_KEY_ENUM,
                                    description: '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟',
                                    example: 'yanyue'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('副本实例数据（instance_id、副本键、当前阶段、成员列表）')
        }
    },
    // 3. 队员加入副本
    '/api/multi-dungeon/join': {
        post: {
            summary: '队员加入副本',
            description: '队员通过 instance_id 加入队长创建的副本。校验副本状态、人数上限、是否已加入其他副本。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['instance_id'],
                            properties: {
                                instance_id: {
                                    type: 'integer',
                                    description: '副本实例ID（由队长 create 后获得）',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('加入结果（副本实例信息、当前成员列表）')
        }
    },
    // 4. 队长进入开打
    '/api/multi-dungeon/enter': {
        post: {
            summary: '队长进入开打',
            description: '队长确认开始副本战斗。端午副本需满 10 人 + 至少 1 个粽子；掩月需满足人数下限。无请求体参数。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            responses: playerResponses('进入结果（副本阶段切换、初始变量值）')
        }
    },
    // 5. 查看当前副本进度（只读）
    '/api/multi-dungeon/status': {
        get: {
            summary: '查看当前副本进度',
            description: '查看玩家当前所在的副本进度，包括副本变量、成员列表、当前幕抉择选项、历史抉择记录。该接口为只读操作。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            responses: playerResponses('副本进度数据（变量、成员、当前抉择、历史抉择）')
        }
    },
    // 6. 队长推进抉择
    '/api/multi-dungeon/choose': {
        post: {
            summary: '队长推进抉择',
            description: '队长对当前幕的抉择做出选择，推进副本剧情。不同 choice_key 对应不同分支，影响副本变量与最终奖励。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['choice_key'],
                            properties: {
                                choice_key: {
                                    type: 'string',
                                    description: '抉择选项key（由 status 接口返回的当前幕 options 提供）',
                                    example: 'accept'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('抉择结果（变量变化、下一幕信息、是否触发战斗）')
        }
    },
    // 7. 端午投粽
    '/api/multi-dungeon/throw-zongzi': {
        post: {
            summary: '端午投粽',
            description: '端午镇蛟副本专属：玩家投入粽子攻击蛟龙，count 范围 1-5。每个粽子造成不同伤害，影响副本变量。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['count'],
                            properties: {
                                count: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 5,
                                    description: '投粽数量（1-5）',
                                    example: 3
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('投粽结果（伤害值、蛟龙状态变化、剩余粽子数）')
        }
    },
    // 8. 队长解散副本
    '/api/multi-dungeon/dissolve': {
        post: {
            summary: '队长解散副本',
            description: '队长主动解散副本，所有成员退出。幂等：已解散不报错。无请求体参数。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            responses: playerResponses('解散结果（成员退出列表）')
        }
    },
    // 9. 队长踢人
    '/api/multi-dungeon/kick': {
        post: {
            summary: '队长踢人',
            description: '队长将指定队员踢出副本。target_player_id 必须为当前副本成员且非队长本人。',
            tags: ['多人副本系统'],
            security: securityRequirement,
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
                                    description: '被踢队员玩家ID',
                                    example: 1001
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('踢人结果（剩余成员列表）')
        }
    },
    // 10. 查看奖励池（只读）
    '/api/multi-dungeon/rewards': {
        get: {
            summary: '查看奖励池',
            description: '查看指定副本的奖励池配置，包括奖励key、奖励内容、触发条件。该接口为只读操作。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            parameters: [
                {
                    name: 'dungeon_key',
                    in: 'query',
                    required: true,
                    schema: {
                        type: 'string',
                        enum: DUNGEON_KEY_ENUM
                    },
                    description: '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟'
                }
            ],
            responses: playerResponses('奖励池数据（奖励key列表、奖励内容、触发条件）')
        }
    },
    // 11. 历史副本记录（只读，分页）
    '/api/multi-dungeon/history': {
        get: {
            summary: '历史副本记录',
            description: '查询玩家参与过的历史副本记录，支持分页。该接口为只读操作。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            parameters: [
                {
                    name: 'page',
                    in: 'query',
                    required: false,
                    schema: {
                        type: 'integer',
                        minimum: 1,
                        default: 1
                    },
                    description: '页码（默认 1）'
                },
                {
                    name: 'size',
                    in: 'query',
                    required: false,
                    schema: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 100,
                        default: 20
                    },
                    description: '每页数量（默认 20，最大 100）'
                }
            ],
            responses: playerResponses('历史副本记录列表（含分页信息）')
        }
    },
    // 12. 查询冷却状态（只读）
    '/api/multi-dungeon/cooldown': {
        get: {
            summary: '查询冷却状态',
            description: '查询玩家在 yanyue 和 duanwu 两个副本的当前冷却状态，返回剩余冷却时间。该接口为只读操作。',
            tags: ['多人副本系统'],
            security: securityRequirement,
            responses: playerResponses('冷却状态数据（yanyue/duanwu 两个副本键的剩余冷却时间）')
        }
    },

    // ============== GM 接口：多人副本系统管理（4 个，与 server/routes/admin_multi_dungeon.js 实际路由对齐） ==============

    // 13. GM 强制解散副本
    '/api/admin/multi-dungeon/force-dissolve': {
        post: {
            summary: 'GM 强制解散副本',
            description: 'GM 强制解散指定副本实例，无需队长权限。操作审计。',
            tags: ['多人副本系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['instance_id'],
                            properties: {
                                instance_id: {
                                    type: 'integer',
                                    description: '副本实例ID',
                                    example: 1
                                }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('解散结果（副本实例信息、退出成员列表）')
        }
    },
    // 14. GM 调整副本变量
    '/api/admin/multi-dungeon/adjust-variable': {
        post: {
            summary: 'GM 调整副本变量',
            description: 'GM 调整指定副本实例的变量（士气/警戒/魔染/封印/神魂/收获倍率），用于测试或补偿。操作审计。',
            tags: ['多人副本系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['instance_id', 'variable', 'value'],
                            properties: {
                                instance_id: {
                                    type: 'integer',
                                    description: '副本实例ID',
                                    example: 1
                                },
                                variable: {
                                    type: 'string',
                                    enum: VARIABLE_ENUM,
                                    description: '变量名：morale(士气) / vigilance(警戒) / demon_corruption(魔染) / seal_stability(封印稳定) / soul_stability(神魂稳定) / harvest_multiplier(收获倍率)',
                                    example: 'morale'
                                },
                                value: {
                                    type: 'number',
                                    description: '变量目标值（数字）',
                                    example: 80
                                }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（变量旧值、新值）')
        }
    },
    // 15. GM 直接发放副本奖励
    '/api/admin/multi-dungeon/grant-reward': {
        post: {
            summary: 'GM 直接发放副本奖励',
            description: 'GM 向指定玩家直接发放副本奖励，绕过副本完成流程。reward_key 对应奖励池中的奖励标识。操作审计。',
            tags: ['多人副本系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'dungeon_key', 'reward_key'],
                            properties: {
                                player_id: {
                                    type: 'integer',
                                    description: '目标玩家ID',
                                    example: 1
                                },
                                dungeon_key: {
                                    type: 'string',
                                    enum: DUNGEON_KEY_ENUM,
                                    description: '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟',
                                    example: 'yanyue'
                                },
                                reward_key: {
                                    type: 'string',
                                    description: '奖励key（对应奖励池中的奖励标识）',
                                    example: 'first_blood_reward'
                                }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放结果（获得的物品/资源列表）')
        }
    },
    // 16. GM 重置玩家冷却
    '/api/admin/multi-dungeon/reset-cooldown': {
        post: {
            summary: 'GM 重置玩家冷却',
            description: 'GM 重置指定玩家的副本冷却时间。dungeon_key 支持传 all 重置所有副本冷却。操作审计。',
            tags: ['多人副本系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'dungeon_key'],
                            properties: {
                                player_id: {
                                    type: 'integer',
                                    description: '目标玩家ID',
                                    example: 1
                                },
                                dungeon_key: {
                                    type: 'string',
                                    enum: DUNGEON_KEY_ENUM_WITH_ALL,
                                    description: '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟，all=重置所有副本冷却',
                                    example: 'all'
                                }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('重置结果（被重置的副本键列表）')
        }
    }
};

// ==================== 新增 Schema 定义 ====================
// 为关键响应定义专属 schema，便于前端/工具引用（仅追加，不覆盖同名 schema）
const NEW_SCHEMAS = {
    // 副本实例响应
    MultiDungeonInstanceResponse: {
        type: 'object',
        description: '多人副本实例响应数据',
        properties: {
            instance_id: { type: 'integer', description: '副本实例ID' },
            dungeon_key: {
                type: 'string',
                enum: ['yanyue', 'duanwu'],
                description: '副本键：yanyue=掩月抢亲，duanwu=端午镇蛟'
            },
            leader_player_id: { type: 'integer', description: '队长玩家ID' },
            leader_name: { type: 'string', description: '队长昵称' },
            stage: {
                type: 'string',
                description: '当前阶段（forming=组队中 / in_progress=进行中 / finished=已完成 / dissolved=已解散）'
            },
            member_count: { type: 'integer', description: '当前成员数' },
            member_limit: { type: 'integer', description: '成员上限' },
            members: {
                type: 'array',
                description: '成员列表',
                items: {
                    type: 'object',
                    properties: {
                        player_id: { type: 'integer', description: '玩家ID' },
                        player_name: { type: 'string', description: '玩家昵称' },
                        is_leader: { type: 'boolean', description: '是否队长' },
                        joined_at: { type: 'string', format: 'date-time', description: '加入时间' }
                    }
                }
            },
            created_at: { type: 'string', format: 'date-time', description: '副本创建时间' }
        }
    },
    // 副本状态响应
    MultiDungeonStatusResponse: {
        type: 'object',
        description: '多人副本状态响应数据',
        properties: {
            instance_id: { type: 'integer', description: '副本实例ID' },
            dungeon_key: {
                type: 'string',
                enum: ['yanyue', 'duanwu'],
                description: '副本键'
            },
            stage: { type: 'string', description: '当前阶段' },
            current_act: { type: 'integer', description: '当前幕数' },
            variables: {
                type: 'object',
                description: '副本变量（士气/警戒/魔染/封印/神魂/收获倍率等）',
                properties: {
                    morale: { type: 'number', description: '士气' },
                    vigilance: { type: 'number', description: '警戒' },
                    demon_corruption: { type: 'number', description: '魔染' },
                    seal_stability: { type: 'number', description: '封印稳定' },
                    soul_stability: { type: 'number', description: '神魂稳定' },
                    harvest_multiplier: { type: 'number', description: '收获倍率' }
                }
            },
            current_options: {
                type: 'array',
                description: '当前幕可选项列表',
                items: {
                    type: 'object',
                    properties: {
                        choice_key: { type: 'string', description: '选项key' },
                        label: { type: 'string', description: '选项标签' },
                        description: { type: 'string', description: '选项描述' }
                    }
                }
            },
            history_choices: {
                type: 'array',
                description: '历史抉择记录',
                items: {
                    type: 'object',
                    properties: {
                        act: { type: 'integer', description: '幕数' },
                        choice_key: { type: 'string', description: '选择的key' },
                        chosen_at: { type: 'string', format: 'date-time', description: '抉择时间' }
                    }
                }
            }
        }
    },
    // 副本抉择请求体
    MultiDungeonChoiceRequest: {
        type: 'object',
        description: '多人副本抉择请求体',
        properties: {
            choice_key: {
                type: 'string',
                description: '抉择选项key（由 status 接口返回的当前幕 options 提供）',
                example: 'accept'
            }
        },
        required: ['choice_key']
    },
    // 副本奖励池响应
    MultiDungeonRewardsResponse: {
        type: 'object',
        description: '多人副本奖励池响应数据',
        properties: {
            dungeon_key: {
                type: 'string',
                enum: ['yanyue', 'duanwu'],
                description: '副本键'
            },
            rewards: {
                type: 'array',
                description: '奖励列表',
                items: {
                    type: 'object',
                    properties: {
                        reward_key: { type: 'string', description: '奖励key' },
                        name: { type: 'string', description: '奖励名称' },
                        description: { type: 'string', description: '奖励描述' },
                        trigger_condition: { type: 'string', description: '触发条件说明' },
                        items: {
                            type: 'array',
                            description: '奖励物品列表',
                            items: {
                                type: 'object',
                                properties: {
                                    item_key: { type: 'string', description: '物品key' },
                                    item_name: { type: 'string', description: '物品名称' },
                                    count: { type: 'integer', description: '数量' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

// ==================== 主流程 ====================
try {
    console.log('[openapi_patch_multi_dungeon] 开始更新 docs/openapi.json');

    // 1. 读取原文件
    const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const spec = JSON.parse(rawContent);
    console.log('[openapi_patch_multi_dungeon] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
            console.log(`[openapi_patch_multi_dungeon] 已追加 tag: ${tag.name}`);
        } else {
            console.log(`[openapi_patch_multi_dungeon] tag 已存在，跳过: ${tag.name}`);
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
                    console.log(`[openapi_patch_multi_dungeon] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
                } else {
                    skippedPaths++;
                    console.log(`[openapi_patch_multi_dungeon] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
                }
            }
        } else {
            // 路径不存在，整体追加
            spec.paths[pathKey] = methods;
            addedPaths += Object.keys(methods).length;
            console.log(`[openapi_patch_multi_dungeon] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
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
            console.log(`[openapi_patch_multi_dungeon] 已追加 schema: ${schemaName}`);
        } else {
            console.log(`[openapi_patch_multi_dungeon] schema 已存在，跳过: ${schemaName}`);
        }
    }

    // 5. 写回文件（4 空格缩进，与现有 openapi.json 格式保持一致，便于 diff 审查）
    const output = JSON.stringify(spec, null, 4);
    fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

    console.log('\n[openapi_patch_multi_dungeon] 更新完成！');
    console.log(`  - 新增 tags: ${addedTags} 个`);
    console.log(`  - 新增 paths: ${addedPaths} 个方法`);
    console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
    console.log(`  - 新增 schemas: ${addedSchemas} 个`);
    console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
    console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
    console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components.schemas).length}`);
} catch (err) {
    console.error('[openapi_patch_multi_dungeon] 执行失败:', err);
    process.exit(1);
}
