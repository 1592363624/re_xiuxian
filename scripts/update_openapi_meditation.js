/**
 * OpenAPI 文档增量更新脚本 - 第三阶段 静思悟道 + 突破瓶颈系统
 *
 * 功能：
 *   1. 新增 Meditation 标签（静思悟道系统）
 *   2. 新增 管理员-悟道瓶颈 标签（GM 后台悟道管理）
 *   3. 新增 4 个玩家端接口：
 *      - POST /api/meditation/start
 *      - POST /api/meditation/interrupt
 *      - GET  /api/meditation/status
 *      - GET  /api/meditation/config
 *   4. 新增 7 个 GM 后台接口：
 *      - GET  /api/admin/meditation/metrics
 *      - GET  /api/admin/meditation/list
 *      - GET  /api/admin/meditation/{playerId}
 *      - POST /api/admin/meditation/{playerId}/force-settle
 *      - POST /api/admin/meditation/{playerId}/force-interrupt
 *      - PUT  /api/admin/meditation/{playerId}/bottleneck
 *      - POST /api/admin/meditation/{playerId}/bottleneck/reset
 *   5. 更新 /api/breakthrough/info 和 /api/breakthrough/try 的响应（瓶颈系统集成）
 *
 * 执行：node scripts/update_openapi_meditation.js
 * 幂等：重复执行不会重复添加路径，仅覆盖
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.resolve(__dirname, '..', 'docs', 'openapi.json');

if (!fs.existsSync(openapiPath)) {
    console.error(`[错误] OpenAPI 文档不存在: ${openapiPath}`);
    process.exit(1);
}

// 读取现有文档
const doc = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
console.log(`[信息] 已加载 OpenAPI 文档，当前路径数: ${Object.keys(doc.paths || {}).length}`);

// 1. 添加标签
if (!Array.isArray(doc.tags)) doc.tags = [];
const existingTagNames = new Set(doc.tags.map(t => t.name));

if (!existingTagNames.has('Meditation')) {
    doc.tags.push({
        name: 'Meditation',
        description: '静思悟道系统 - 第三阶段新增：玩家通过静思悟道积累感悟值，破除境界瓶颈'
    });
    console.log('[信息] 已添加 Meditation 标签');
}

if (!existingTagNames.has('管理员-悟道瓶颈')) {
    doc.tags.push({
        name: '管理员-悟道瓶颈',
        description: 'GM 后台悟道与瓶颈管理 - 玩家悟道状态查询、强制结算/中断、瓶颈修改与重置'
    });
    console.log('[信息] 已添加 管理员-悟道瓶颈 标签');
}

// 安全方案引用
const securityBearer = [{ bearerAuth: [] }];

// 2. 定义新接口
const newPaths = {
    // ===== 玩家端：悟道接口 =====
    '/api/meditation/start': {
        post: {
            tags: ['Meditation'],
            summary: '开始静思悟道',
            description: '玩家选择时长类型开始静思悟道。时长类型：short=静思一刻(60s) / medium=凝神悟道(5min) / long=闭关参悟(30min) / deep=深度悟道(1h，需瓶颈期)。深度悟道需筑基期以上且处于瓶颈期方可进行。所有玩家均与闭关/战斗/历练/移动/封禁状态互斥。',
            security: securityBearer,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['duration_type'],
                            properties: {
                                duration_type: {
                                    type: 'string',
                                    enum: ['short', 'medium', 'long', 'deep'],
                                    description: '悟道时长类型'
                                }
                            }
                        },
                        example: { duration_type: 'medium' }
                    }
                }
            },
            responses: {
                '200': {
                    description: '悟道开始成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '已进入凝神悟道状态',
                                data: {
                                    mode: 'medium',
                                    duration: 300,
                                    start_time: '2026-07-05T10:00:00.000Z',
                                    end_time: '2026-07-05T10:05:00.000Z',
                                    insight: 0,
                                    message: '已进入凝神悟道状态'
                                }
                            }
                        }
                    }
                },
                '400': {
                    description: '参数错误 / 状态互斥 / 次数用尽 / 冷却中',
                    content: {
                        'application/json': {
                            example: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '当前处于闭关中，无法开始悟道' }
                        }
                    }
                },
                '401': {
                    description: '未授权',
                    content: {
                        'application/json': {
                            example: { code: 401, message: '未授权，请先登录' }
                        }
                    }
                }
            }
        }
    },

    '/api/meditation/interrupt': {
        post: {
            tags: ['Meditation'],
            summary: '主动中断悟道（带惩罚）',
            description: '玩家主动中断当前悟道。中断时仅按完成度比例发放感悟值，普通悟道损失 30%，深度悟道损失 50%。完成度越高，损失越小。已积累的感悟值仍会按比例累加到瓶颈进度。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '中断成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '悟道已中断，获得感悟 12 点',
                                data: {
                                    mode: 'medium',
                                    elapsed: 180,
                                    duration: 300,
                                    completion_rate: 0.6,
                                    insight_gain: 12,
                                    exp_gain: '1500',
                                    bottleneck_broken: false
                                }
                            }
                        }
                    }
                },
                '400': {
                    description: '当前未在悟道中',
                    content: {
                        'application/json': {
                            example: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '当前未在悟道中' }
                        }
                    }
                }
            }
        }
    },

    '/api/meditation/status': {
        get: {
            tags: ['Meditation'],
            summary: '查询悟道状态与瓶颈进度',
            description: '获取玩家当前悟道状态（是否悟道中、模式、剩余时间、感悟值）和瓶颈系统状态（瓶颈状态、感悟进度、阈值、失败次数）。前端据此渲染 MeditationPanel 和 MeditationOverlay。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '悟道状态',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    is_meditating: true,
                                    meditation_mode: 'medium',
                                    meditation_start_time: '2026-07-05T10:00:00.000Z',
                                    meditation_end_time: '2026-07-05T10:05:00.000Z',
                                    meditation_duration: 300,
                                    meditation_insight: 15,
                                    daily_meditation_count: 3,
                                    daily_deep_meditation_count: 0,
                                    last_meditation_time: '2026-07-05T09:30:00.000Z',
                                    cooldown_remaining: 0,
                                    server_time: 1751700000000,
                                    bottleneck: {
                                        state: 'active',
                                        insight: 50,
                                        threshold: 100,
                                        failure_count: 1,
                                        realm_rank: 10,
                                        started_at: '2026-07-04T15:00:00.000Z'
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },

    '/api/meditation/config': {
        get: {
            tags: ['Meditation'],
            summary: '查询悟道配置（供前端展示）',
            description: '返回玩家可见的悟道配置，包括时长类型、深度悟道、每日次数上限、冷却时间、瓶颈系统参数。前端 MeditationPanel 据此渲染时长选择卡片。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '悟道配置',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    duration_types: {
                                        short: { duration: 60, insight_base: 5, insight_random: 3, exp_reward_rate: 0.01, label: '静思一刻' },
                                        medium: { duration: 300, insight_base: 20, insight_random: 8, exp_reward_rate: 0.02, label: '凝神悟道' },
                                        long: { duration: 1800, insight_base: 80, insight_random: 20, exp_reward_rate: 0.03, label: '闭关参悟' }
                                    },
                                    deep: {
                                        enabled: true,
                                        duration: 3600,
                                        insight_base: 200,
                                        insight_random: 50,
                                        exp_reward_rate: 0.05,
                                        min_realm_rank: 11,
                                        label: '深度悟道'
                                    },
                                    daily_normal_limit: 10,
                                    daily_deep_limit: 2,
                                    cooldown_seconds: 30,
                                    bottleneck: {
                                        enabled: true,
                                        bottleneck_realms: [10, 13, 17, 21],
                                        max_failure_count: 3,
                                        broken_breakthrough_bonus: 30
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },

    // ===== GM 后台：悟道与瓶颈管理接口 =====
    '/api/admin/meditation/metrics': {
        get: {
            tags: ['管理员-悟道瓶颈'],
            summary: '获取悟道与瓶颈系统统计指标',
            description: 'GM 后台统计：当前悟道中玩家数、瓶颈状态分布（none/active/broken/failed）、各境界瓶颈玩家分布、瓶颈系统配置参数。用于 GM 后台首页指标卡片展示。',
            security: securityBearer,
            responses: {
                '200': {
                    description: '统计指标',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    meditation: {
                                        meditating_count: 2,
                                        daily_normal_limit: 10,
                                        daily_deep_limit: 2,
                                        cooldown_seconds: 30
                                    },
                                    bottleneck: {
                                        enabled: true,
                                        bottleneck_realms: [10, 13, 17, 21],
                                        max_failure_count: 3,
                                        broken_bonus: 30,
                                        state_distribution: { none: 11, active: 1, broken: 0, failed: 0 },
                                        by_realm: [{ realm_rank: 10, count: 1 }]
                                    }
                                }
                            }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' }
            }
        }
    },

    '/api/admin/meditation/list': {
        get: {
            tags: ['管理员-悟道瓶颈'],
            summary: '分页查询悟道/瓶颈玩家',
            description: 'GM 后台分页查询所有正在悟道或处于瓶颈期的玩家。支持 filter=all/meditating/bottleneck 三种筛选模式。',
            security: securityBearer,
            parameters: [
                {
                    name: 'filter',
                    in: 'query',
                    schema: { type: 'string', enum: ['all', 'meditating', 'bottleneck'], default: 'all' },
                    description: '筛选类型'
                },
                {
                    name: 'page',
                    in: 'query',
                    schema: { type: 'integer', default: 1 },
                    description: '页码'
                },
                {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', default: 20, maximum: 100 },
                    description: '每页条数（最大100）'
                }
            ],
            responses: {
                '200': {
                    description: '玩家列表',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    list: [
                                        {
                                            id: 1,
                                            nickname: '韩天尊',
                                            realm: '炼气10层',
                                            realm_rank: 10,
                                            is_meditating: true,
                                            meditation_mode: 'medium',
                                            meditation_start_time: '2026-07-05T10:00:00.000Z',
                                            meditation_end_time: '2026-07-05T10:05:00.000Z',
                                            meditation_duration: 300,
                                            bottleneck_state: 'active',
                                            bottleneck_realm_rank: 10,
                                            bottleneck_insight: 50,
                                            bottleneck_threshold: 100,
                                            bottleneck_started_at: '2026-07-04T15:00:00.000Z',
                                            breakthrough_failure_count: 1,
                                            last_meditation_time: '2026-07-05T09:30:00.000Z',
                                            daily_meditation_count: 3,
                                            daily_deep_meditation_count: 0
                                        }
                                    ],
                                    total: 1,
                                    page: 1,
                                    pageSize: 20
                                }
                            }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' }
            }
        }
    },

    '/api/admin/meditation/{playerId}': {
        get: {
            tags: ['管理员-悟道瓶颈'],
            summary: '查询指定玩家的悟道状态与瓶颈详情',
            description: 'GM 后台查询指定玩家完整悟道信息，包括修为、灵石、悟道感悟值、瓶颈进度等。',
            security: securityBearer,
            parameters: [
                {
                    name: 'playerId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer' },
                    description: '玩家ID'
                }
            ],
            responses: {
                '200': {
                    description: '玩家悟道详情',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                data: {
                                    id: 1,
                                    nickname: '韩天尊',
                                    realm: '炼气10层',
                                    realm_rank: 10,
                                    exp: '1250000',
                                    spirit_stones: 5000,
                                    is_meditating: false,
                                    meditation_mode: null,
                                    meditation_insight: 0,
                                    daily_meditation_count: 3,
                                    daily_deep_meditation_count: 0,
                                    bottleneck_state: 'active',
                                    bottleneck_realm_rank: 10,
                                    bottleneck_insight: 50,
                                    bottleneck_threshold: 100,
                                    breakthrough_failure_count: 1
                                }
                            }
                        }
                    }
                },
                '400': { description: 'playerId 参数无效' },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '404': { description: '玩家不存在' }
            }
        }
    },

    '/api/admin/meditation/{playerId}/force-settle': {
        post: {
            tags: ['管理员-悟道瓶颈'],
            summary: '强制结算玩家悟道（无惩罚）',
            description: 'GM 强制结算玩家当前悟道，相当于悟道自动到期，无任何惩罚。用于玩家反馈卡死、客服补偿等场景。',
            security: securityBearer,
            parameters: [
                {
                    name: 'playerId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer' },
                    description: '玩家ID'
                }
            ],
            responses: {
                '200': {
                    description: '强制结算成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '悟道已强制结算',
                                data: {
                                    mode: 'medium',
                                    elapsed: 300,
                                    duration: 300,
                                    completion_rate: 1.0,
                                    insight_gain: 25,
                                    exp_gain: '2500',
                                    bottleneck_broken: true
                                }
                            }
                        }
                    }
                },
                '400': { description: '该玩家当前未在悟道中' },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '404': { description: '玩家不存在' }
            }
        }
    },

    '/api/admin/meditation/{playerId}/force-interrupt': {
        post: {
            tags: ['管理员-悟道瓶颈'],
            summary: '强制中断玩家悟道（带惩罚）',
            description: 'GM 强制中断玩家当前悟道，按完成度比例发放感悟值（普通悟道损失 30%，深度悟道损失 50%）。用于玩家违规、误操作等场景。',
            security: securityBearer,
            parameters: [
                {
                    name: 'playerId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer' },
                    description: '玩家ID'
                }
            ],
            responses: {
                '200': {
                    description: '强制中断成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '悟道已强制中断（带惩罚）',
                                data: {
                                    mode: 'medium',
                                    elapsed: 180,
                                    duration: 300,
                                    completion_rate: 0.6,
                                    insight_gain: 12,
                                    exp_gain: '1500',
                                    bottleneck_broken: false
                                }
                            }
                        }
                    }
                },
                '400': { description: '当前未在悟道中' },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' }
            }
        }
    },

    '/api/admin/meditation/{playerId}/bottleneck': {
        put: {
            tags: ['管理员-悟道瓶颈'],
            summary: '修改玩家瓶颈状态（用于测试和补偿）',
            description: 'GM 修改玩家瓶颈字段。可修改 bottleneck_state/insight/threshold/failure_count。状态设为 none 时会自动清零所有瓶颈字段。用于测试、补偿、修复卡死状态。',
            security: securityBearer,
            parameters: [
                {
                    name: 'playerId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer' },
                    description: '玩家ID'
                }
            ],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                bottleneck_state: {
                                    type: 'string',
                                    enum: ['none', 'active', 'broken', 'failed'],
                                    description: '瓶颈状态'
                                },
                                bottleneck_insight: {
                                    type: 'integer',
                                    minimum: 0,
                                    description: '瓶颈感悟值（0 ~ threshold）'
                                },
                                bottleneck_threshold: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '瓶颈阈值'
                                },
                                breakthrough_failure_count: {
                                    type: 'integer',
                                    minimum: 0,
                                    description: '突破失败次数'
                                }
                            }
                        },
                        example: {
                            bottleneck_state: 'active',
                            bottleneck_insight: 80,
                            bottleneck_threshold: 100,
                            breakthrough_failure_count: 2
                        }
                    }
                }
            },
            responses: {
                '200': {
                    description: '修改成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '瓶颈状态已更新',
                                data: {
                                    id: 1,
                                    nickname: '韩天尊',
                                    bottleneck_state: 'active',
                                    bottleneck_insight: 80,
                                    bottleneck_threshold: 100,
                                    breakthrough_failure_count: 2
                                }
                            }
                        }
                    }
                },
                '400': { description: 'bottleneck_state 无效' },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '404': { description: '玩家不存在' }
            }
        }
    },

    '/api/admin/meditation/{playerId}/bottleneck/reset': {
        post: {
            tags: ['管理员-悟道瓶颈'],
            summary: '重置玩家瓶颈状态（清空所有瓶颈字段）',
            description: 'GM 重置玩家所有瓶颈字段：状态归 none、感悟值清零、阈值恢复 100、失败次数清零。用于玩家卡死、补偿、测试后还原等场景。',
            security: securityBearer,
            parameters: [
                {
                    name: 'playerId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer' },
                    description: '玩家ID'
                }
            ],
            responses: {
                '200': {
                    description: '重置成功',
                    content: {
                        'application/json': {
                            example: {
                                code: 200,
                                message: '瓶颈状态已重置',
                                data: {
                                    id: 1,
                                    nickname: '韩天尊',
                                    bottleneck_state: 'none'
                                }
                            }
                        }
                    }
                },
                '401': { description: '未授权' },
                '403': { description: '权限不足（需要管理员权限）' },
                '404': { description: '玩家不存在' }
            }
        }
    }
};

// 3. 合并新接口到 paths
if (!doc.paths) doc.paths = {};
let addedCount = 0;
let updatedCount = 0;
for (const [pathKey, pathDef] of Object.entries(newPaths)) {
    if (doc.paths[pathKey]) {
        updatedCount++;
    } else {
        addedCount++;
    }
    doc.paths[pathKey] = pathDef;
}

console.log(`[信息] 已添加 ${addedCount} 个新路径，更新 ${updatedCount} 个已有路径`);

// 4. 更新 /api/breakthrough/info 和 /api/breakthrough/try 的描述（瓶颈系统集成）
if (doc.paths['/api/breakthrough/info']) {
    const getInfo = doc.paths['/api/breakthrough/info'].get;
    if (getInfo) {
        getInfo.description = '获取玩家当前突破信息：当前境界、下一境界、修为进度、突破成功率、属性增益。第三阶段新增瓶颈系统信息：瓶颈状态、感悟进度、阈值、失败次数、破除加成。前端 BreakthroughPortal 据此渲染突破按钮与瓶颈进度条。';
        // 在响应示例中加入 bottleneck 字段
        try {
            const okResponse = getInfo.responses?.['200'];
            if (okResponse?.content?.['application/json']?.examples) {
                // 已有 examples 时不强制覆盖
            } else if (okResponse?.content?.['application/json']) {
                okResponse.content['application/json'].example = {
                    code: 200,
                    data: {
                        current_realm: { name: '炼气10层', rank: 10 },
                        next_realm: { name: '筑基初期', rank: 11 },
                        current_exp: '1250000',
                        exp_cap: '1500000',
                        can_breakthrough: true,
                        breakthrough_probability: 65,
                        attribute_gain: { hp_max: 200, mp_max: 100, atk: 30, def: 20 },
                        bottleneck: {
                            enabled: true,
                            state: 'active',
                            in_bottleneck_realm: true,
                            insight: 50,
                            threshold: 100,
                            failure_count: 1,
                            max_failure_count: 3,
                            broken_bonus: 0,
                            started_at: '2026-07-04T15:00:00.000Z'
                        }
                    }
                };
            }
        } catch (e) {
            console.warn('[警告] 更新 /api/breakthrough/info 响应示例失败:', e.message);
        }
        console.log('[信息] 已更新 /api/breakthrough/info 描述（瓶颈系统集成）');
    }
}

if (doc.paths['/api/breakthrough/try']?.post) {
    const tryPost = doc.paths['/api/breakthrough/try'].post;
    tryPost.description = '尝试境界突破。第三阶段集成瓶颈系统：1. 触发瓶颈（瓶颈境界首次突破时拒绝并要求悟道） 2. 瓶颈未破除时拒绝突破 3. 瓶颈已破除时提供 +30% 成功率加成 4. 突破失败累加失败次数和感悟补偿 5. 突破成功清理瓶颈状态';
    console.log('[信息] 已更新 /api/breakthrough/try 描述（瓶颈系统集成）');
}

// 5. 写回文件
const output = JSON.stringify(doc, null, 2);
fs.writeFileSync(openapiPath, output, 'utf8');

console.log(`[完成] OpenAPI 文档已更新，当前路径总数: ${Object.keys(doc.paths).length}`);
console.log(`[完成] 标签总数: ${doc.tags.length}`);
