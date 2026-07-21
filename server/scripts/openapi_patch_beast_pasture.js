/**
 * OpenAPI 文档补丁脚本：灵兽放养与偷菜系统（玩法文档第8节 灵兽放养/偷菜）
 *
 * 作用：向 docs/openapi.json 注入灵兽放养与偷菜系统的 8 个接口定义：
 *   路由前缀 /api/spirit-beast/pasture，对应 server/routes/spirit_beast_pasture.js
 *     玩家端（auth 鉴权）：
 *       1. GET  /api/spirit-beast/pasture/locations       - 获取可用放养场所列表（按境界过滤）
 *       2. POST /api/spirit-beast/pasture/start            - 开始放养（标记灵兽 is_pasturing=true）
 *       3. POST /api/spirit-beast/pasture/recall           - 召回灵兽（提前0%/到期100%/超期80% 折扣）
 *       4. GET  /api/spirit-beast/pasture/status           - 获取当前放养状态（含剩余时间/偷菜次数）
 *       5. GET  /api/spirit-beast/pasture/history          - 获取放养历史（已结算的放养记录）
 *       6. POST /api/spirit-beast/pasture/steal            - 偷菜：放养灵兽偷其他玩家药园
 *       7. GET  /api/spirit-beast/pasture/steal-history    - 获取我偷别人历史
 *       8. GET  /api/spirit-beast/pasture/stolen-history   - 获取别人偷我历史
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（灵兽放养与偷菜系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则覆盖，便于重新生成）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_beast_pasture.js
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
        name: '灵兽放养与偷菜系统',
        description: '玩法文档第8节 - 灵兽放养/偷菜：异步多人经济PVP玩法。放养灵兽按时间收获资源（产物有折扣），可派遣放养中灵兽偷其他玩家药园的成熟作物，被偷方出战灵兽会尝试拦截（造成反伤+降低忠诚度）。'
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
    // 1. 获取放养场所列表
    '/api/spirit-beast/pasture/locations': {
        get: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '获取可用放养场所列表',
            description: '获取当前玩家可用的放养场所列表（按境界过滤）。返回场所详情、同时放养上限、最短/最长放养时长。',
            operationId: 'getBeastPastureLocations',
            security: bearerAuth,
            responses: securityResponses('放养场所列表', {
                type: 'object',
                properties: {
                    locations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', example: 'qingyun_mountain', description: '场所唯一键' },
                                name: { type: 'string', example: '青云山', description: '场所名称' },
                                description: { type: 'string', example: '灵气充沛的山脉，适合低阶灵兽觅食' },
                                min_realm_rank: { type: 'integer', example: 1, description: '最低境界rank要求' },
                                min_realm_name: { type: 'string', example: '凡人', description: '最低境界名称' },
                                yield_multiplier: { type: 'number', format: 'float', example: 1.0, description: '产物倍率' },
                                danger_level: { type: 'integer', example: 1, description: '危险等级（1-5）' },
                                possible_yields: {
                                    type: 'array',
                                    description: '可能获得的产物列表',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            item_id: { type: 'string', example: 'wild_herb' },
                                            name: { type: 'string', example: '灵草' },
                                            weight: { type: 'integer', example: 50 },
                                            min_qty: { type: 'integer', example: 1 },
                                            max_qty: { type: 'integer', example: 3 }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    max_concurrent_beasts: { type: 'integer', example: 3, description: '同时放养灵兽上限' },
                    min_duration_hours: { type: 'integer', example: 1, description: '最短放养时长（小时）' },
                    max_duration_hours: { type: 'integer', example: 8, description: '最长放养时长（小时）' }
                }
            })
        }
    },

    // 2. 开始放养
    '/api/spirit-beast/pasture/start': {
        post: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '开始放养',
            description: '将一只未出战、未放养中的灵兽派往指定场所放养。放养期间灵兽无法出战/喂养/互动，可被派遣偷菜。校验：灵兽归属、出战状态、放养数量上限、时长范围、境界要求。',
            operationId: 'startBeastPasture',
            security: bearerAuth,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['beast_id', 'location_key', 'duration_hours'],
                            properties: {
                                beast_id: { type: 'integer', example: 10, description: '灵兽ID' },
                                location_key: { type: 'string', example: 'qingyun_mountain', description: '场所键' },
                                duration_hours: { type: 'number', format: 'float', example: 4, description: '放养时长（小时，1~8）' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('开始放养结果', {
                type: 'object',
                properties: {
                    pasture_id: { type: 'integer', example: 9, description: '放养记录ID' },
                    beast_id: { type: 'integer', example: 10 },
                    beast_name: { type: 'string', example: '青云狼' },
                    location_key: { type: 'string', example: 'qingyun_mountain' },
                    location_name: { type: 'string', example: '青云山' },
                    start_time: { type: 'string', format: 'date-time' },
                    end_time: { type: 'string', format: 'date-time' },
                    duration_hours: { type: 'number', format: 'float', example: 4 }
                }
            })
        }
    },

    // 3. 召回灵兽
    '/api/spirit-beast/pasture/recall': {
        post: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '召回灵兽',
            description: '手动召回放养中的灵兽，根据到期情况应用不同产物折扣：early(提前召回,0%)/manual(正常召回,100%)/auto(超期召回,80%)。同时结算偷菜收获（若有）。',
            operationId: 'recallBeastPasture',
            security: bearerAuth,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['beast_id'],
                            properties: {
                                beast_id: { type: 'integer', example: 10, description: '灵兽ID' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('召回结果', {
                type: 'object',
                properties: {
                    pasture_id: { type: 'integer', example: 9 },
                    beast_id: { type: 'integer', example: 10 },
                    beast_name: { type: 'string', example: '青云狼' },
                    recall_type: { type: 'string', example: 'early', description: '召回类型：early/manual/auto' },
                    yield_discount: { type: 'number', format: 'float', example: 0.0, description: '产物折扣（0~1）' },
                    duration_hours: { type: 'number', format: 'float', example: 0.0, description: '实际放养时长（小时）' },
                    yields: {
                        type: 'array',
                        description: '放养结算产物列表（提前召回为空）',
                        items: {
                            type: 'object',
                            properties: {
                                item_id: { type: 'string', example: 'wild_herb' },
                                item_name: { type: 'string', example: '灵草' },
                                qty: { type: 'integer', example: 2 }
                            }
                        }
                    },
                    steal_count: { type: 'integer', example: 0, description: '本次放养期间偷菜次数' },
                    stolen_count: { type: 'integer', example: 0, description: '本次放养期间被偷次数' }
                }
            })
        }
    },

    // 4. 获取放养状态
    '/api/spirit-beast/pasture/status': {
        get: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '获取当前放养状态',
            description: '获取当前玩家所有活跃放养记录（含剩余秒数、是否到期、偷菜次数、被偷次数）。',
            operationId: 'getBeastPastureStatus',
            security: bearerAuth,
            responses: securityResponses('放养状态', {
                type: 'object',
                properties: {
                    active_pastures: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                pasture_id: { type: 'integer', example: 9 },
                                beast_id: { type: 'integer', example: 10 },
                                beast_name: { type: 'string', example: '青云狼' },
                                beast_key: { type: 'string', example: 'qingyun_wolf' },
                                location_key: { type: 'string', example: 'qingyun_mountain' },
                                location_name: { type: 'string', example: '青云山' },
                                start_time: { type: 'string', format: 'date-time' },
                                end_time: { type: 'string', format: 'date-time' },
                                remaining_seconds: { type: 'integer', example: 3599, description: '剩余秒数（已过期为0或负数）' },
                                is_expired: { type: 'boolean', example: false, description: '是否已到期' },
                                steal_count: { type: 'integer', example: 0, description: '本次放养偷菜次数' },
                                stolen_count: { type: 'integer', example: 0, description: '本次放养被偷次数' }
                            }
                        }
                    },
                    active_count: { type: 'integer', example: 1, description: '活跃放养数' },
                    max_concurrent: { type: 'integer', example: 3, description: '同时放养上限' }
                }
            })
        }
    },

    // 5. 获取放养历史
    '/api/spirit-beast/pasture/history': {
        get: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '获取放养历史',
            description: '获取当前玩家已结算的放养记录（按时间倒序），支持分页。',
            operationId: 'getBeastPastureHistory',
            security: bearerAuth,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '页码' },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 10 }, description: '每页条数（最大50）' }
            ],
            responses: securityResponses('放养历史', {
                type: 'object',
                properties: {
                    history: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                pasture_id: { type: 'integer', example: 9 },
                                beast_id: { type: 'integer', example: 10 },
                                beast_name: { type: 'string', example: '青云狼' },
                                location_key: { type: 'string', example: 'qingyun_mountain' },
                                location_name: { type: 'string', example: '青云山' },
                                start_time: { type: 'string', format: 'date-time' },
                                end_time: { type: 'string', format: 'date-time' },
                                settled_at: { type: 'string', format: 'date-time', nullable: true },
                                status: { type: 'string', example: 'recalled', description: '记录状态：active/recalled/auto_settled' },
                                recall_type: { type: 'string', example: 'early', description: '召回类型：early/manual/auto（null表示未召回）' },
                                yield_discount: { type: 'number', format: 'float', example: 0.0 },
                                duration_hours: { type: 'number', format: 'float', example: 0.0 },
                                steal_count: { type: 'integer', example: 0 },
                                stolen_count: { type: 'integer', example: 0 }
                            }
                        }
                    },
                    total: { type: 'integer', example: 5 },
                    page: { type: 'integer', example: 1 },
                    page_size: { type: 'integer', example: 10 }
                }
            })
        }
    },

    // 6. 偷菜
    '/api/spirit-beast/pasture/steal': {
        post: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '偷菜',
            description: '派遣放养中的灵兽偷取其他玩家药园的成熟作物。\n\n多人交互核心：\n- 偷菜方：放养中的灵兽（is_pasturing=true）\n- 被偷方：成熟地块（status=mature）\n- 护院：被偷方出战灵兽（is_active=true）会尝试拦截\n- 成功率：基础35% + 速度/忠诚度/星级加成 + 无护院加成30%\n- 拦截率：基础40% + 速度/忠诚度/星级加成\n- 冷却：同灵兽1h / 每日总计10次 / 同地块24h',
            operationId: 'stealCrops',
            security: bearerAuth,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['beast_id', 'target_player_id'],
                            properties: {
                                beast_id: { type: 'integer', example: 10, description: '灵兽ID（必须是放养中的灵兽）' },
                                target_player_id: { type: 'integer', example: 9, description: '被偷玩家ID' },
                                target_plot_index: { type: 'integer', nullable: true, example: 10, description: '目标地块索引（不传则随机选择成熟地块）' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('偷菜结果', {
                type: 'object',
                properties: {
                    result: { type: 'string', example: 'intercepted', description: '结果：success/intercepted/failed' },
                    stolen_qty: { type: 'integer', example: 0, description: '偷取数量' },
                    stolen_item: { type: 'string', nullable: true, example: 'wild_herb', description: '偷到的物品ID' },
                    stolen_item_name: { type: 'string', nullable: true, example: '灵草' },
                    target_player_id: { type: 'integer', example: 9 },
                    target_plot_index: { type: 'integer', example: 10 },
                    guard_beast_name: { type: 'string', nullable: true, example: '玄龟', description: '护院灵兽名称（无护院为null）' },
                    counter_damage: { type: 'number', example: 75, description: '被护院灵兽反伤血量（未拦截为0）' },
                    exp_gain: { type: 'number', example: 0, description: '灵兽获得经验（仅成功偷菜有）' },
                    loyalty_change: { type: 'number', example: -5, description: '灵兽忠诚度变化（被拦截/失败为负数）' },
                    beast_current_hp: { type: 'number', example: 1425, description: '灵兽当前血量' },
                    beast_current_loyalty: { type: 'number', example: 75, description: '灵兽当前忠诚度' },
                    cooldown_ends_at: { type: 'string', format: 'date-time', description: '该灵兽偷菜冷却结束时间' },
                    daily_steal_count: { type: 'integer', example: 1, description: '今日已偷菜次数' },
                    daily_steal_limit: { type: 'integer', example: 10, description: '每日偷菜上限' }
                }
            })
        }
    },

    // 7. 获取偷菜历史
    '/api/spirit-beast/pasture/steal-history': {
        get: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '获取我偷别人的历史',
            description: '获取当前玩家派遣灵兽偷其他玩家药园的历史记录（按时间倒序），支持分页。',
            operationId: 'getStealHistory',
            security: bearerAuth,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 10 } }
            ],
            responses: securityResponses('偷菜历史', {
                type: 'object',
                properties: {
                    history: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                log_id: { type: 'integer', example: 1 },
                                beast_id: { type: 'integer', example: 10 },
                                beast_name: { type: 'string', example: '青云狼' },
                                target_player_id: { type: 'integer', example: 9 },
                                target_player_nickname: { type: 'string', example: '玩家2' },
                                target_plot_index: { type: 'integer', example: 10 },
                                seed_id: { type: 'string', nullable: true, example: 'spirit_seed' },
                                produce_item_id: { type: 'string', nullable: true, example: 'wild_herb' },
                                stolen_qty: { type: 'integer', example: 0 },
                                result: { type: 'string', example: 'intercepted', description: '结果：success/intercepted/failed' },
                                guard_beast_name: { type: 'string', nullable: true, example: '玄龟' },
                                counter_damage: { type: 'number', example: 75 },
                                exp_gain: { type: 'number', example: 0 },
                                loyalty_change: { type: 'number', example: -5 },
                                created_at: { type: 'string', format: 'date-time' }
                            }
                        }
                    },
                    total: { type: 'integer', example: 1 },
                    page: { type: 'integer', example: 1 },
                    page_size: { type: 'integer', example: 10 }
                }
            })
        }
    },

    // 8. 获取被偷历史
    '/api/spirit-beast/pasture/stolen-history': {
        get: {
            tags: ['灵兽放养与偷菜系统'],
            summary: '获取别人偷我的历史',
            description: '获取其他玩家偷取当前玩家药园的历史记录（按时间倒序），支持分页。',
            operationId: 'getStolenHistory',
            security: bearerAuth,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                { name: 'page_size', in: 'query', schema: { type: 'integer', default: 10 } }
            ],
            responses: securityResponses('被偷历史', {
                type: 'object',
                properties: {
                    history: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                log_id: { type: 'integer', example: 1 },
                                thief_player_id: { type: 'integer', example: 1 },
                                thief_player_nickname: { type: 'string', example: '叶天帝' },
                                thief_beast_name: { type: 'string', example: '青云狼' },
                                target_plot_index: { type: 'integer', example: 10 },
                                seed_id: { type: 'string', nullable: true, example: 'spirit_seed' },
                                produce_item_id: { type: 'string', nullable: true, example: 'wild_herb' },
                                stolen_qty: { type: 'integer', example: 0 },
                                result: { type: 'string', example: 'intercepted' },
                                guard_beast_name: { type: 'string', nullable: true, example: '玄龟' },
                                counter_damage: { type: 'number', example: 75 },
                                created_at: { type: 'string', format: 'date-time' }
                            }
                        }
                    },
                    total: { type: 'integer', example: 0 },
                    page: { type: 'integer', example: 1 },
                    page_size: { type: 'integer', example: 10 }
                }
            })
        }
    }
};

// ==================== Schema 定义（可选，主要接口内联在 responses 中） ====================
const NEW_SCHEMAS = {};

// ==================== 主函数：合并补丁到 openapi.json ====================
function applyPatch() {
    // 读取现有 OpenAPI 文档
    const doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));

    // 1. 追加 tags（去重）
    if (!Array.isArray(doc.tags)) doc.tags = [];
    const existingTagNames = new Set(doc.tags.map(t => t.name));
    for (const tag of NEW_TAGS) {
        if (!existingTagNames.has(tag.name)) {
            doc.tags.push(tag);
            console.log(`[+] 追加 tag: ${tag.name}`);
        } else {
            // 已存在则更新
            const idx = doc.tags.findIndex(t => t.name === tag.name);
            doc.tags[idx] = tag;
            console.log(`[=] 更新 tag: ${tag.name}`);
        }
    }

    // 2. 追加 paths（path+method 相同则覆盖）
    if (!doc.paths) doc.paths = {};
    let addedPaths = 0, updatedPaths = 0;
    for (const [p, methods] of Object.entries(NEW_PATHS)) {
        if (!doc.paths[p]) {
            doc.paths[p] = {};
            addedPaths++;
        }
        for (const [method, def] of Object.entries(methods)) {
            if (doc.paths[p][method]) {
                updatedPaths++;
            } else {
                addedPaths++;
            }
            doc.paths[p][method] = def;
        }
    }
    console.log(`[+] paths: 新增 ${addedPaths} 个，更新 ${updatedPaths} 个`);

    // 3. 追加 schemas（去重，已存在则跳过）
    if (!doc.components) doc.components = {};
    if (!doc.components.schemas) doc.components.schemas = {};
    let addedSchemas = 0;
    for (const [name, schema] of Object.entries(NEW_SCHEMAS)) {
        if (!doc.components.schemas[name]) {
            doc.components.schemas[name] = schema;
            addedSchemas++;
        }
    }
    console.log(`[+] schemas: 新增 ${addedSchemas} 个`);

    // 4. 写回文件
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(doc, null, 2), 'utf8');

    // 5. 打印汇总
    console.log('\n========== OpenAPI 补丁完成 ==========');
    console.log(`总 paths: ${Object.keys(doc.paths).length}`);
    console.log(`总 tags: ${doc.tags.length}`);
    console.log(`总 schemas: ${Object.keys(doc.components.schemas).length}`);
    console.log('======================================');
}

// 执行补丁
try {
    applyPatch();
    console.log('\n✅ 灵兽放养与偷菜系统 OpenAPI 补丁应用成功');
} catch (e) {
    console.error('\n❌ 补丁应用失败:', e.message);
    console.error(e.stack);
    process.exit(1);
}
