/**
 * OpenAPI 文档补丁脚本：GM 灵兽系统管理
 *
 * 作用：向 docs/openapi.json 注入 9 个 GM 灵兽管理接口定义：
 *   1. GET    /api/admin/spirit-beast/stats
 *   2. GET    /api/admin/spirit-beast/beasts
 *   3. GET    /api/admin/spirit-beast/beasts/{beastId}
 *   4. GET    /api/admin/spirit-beast/players/{playerId}/beasts
 *   5. POST   /api/admin/spirit-beast/give
 *   6. PUT    /api/admin/spirit-beast/beasts/{beastId}
 *   7. DELETE /api/admin/spirit-beast/beasts/{beastId}
 *   8. POST   /api/admin/spirit-beast/beasts/{beastId}/set-active
 *   9. POST   /api/admin/spirit-beast/beasts/{beastId}/reset-cooldowns
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（如已存在则跳过）
 *   - 在 paths 对象中追加 9 个新路径（幂等：已存在则跳过）
 *   - 在 components.schemas 中追加灵兽管理相关响应 Schema
 *
 * 运行方式：node server/scripts/openapi_patch_admin_spirit_beast.js
 * 幂等性：可重复执行，不会产生重复定义
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 目标文件路径（项目根目录下的 docs/openapi.json）
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// ==================== 新增 Tag 定义 ====================
const NEW_TAGS = [
    {
        name: '灵兽系统GM管理',
        description: '批次2 GM 后台 - 灵兽系统统计/分页查询/详情/玩家灵兽/发放/修改/删除/强制出战/重置冷却'
    }
];

// ==================== 通用响应 Schema 片段 ====================
const securityResponses = (description) => ({
    200: {
        description: description,
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 200 },
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
    403: {
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
    },
    404: {
        description: '资源不存在',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 404 },
                        error_code: { type: 'string' },
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
});

// 通用的 security 要求（需要 bearer token）
const securityRequirement = [{ bearerAuth: [] }];

// ==================== 9 个新接口定义 ====================
const NEW_PATHS = {
    // ---------- 查询类接口 ----------
    '/api/admin/spirit-beast/stats': {
        get: {
            summary: 'GM 获取灵兽系统全局统计',
            description: '获取灵兽系统全局统计指标，包括：总灵兽数、出战灵兽数、拥有灵兽的玩家数、今日新增捕获数、按稀有度/元素/种类的分布、灵兽数量 Top10 玩家。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            responses: securityResponses('灵兽系统全局统计数据')
        }
    },
    '/api/admin/spirit-beast/beasts': {
        get: {
            summary: 'GM 分页查询所有灵兽（多条件过滤）',
            description: '分页查询所有灵兽实例，支持按 player_id/beast_key/rarity/element/is_active/keyword 多条件过滤。返回的灵兽数据中包含玩家昵称与境界。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 }, description: '页码，从1开始' },
                { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, description: '每页数量' },
                { name: 'player_id', in: 'query', schema: { type: 'integer' }, description: '按玩家ID精确过滤' },
                { name: 'beast_key', in: 'query', schema: { type: 'string' }, description: '按灵兽种类key过滤（如 qingyun_wolf）' },
                { name: 'rarity', in: 'query', schema: { type: 'string', enum: ['common', 'rare', 'epic', 'legendary'] }, description: '按稀有度过滤' },
                { name: 'element', in: 'query', schema: { type: 'string', enum: ['metal', 'wood', 'water', 'fire', 'earth'] }, description: '按元素属性过滤' },
                { name: 'is_active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: '按出战状态过滤' },
                { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '按 beast_name 模糊搜索' }
            ],
            responses: securityResponses('灵兽分页列表（含 total/page/limit/beasts[]）')
        }
    },
    '/api/admin/spirit-beast/beasts/{beastId}': {
        get: {
            summary: 'GM 获取灵兽详情',
            description: '获取指定灵兽的完整信息（含玩家昵称/境界）。灵兽不存在返回 404。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'beastId', in: 'path', required: true, schema: { type: 'integer' }, description: '灵兽实例ID' }
            ],
            responses: securityResponses('灵兽详情（含玩家信息）')
        },
        put: {
            summary: 'GM 修改灵兽属性',
            description: '修改灵兽属性。支持修改：beast_name/star_level/level/exp/loyalty/atk/def/hp_max/speed/is_active。可选 recalculate=true 按公式重算属性。事务+行级锁保证唯一出战。操作审计。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'beastId', in: 'path', required: true, schema: { type: 'integer' }, description: '灵兽实例ID' }
            ],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                beast_name: { type: 'string', nullable: true, description: '自定义昵称，null 表示清空使用默认名' },
                                star_level: { type: 'integer', minimum: 1, maximum: 10, description: '星级' },
                                level: { type: 'integer', minimum: 1, maximum: 100, description: '等级' },
                                exp: { type: 'string', description: '经验值（BIGINT 字符串）' },
                                loyalty: { type: 'integer', minimum: 0, maximum: 100, description: '忠诚度' },
                                atk: { type: 'integer', minimum: 0, description: '攻击' },
                                def: { type: 'integer', minimum: 0, description: '防御' },
                                hp_max: { type: 'string', description: '气血上限（BIGINT 字符串）' },
                                speed: { type: 'integer', minimum: 0, description: '速度' },
                                is_active: { type: 'boolean', description: '是否出战（设为 true 会自动取消该玩家其他出战灵兽）' },
                                recalculate: { type: 'boolean', default: false, description: '是否按 base × (1 + (level-1)×0.1) × star_level 重算属性' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('更新后的灵兽详情')
        },
        delete: {
            summary: 'GM 删除灵兽',
            description: '物理删除灵兽实例（GM 介入，不返还灵石，与玩家放生不同）。删除后再次查询返回 404。操作审计。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'beastId', in: 'path', required: true, schema: { type: 'integer' }, description: '灵兽实例ID' },
                { name: 'reason', in: 'query', schema: { type: 'string' }, description: '删除原因（可选，记录审计日志）' }
            ],
            responses: securityResponses('删除结果（beast_id + deleted=true）')
        }
    },
    '/api/admin/spirit-beast/players/{playerId}/beasts': {
        get: {
            summary: 'GM 查询指定玩家全部灵兽',
            description: '查询指定玩家的所有灵兽（按出战 > 星级 > 等级 > 捕获时间排序）。同时返回玩家信息。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家ID' }
            ],
            responses: securityResponses('玩家信息 + 灵兽数组')
        }
    },
    '/api/admin/spirit-beast/give': {
        post: {
            summary: 'GM 直接发放灵兽',
            description: 'GM 直接给玩家发放灵兽，绕过捕获概率/灵力消耗/境界限制/捕获次数等玩家侧校验。属性按 base × (1 + (level-1)×0.1) × star_level 公式自动计算。若设为出战，会自动取消该玩家其他出战灵兽。操作审计。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'beast_key'],
                            properties: {
                                player_id: { type: 'integer', description: '目标玩家ID' },
                                beast_key: { type: 'string', description: '灵兽种类key（如 qingyun_wolf/huoyan_lion/bingpo_fox/tenglong_snake）' },
                                star_level: { type: 'integer', minimum: 1, maximum: 10, default: 1, description: '初始星级' },
                                level: { type: 'integer', minimum: 1, maximum: 100, default: 1, description: '初始等级' },
                                loyalty: { type: 'integer', minimum: 0, maximum: 100, default: 50, description: '初始忠诚度' },
                                is_active: { type: 'boolean', default: false, description: '是否立即出战' },
                                beast_name: { type: 'string', description: '自定义昵称（可选）' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('新创建的灵兽详情')
        }
    },
    '/api/admin/spirit-beast/beasts/{beastId}/set-active': {
        post: {
            summary: 'GM 强制设置灵兽出战状态',
            description: '强制设置灵兽出战状态（GM 介入，绕过玩家侧冷却/状态校验）。设为出战时会自动取消该玩家其他出战灵兽，保证同时仅 1 只出战。操作审计。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'beastId', in: 'path', required: true, schema: { type: 'integer' }, description: '灵兽实例ID' }
            ],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                active: { type: 'boolean', default: true, description: 'true=设为出战，false=取消出战' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('操作结果（beast_id + is_active）')
        }
    },
    '/api/admin/spirit-beast/beasts/{beastId}/reset-cooldowns': {
        post: {
            summary: 'GM 重置灵兽冷却时间',
            description: '重置灵兽的喂养/互动冷却时间（last_feed_time / last_interact_time 置 null）。操作审计。',
            tags: ['灵兽系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'beastId', in: 'path', required: true, schema: { type: 'integer' }, description: '灵兽实例ID' }
            ],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['feed', 'interact', 'all'], default: 'all', description: '重置类型' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('重置结果（beast_id + reset_type + 重置后的时间字段）')
        }
    }
};

// ==================== 主流程 ====================
console.log('[openapi_patch_admin_spirit_beast] 开始更新 docs/openapi.json');

// 1. 读取原文件
const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
const spec = JSON.parse(rawContent);
console.log('[openapi_patch_admin_spirit_beast] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
        console.log(`[openapi_patch_admin_spirit_beast] 已追加 tag: ${tag.name}`);
    } else {
        console.log(`[openapi_patch_admin_spirit_beast] tag 已存在，跳过: ${tag.name}`);
    }
}

// 3. 追加 paths（幂等：跳过已存在的）
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
                console.log(`[openapi_patch_admin_spirit_beast] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
            } else {
                skippedPaths++;
                console.log(`[openapi_patch_admin_spirit_beast] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
            }
        }
    } else {
        // 路径不存在，整体追加
        spec.paths[pathKey] = methods;
        addedPaths += Object.keys(methods).length;
        console.log(`[openapi_patch_admin_spirit_beast] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
    }
}

// 4. 写回文件（4 空格缩进，保留中文可读性）
const output = JSON.stringify(spec, null, 4);
fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

console.log('\n[openapi_patch_admin_spirit_beast] 更新完成！');
console.log(`  - 新增 tags: ${addedTags} 个`);
console.log(`  - 新增 paths: ${addedPaths} 个方法`);
console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
