/**
 * OpenAPI 文档补丁脚本：批次3-b3-2 后期系统
 *
 * 作用：向 docs/openapi.json 注入批次3-b3-2 后期系统的 29 个接口定义：
 *   玩家接口 21 个：
 *     - 第二元神系统 /api/second-soul (7 个)
 *     - 小世界系统   /api/small-world  (4 个)
 *     - 神庙系统     /api/divine-temple (4 个)
 *     - 香火系统     /api/incense       (1 个)
 *     - 神识系统     /api/divine-sense  (2 个)
 *     - 法则系统     /api/law           (3 个)
 *   GM 接口 8 个（/api/admin/late-stage/*，需管理员权限）：
 *     - second-soul/adjust-attributes, small-world/reset, small-world/set-level,
 *       divine-temple/set-level, incense/grant, divine-sense/grant,
 *       law/grant-points, law/grant-fragment
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 2 个新 tag（后期系统、后期系统GM管理）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则跳过，保证幂等）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_late_stage.js
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
        name: '后期系统',
        description: '批次3-b3-2 后期玩法 - 第二元神（召唤/属性调整/出窍/召回/残篇）、小世界（开辟/显灵/神迹）、神庙（升级/修复/供奉）、香火流水、神识淬炼、法则转换/碎片'
    },
    {
        name: '后期系统GM管理',
        description: '批次3-b3-2 GM 后台 - 副元神属性调整、小世界重置/等级调整、神庙等级调整、香火/神识/法则点/法则碎片发放扣减'
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

// ==================== 29 个新接口定义 ====================
const NEW_PATHS = {
    // ============== 玩家接口：第二元神系统（5 个，与 server/routes/second-soul.js 实际路由对齐） ==============
    '/api/second-soul/profile': {
        get: {
            summary: '第二元神面板',
            description: '获取玩家第二元神面板数据：主元神信息、所有副元神状态、5类残篇收集进度、凝练条件。该接口为只读操作。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('第二元神面板数据（含 souls 列表、fragment_progress、condense_requirements）')
        }
    },
    '/api/second-soul/condense': {
        post: {
            summary: '凝练第二元神',
            description: '凝练第二元神（化神期 + 5类残篇各1份 + 灵石/神识/残魂消耗）。第二元神初始属性 = 主元神属性 * inherit_ratio(0.6) + 随机加成(±10%)，初始境界 = 主元神境界 - 1 子境界。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['soul_name'],
                            properties: {
                                soul_name: { type: 'string', minLength: 1, maxLength: 50, description: '第二元神名称', example: '青冥子' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('凝练结果（第二元神初始属性、消耗资源）')
        }
    },
    '/api/second-soul/divide': {
        post: {
            summary: '分化第三元神',
            description: '分化第三元神（需第二元神境界≥化神期）。第三元神属性继承比例更低，但可独立修炼与调度。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['soul_name'],
                            properties: {
                                soul_name: { type: 'string', minLength: 1, maxLength: 50, description: '第三元神名称', example: '玄机子' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('分化结果（第三元神初始属性）')
        }
    },
    '/api/second-soul/dispatch': {
        post: {
            summary: '切换元神调度模式',
            description: '切换副元神调度模式（combat=战斗/cultivate=修炼/scout=侦察/defend=驻守），各模式独立 CD。不同模式提供不同增益与收益。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['soul_index', 'mode'],
                            properties: {
                                soul_index: { type: 'integer', enum: [2, 3], description: '元神索引（2=第二元神，3=第三元神）', example: 2 },
                                mode: { type: 'string', enum: ['combat', 'cultivate', 'scout', 'defend'], description: '调度模式', example: 'cultivate' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('调度结果（新模式、CD 结束时间）')
        }
    },
    '/api/second-soul/cultivate': {
        post: {
            summary: '开始独立修炼',
            description: '副元神开始独立修炼（12小时上限，每日2次）。修炼结束后获得经验，境界提升。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['soul_index'],
                            properties: {
                                soul_index: { type: 'integer', enum: [2, 3], description: '元神索引（2=第二元神，3=第三元神）', example: 2 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('修炼开始结果（结束时间、今日剩余次数）')
        }
    },


    // ============== 玩家接口：小世界系统（4 个） ==============
    '/api/small-world/profile': {
        get: {
            summary: '小世界面板',
            description: '获取玩家小世界面板数据：是否已开辟、世界名称、等级、信仰值、香火来源、当前祈愿队列、神迹干预次数等。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('小世界面板数据')
        }
    },
    '/api/small-world/create': {
        post: {
            summary: '开辟小世界',
            description: '开辟个人小世界，需消耗大量灵石与材料。开辟后成为小世界之主，可显灵回应祈愿、施展神迹。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['world_name'],
                            properties: {
                                world_name: { type: 'string', minLength: 1, maxLength: 16, description: '小世界名称', example: '青冥小世界' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('开辟结果（小世界初始信息）')
        }
    },
    '/api/small-world/manifest': {
        post: {
            summary: '显灵回应祈愿',
            description: '显灵回应信徒祈愿，消耗信仰值，获得香火与回报。无请求体参数。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('显灵结果（信仰消耗、香火获得）')
        }
    },
    '/api/small-world/miracle': {
        post: {
            summary: '神迹干预',
            description: '在小世界中施展神迹干预，type 可为 bless（赐福）/punish（天罚）/harvest（丰收）等，消耗信仰值，每日次数上限。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['type'],
                            properties: {
                                type: { type: 'string', enum: ['bless', 'punish', 'harvest'], description: '神迹类型', example: 'bless' }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('神迹结果（效果、信仰消耗、剩余次数）')
        }
    },

    // ============== 玩家接口：神庙系统（4 个） ==============
    '/api/divine-temple/profile': {
        get: {
            summary: '神庙面板',
            description: '获取玩家神庙面板数据：神庙等级、护界禁制耐久、供奉兑换列表、当前信仰值等。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('神庙面板数据')
        }
    },
    '/api/divine-temple/upgrade': {
        post: {
            summary: '升级神庙',
            description: '升级神庙等级，提升供奉兑换上限与禁制耐久上限，消耗灵石与信仰值。无请求体参数。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('升级结果（新等级、属性提升）')
        }
    },
    '/api/divine-temple/repair-defense': {
        post: {
            summary: '修复护界禁制',
            description: '修复神庙护界禁制耐久，消耗灵石与信仰值。无请求体参数。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('修复结果（新耐久值）')
        }
    },
    '/api/divine-temple/exchange-offering': {
        post: {
            summary: '兑换供奉',
            description: '使用信仰值兑换供奉奖励（offering_id 对应供奉配置表中的奖励项）。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['offering_id'],
                            properties: {
                                offering_id: { type: 'integer', description: '供奉配置ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('兑换结果（获得的物品/资源）')
        }
    },

    // ============== 玩家接口：香火系统（2 个，与 server/routes/incense.js 实际路由对齐） ==============
    '/api/incense/harvest': {
        post: {
            summary: '收割香火',
            description: '收割香火（按公式计算累计产出，更新玩家 incense_balance）。同步结算小世界人口/信仰/稳定度变化。无请求体参数。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('收割结果（获得香火、新余额、小世界状态变化）')
        }
    },
    '/api/incense/logs': {
        get: {
            summary: '香火流水',
            description: '查询玩家香火变化流水记录（分页），可按 change_type 过滤（如 manifest/miracle/temple_exchange/admin_grant 等）。',
            tags: ['后期系统'],
            security: securityRequirement,
            parameters: [
                { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 }, description: '页码' },
                { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, description: '每页条数' },
                { name: 'change_type', in: 'query', required: false, schema: { type: 'string' }, description: '变化类型过滤（如 manifest/miracle/temple_exchange/admin_grant）' }
            ],
            responses: playerResponses('香火流水分页列表')
        }
    },

    // ============== 玩家接口：神识系统（2 个） ==============
    '/api/divine-sense/profile': {
        get: {
            summary: '神识面板',
            description: '获取玩家神识面板数据：当前神识值、神识上限、淬炼次数、淬炼冷却等。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('神识面板数据')
        }
    },
    '/api/divine-sense/quench': {
        post: {
            summary: '神识淬炼',
            description: '消耗灵石对神识进行淬炼，提升神识上限。amount 为淬炼次数或投入资源量，受每日上限与冷却约束。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['amount'],
                            properties: {
                                amount: { type: 'integer', minimum: 1, description: '淬炼量（次数或资源量）', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('淬炼结果（新神识上限、消耗）')
        }
    },

    // ============== 玩家接口：法则系统（4 个，与 server/routes/law.js 实际路由对齐） ==============
    '/api/law/profile': {
        get: {
            summary: '法则面板',
            description: '获取玩家法则面板数据：法则点（当前/累计/每日）、5类法则碎片持有量、转换比率、转换选项、碎片类型说明。该接口为只读操作。',
            tags: ['后期系统'],
            security: securityRequirement,
            responses: playerResponses('法则面板数据（含 law_points、fragments、convert_rates、convert_options）')
        }
    },
    '/api/law/convert-divine-sense': {
        post: {
            summary: '神识转法则点',
            description: '神识→法则点转换（100 神识=1 法则点，受每日获取上限限制）。转换后神识减少，法则点增加。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['divine_sense_amount'],
                            properties: {
                                divine_sense_amount: { type: 'integer', minimum: 1, description: '消耗的神识数量（须为正整数）', example: 500 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('转换结果（获得法则点、剩余神识、每日已获）')
        }
    },
    '/api/law/convert-fragment': {
        post: {
            summary: '碎片转法则点',
            description: '法则碎片→法则点转换（空间碎片=5点/其他碎片=3点，受每日获取上限限制）。fragment_type 支持 space/time/five_elements/soul/karma。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['fragment_type', 'fragment_count'],
                            properties: {
                                fragment_type: { type: 'string', enum: ['space', 'time', 'five_elements', 'soul', 'karma'], description: '碎片类型', example: 'space' },
                                fragment_count: { type: 'integer', minimum: 1, description: '转换数量（须为正整数）', example: 2 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('转换结果（获得法则点、剩余碎片、每日已获）')
        }
    },
    '/api/law/convert': {
        post: {
            summary: '法则转换（消耗法则点兑换效果）',
            description: '消耗法则点兑换7种永久/临时效果。convert_id 支持：ask_dao_insight(问道感悟)/dharma_form_exp(法相经验)/divine_sense_max(神识上限)/remnant_soul_recover(残魂恢复)/breakthrough_success_rate(突破成功率)/ascension_success_rate(飞升成功率)/space_law_fragment(空间法则碎片)。',
            tags: ['后期系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['convert_id'],
                            properties: {
                                convert_id: { type: 'string', description: '法则转换配置ID', example: 'ask_dao_insight' },
                                count: { type: 'integer', minimum: 1, maximum: 100, description: '转换次数（默认1）', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('转换结果（获得的效果、消耗的法则点）')
        }
    },

    // ============== GM 接口：后期系统管理（8 个） ==============
    '/api/admin/late-stage/second-soul/adjust-attributes': {
        post: {
            summary: 'GM 调整副元神属性',
            description: 'GM 调整指定玩家副元神属性（attribute 支持 atk/def/hp_max/speed/sense 等），delta 为变化值。用于测试或补偿。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'attribute', 'delta'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                attribute: { type: 'string', description: '属性字段名', example: 'atk' },
                                delta: { type: 'integer', description: '变化值（正为加，负为减）', example: 100 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（新属性值）')
        }
    },
    '/api/admin/late-stage/small-world/reset': {
        post: {
            summary: 'GM 重置玩家小世界',
            description: 'GM 重置指定玩家的小世界（清空等级、信仰值、香火等，回到未开辟状态或初始状态）。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('重置结果')
        }
    },
    '/api/admin/late-stage/small-world/set-level': {
        post: {
            summary: 'GM 调整小世界等级',
            description: 'GM 调整指定玩家小世界等级（level 为目标等级，受配置上限约束）。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'level'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                level: { type: 'integer', minimum: 0, description: '小世界目标等级', example: 5 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（新等级）')
        }
    },
    '/api/admin/late-stage/divine-temple/set-level': {
        post: {
            summary: 'GM 调整神庙等级',
            description: 'GM 调整指定玩家神庙等级（level 为目标等级，受配置上限约束）。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'level'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                level: { type: 'integer', minimum: 0, description: '神庙目标等级', example: 5 }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('调整结果（新等级）')
        }
    },
    '/api/admin/late-stage/incense/grant': {
        post: {
            summary: 'GM 发放/扣减香火',
            description: 'GM 向指定玩家发放或扣减香火（amount 正为发放，负为扣减），需提供原因。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'amount', 'reason'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                amount: { type: 'integer', description: '变化值（正为发放，负为扣减）', example: 1000 },
                                reason: { type: 'string', maxLength: 200, description: '操作原因', example: '补偿活动奖励' }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放/扣减结果（新香火值）')
        }
    },
    '/api/admin/late-stage/divine-sense/grant': {
        post: {
            summary: 'GM 发放/扣减神识',
            description: 'GM 向指定玩家发放或扣减神识（amount 正为发放，负为扣减），需提供原因。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'amount', 'reason'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                amount: { type: 'integer', description: '变化值（正为发放，负为扣减）', example: 500 },
                                reason: { type: 'string', maxLength: 200, description: '操作原因', example: '补偿活动奖励' }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放/扣减结果（新神识值）')
        }
    },
    '/api/admin/late-stage/law/grant-points': {
        post: {
            summary: 'GM 发放/扣减法则点',
            description: 'GM 向指定玩家发放或扣减法则点（amount 正为发放，负为扣减），需提供原因。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'amount', 'reason'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                amount: { type: 'integer', description: '变化值（正为发放，负为扣减）', example: 100 },
                                reason: { type: 'string', maxLength: 200, description: '操作原因', example: '补偿活动奖励' }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放/扣减结果（新法则点）')
        }
    },
    '/api/admin/late-stage/law/grant-fragment': {
        post: {
            summary: 'GM 发放/扣减法则碎片',
            description: 'GM 向指定玩家发放或扣减法则碎片（count 正为发放，负为扣减），需指定碎片ID并提供原因。操作审计。',
            tags: ['后期系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['playerId', 'fragmentId', 'count', 'reason'],
                            properties: {
                                playerId: { type: 'integer', description: '玩家ID', example: 1 },
                                fragmentId: { type: 'integer', description: '法则碎片ID', example: 1 },
                                count: { type: 'integer', description: '变化数量（正为发放，负为扣减）', example: 10 },
                                reason: { type: 'string', maxLength: 200, description: '操作原因', example: '补偿活动奖励' }
                            }
                        }
                    }
                }
            },
            responses: gmResponses('发放/扣减结果（新碎片数量）')
        }
    }
};

// ==================== 新增 Schema 定义 ====================
// 为关键响应定义专属 schema，便于前端/工具引用（仅追加，不覆盖同名 schema）
const NEW_SCHEMAS = {
    // 第二元神面板响应
    SecondSoulProfileResponse: {
        type: 'object',
        description: '第二元神面板响应数据',
        properties: {
            summoned: { type: 'boolean', description: '是否已召唤副元神' },
            soul_name: { type: 'string', description: '副元神名称' },
            attributes: {
                type: 'object',
                description: '副元神属性',
                properties: {
                    atk: { type: 'integer' },
                    def: { type: 'integer' },
                    hp_max: { type: 'integer' },
                    speed: { type: 'integer' },
                    sense: { type: 'integer' }
                }
            },
            is_separated: { type: 'boolean', description: '是否处于出窍状态' },
            separate_end_at: { type: 'string', format: 'date-time', nullable: true, description: '出窍结束时间' },
            fragment_count: { type: 'integer', description: '元神残篇碎片总数' }
        }
    },
    // 小世界面板响应
    SmallWorldProfileResponse: {
        type: 'object',
        description: '小世界面板响应数据',
        properties: {
            created: { type: 'boolean', description: '是否已开辟小世界' },
            world_name: { type: 'string', description: '小世界名称' },
            level: { type: 'integer', description: '小世界等级' },
            faith: { type: 'integer', description: '信仰值' },
            incense: { type: 'integer', description: '当前香火' },
            miracle_daily_used: { type: 'integer', description: '今日已用神迹次数' },
            miracle_daily_limit: { type: 'integer', description: '每日神迹次数上限' }
        }
    },
    // 神庙面板响应
    DivineTempleProfileResponse: {
        type: 'object',
        description: '神庙面板响应数据',
        properties: {
            level: { type: 'integer', description: '神庙等级' },
            defense_durability: { type: 'integer', description: '当前护界禁制耐久' },
            defense_max: { type: 'integer', description: '护界禁制耐久上限' },
            faith: { type: 'integer', description: '当前信仰值' },
            offerings: {
                type: 'array',
                description: '供奉兑换列表',
                items: {
                    type: 'object',
                    properties: {
                        offering_id: { type: 'integer' },
                        name: { type: 'string' },
                        cost_faith: { type: 'integer' },
                        reward: { type: 'object' }
                    }
                }
            }
        }
    },
    // 神识面板响应
    DivineSenseProfileResponse: {
        type: 'object',
        description: '神识面板响应数据',
        properties: {
            sense: { type: 'integer', description: '当前神识值' },
            sense_max: { type: 'integer', description: '神识上限' },
            quench_daily_used: { type: 'integer', description: '今日已淬炼次数' },
            quench_daily_limit: { type: 'integer', description: '每日淬炼次数上限' },
            quench_cd_end_at: { type: 'string', format: 'date-time', nullable: true, description: '淬炼冷却结束时间' }
        }
    },
    // 法则面板响应
    LawProfileResponse: {
        type: 'object',
        description: '法则面板响应数据',
        properties: {
            law_points: { type: 'integer', description: '法则点' },
            converted_laws: {
                type: 'array',
                description: '已转换法则列表',
                items: {
                    type: 'object',
                    properties: {
                        law_id: { type: 'integer' },
                        law_name: { type: 'string' },
                        level: { type: 'integer' }
                    }
                }
            },
            fragment_total: { type: 'integer', description: '法则碎片总数' }
        }
    },
    // 香火流水项
    IncenseLogItem: {
        type: 'object',
        description: '香火流水记录项',
        properties: {
            id: { type: 'integer', description: '流水ID' },
            player_id: { type: 'integer', description: '玩家ID' },
            change_type: { type: 'string', description: '变化类型（manifest/miracle/temple_exchange/admin_grant 等）' },
            amount: { type: 'integer', description: '变化值（正为获得，负为消耗）' },
            balance_after: { type: 'integer', description: '变化后余额' },
            remark: { type: 'string', description: '备注' },
            created_at: { type: 'string', format: 'date-time', description: '发生时间' }
        }
    }
};

// ==================== 主流程 ====================
console.log('[openapi_patch_late_stage] 开始更新 docs/openapi.json');

// 1. 读取原文件
const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
const spec = JSON.parse(rawContent);
console.log('[openapi_patch_late_stage] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
        console.log(`[openapi_patch_late_stage] 已追加 tag: ${tag.name}`);
    } else {
        console.log(`[openapi_patch_late_stage] tag 已存在，跳过: ${tag.name}`);
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
                console.log(`[openapi_patch_late_stage] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
            } else {
                skippedPaths++;
                console.log(`[openapi_patch_late_stage] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
            }
        }
    } else {
        // 路径不存在，整体追加
        spec.paths[pathKey] = methods;
        addedPaths += Object.keys(methods).length;
        console.log(`[openapi_patch_late_stage] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
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
        console.log(`[openapi_patch_late_stage] 已追加 schema: ${schemaName}`);
    } else {
        console.log(`[openapi_patch_late_stage] schema 已存在，跳过: ${schemaName}`);
    }
}

// 5. 写回文件（4 空格缩进，保留中文可读性）
const output = JSON.stringify(spec, null, 4);
fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

console.log('\n[openapi_patch_late_stage] 更新完成！');
console.log(`  - 新增 tags: ${addedTags} 个`);
console.log(`  - 新增 paths: ${addedPaths} 个方法`);
console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
console.log(`  - 新增 schemas: ${addedSchemas} 个`);
console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components.schemas).length}`);
