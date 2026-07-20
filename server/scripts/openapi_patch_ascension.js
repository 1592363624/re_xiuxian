/**
 * OpenAPI 文档补丁脚本：飞升 + 夺舍重生系统
 *
 * 作用：向 docs/openapi.json 注入批次3新增的 20 个接口定义：
 *   玩家接口 11 个（8 个飞升 + 3 个夺舍）
 *   GM 接口 9 个（6 个飞升管理 + 3 个夺舍目标 CRUD）
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 2 个新 tag
 *   - 在 paths 对象中追加 20 个新路径（若已存在则跳过，保证幂等）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_ascension.js
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
        name: '飞升+夺舍重生系统',
        description: '批次3 高阶玩法 - 飞升灵界（问道/法相天地/探寻裂缝/空间节点/飞升/天机回溯）+ 夺舍重生（触发/选定/记录）'
    },
    {
        name: '飞升+夺舍重生系统GM管理',
        description: '批次3 GM 后台 - 飞升系统统计/玩家进度/大衍诀调整/法则碎片发放/坐标发放/重置冷却 + 夺舍目标 CRUD'
    }
];

// ==================== 安全响应 Schema 片段 ====================
// 通用的业务响应包装，引用既有的 schema 名，避免重复定义
const securityResponses = (description) => ({
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

// ==================== 20 个新接口定义 ====================
const NEW_PATHS = {
    // ---------- 玩家接口：飞升（8 个） ----------
    '/api/ascension/profile': {
        get: {
            summary: '获取飞升面板数据',
            description: '获取玩家飞升进度、大衍诀、空间节点列表、问道感悟、法相等级、成功率预估、前置条件检查结果。该接口为只读操作，不需要状态机互斥校验。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            responses: securityResponses('飞升面板数据')
        }
    },
    '/api/ascension/search-node': {
        post: {
            summary: '搜寻空间节点',
            description: '搜寻空间节点（CD 1 小时，从 node_pool 加权随机抽取）。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('搜寻节点结果（是否发现、节点信息、CD 剩余）')
        }
    },
    '/api/ascension/stabilize-node': {
        post: {
            summary: '定星稳固节点',
            description: '定星稳固节点（消耗神识+灵石，稳固 30 分钟后获得奖励）。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['node_id'],
                            properties: {
                                node_id: { type: 'integer', description: '节点ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('稳固结果（开始时间、结束时间、消耗）')
        }
    },
    '/api/ascension/ascend': {
        post: {
            summary: '飞升灵界',
            description: '飞升灵界（事务+行级锁保证原子性）。成功：飞升灵界（真仙境界）；失败：残魂-30、修为-10%、虚弱2小时。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('飞升结果（是否成功、新境界、残魂变化、虚弱时间）')
        }
    },
    '/api/ascension/revert': {
        post: {
            summary: '天机回溯',
            description: '天机回溯（每日1次，跨日重置，仅飞升失败后可用，回到飞升前状态）。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('回溯结果（是否成功、剩余次数）')
        }
    },
    '/api/ascension/ask-dao': {
        post: {
            summary: '向天道问道',
            description: '问道（化神后期可解锁，每日3次、CD 30分钟、消耗灵石、积累感悟值，10% 暴击双倍）。每 10 点感悟值提供 1% 飞升成功率加成（上限 20%）。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('问道结果（感悟值变化、暴击、CD 剩余）')
        }
    },
    '/api/ascension/dharma-form': {
        post: {
            summary: '修炼法相天地',
            description: '修炼法相天地（9 级数值表，每级 5% 全属性加成 + 2% 飞升成功率加成，消耗问道感悟+灵石，失败返还 30% 灵石）。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('修炼结果（新等级、属性加成、消耗）')
        }
    },
    '/api/ascension/explore-fracture': {
        post: {
            summary: '探寻虚空裂缝',
            description: '探寻裂缝（元婴初期可探寻，每日5次、CD 10分钟、消耗神识+灵石、15% 反噬概率，可能掉落法则碎片/丹方/灵乳）。无请求体参数。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } }
            },
            responses: securityResponses('探寻结果（是否发现、反噬伤害、掉落、法则碎片）')
        }
    },

    // ---------- 玩家接口：夺舍（3 个） ----------
    '/api/reincarnation/reborn': {
        post: {
            summary: '触发夺舍重生',
            description: '触发夺舍重生（飞升失败/寿命尽/PVP被杀时调用，推送 3 个目标按 weight 加权随机）。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['death_reason'],
                            properties: {
                                death_reason: {
                                    type: 'string',
                                    enum: ['lifespan_out', 'pvp_kill', 'breakthrough_fail', 'ascension_fail'],
                                    description: '死亡原因：lifespan_out=寿元耗尽，pvp_kill=PVP被杀，breakthrough_fail=突破失败，ascension_fail=飞升失败',
                                    example: 'ascension_fail'
                                }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('夺舍目标列表（3 个目标、超时秒数）')
        }
    },
    '/api/reincarnation/choose': {
        post: {
            summary: '选择夺舍目标',
            description: '选择夺舍目标（事务+行级锁，计算境界跌落、属性继承、残魂恢复至 50、72 小时冷却）。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_id'],
                            properties: {
                                target_id: { type: 'integer', description: '夺舍目标ID', example: 1 }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('夺舍结果（是否成功、新旧境界/修为、继承属性、冷却结束时间）')
        }
    },
    '/api/reincarnation/records': {
        get: {
            summary: '获取夺舍历史记录',
            description: '获取夺舍历史记录（分页查询）。',
            tags: ['飞升+夺舍重生系统'],
            security: securityRequirement,
            parameters: [
                { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 }, description: '页码' },
                { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 10, minimum: 1, maximum: 100 }, description: '每页条数' }
            ],
            responses: securityResponses('夺舍记录分页列表')
        }
    },

    // ---------- GM 接口：飞升管理（6 个） ----------
    '/api/admin/ascension/stats': {
        get: {
            summary: 'GM 获取飞升系统全局统计',
            description: '获取飞升系统全局统计：已飞升玩家总数、飞升尝试总次数、成功总次数、整体成功率、活跃空间节点数、状态分布。需要管理员权限，操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            responses: securityResponses('飞升系统全局统计')
        }
    },
    '/api/admin/ascension/players': {
        get: {
            summary: 'GM 获取玩家飞升进度列表',
            description: '查询玩家飞升进度列表（分页），按 is_ascended DESC + ascension_attempt_count DESC 排序。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 }, description: '页码' },
                { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, description: '每页条数' }
            ],
            responses: securityResponses('玩家飞升进度分页列表')
        }
    },
    '/api/admin/ascension/set-dayan-level': {
        post: {
            summary: 'GM 调整玩家大衍诀层数',
            description: 'GM 调整玩家大衍诀层数（0-5），用于测试或补偿。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
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
                                level: { type: 'integer', minimum: 0, maximum: 5, description: '大衍诀层数', example: 3 }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('调整结果')
        }
    },
    '/api/admin/ascension/give-law-fragment': {
        post: {
            summary: 'GM 发放法则碎片',
            description: 'GM 发放法则碎片给指定玩家（1-100），用于测试或补偿。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id', 'count'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 },
                                count: { type: 'integer', minimum: 1, maximum: 100, description: '法则碎片数量', example: 5 }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('发放结果')
        }
    },
    '/api/admin/ascension/give-coord': {
        post: {
            summary: 'GM 发放逆灵通道坐标',
            description: 'GM 发放逆灵通道坐标给指定玩家。coord 可选，未提供则自动随机生成。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['player_id'],
                            properties: {
                                player_id: { type: 'integer', description: '玩家ID', example: 1 },
                                coord: { type: 'string', nullable: true, description: '逆灵通道坐标（可选，未提供则随机生成）', example: 'N37.5_E121.3_Z0.7' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('发放结果（含生成的坐标）')
        }
    },
    '/api/admin/ascension/reset-cooldown': {
        post: {
            summary: 'GM 重置玩家飞升冷却',
            description: 'GM 重置玩家飞升冷却（虚弱、回溯、问道、探寻、节点搜寻 CD 全部清零），用于测试或补偿。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
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
            responses: securityResponses('重置结果')
        }
    },

    // ---------- GM 接口：夺舍目标 CRUD（3 个） ----------
    '/api/admin/ascension/targets': {
        get: {
            summary: 'GM 获取夺舍目标列表',
            description: '获取所有夺舍目标配置列表（含目标基础属性、继承比例、跌落数、风险等级、权重、稀有标记）。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            responses: securityResponses('夺舍目标列表')
        },
        post: {
            summary: 'GM 新增夺舍目标',
            description: '新增夺舍目标配置。target_key 必须唯一。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['target_key', 'target_name', 'target_type', 'realm_rank', 'risk_level'],
                            properties: {
                                target_key: { type: 'string', description: '目标唯一标识', example: 'mortal_young' },
                                target_name: { type: 'string', description: '目标名称', example: '凡人少年' },
                                target_type: { type: 'string', enum: ['mortal', 'cultivator', 'monster'], description: '目标类型', example: 'mortal' },
                                realm_rank: { type: 'integer', description: '境界排名', example: 0 },
                                base_atk: { type: 'integer', description: '基础攻击力', example: 10 },
                                base_def: { type: 'integer', description: '基础防御力', example: 5 },
                                base_hp_max: { type: 'integer', description: '基础HP上限', example: 100 },
                                base_speed: { type: 'integer', description: '基础速度', example: 10 },
                                base_sense: { type: 'integer', description: '基础神识', example: 10 },
                                spirit_root_grade: { type: 'string', nullable: true, description: '灵根等级（仅修士有）', example: '天灵根' },
                                talent_id: { type: 'string', nullable: true, description: '天赋ID（仅修士有）' },
                                inherit_ratio: { type: 'number', format: 'float', minimum: 0, maximum: 1, description: '修为继承比例（小数）', example: 0.3 },
                                drop_realm_count: { type: 'integer', minimum: 0, description: '境界跌落数（大境界）', example: 1 },
                                risk_level: { type: 'integer', enum: [1, 2, 3], description: '风险等级：1=低，2=中，3=高', example: 1 },
                                description: { type: 'string', description: '目标描述', example: '一名根骨尚可的凡人少年' },
                                weight: { type: 'integer', minimum: 1, description: '抽取权重', example: 100 },
                                is_rare: { type: 'boolean', default: false, description: '是否稀有目标', example: false }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('新增结果（含新目标ID）')
        }
    },
    '/api/admin/ascension/targets/{id}': {
        put: {
            summary: 'GM 编辑夺舍目标',
            description: '编辑夺舍目标配置。可更新字段：target_name / target_type / realm_rank / base_atk / base_def / base_hp_max / base_speed / base_sense / inherit_ratio / drop_realm_count / risk_level / description / weight / is_rare。操作审计。',
            tags: ['飞升+夺舍重生系统GM管理'],
            security: securityRequirement,
            parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '夺舍目标ID' }
            ],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                target_name: { type: 'string' },
                                target_type: { type: 'string', enum: ['mortal', 'cultivator', 'monster'] },
                                realm_rank: { type: 'integer' },
                                base_atk: { type: 'integer' },
                                base_def: { type: 'integer' },
                                base_hp_max: { type: 'integer' },
                                base_speed: { type: 'integer' },
                                base_sense: { type: 'integer' },
                                inherit_ratio: { type: 'number', format: 'float', minimum: 0, maximum: 1 },
                                drop_realm_count: { type: 'integer', minimum: 0 },
                                risk_level: { type: 'integer', enum: [1, 2, 3] },
                                description: { type: 'string' },
                                weight: { type: 'integer', minimum: 1 },
                                is_rare: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: securityResponses('编辑结果')
        }
    }
};

// ==================== 主流程 ====================
console.log('[openapi_patch_ascension] 开始更新 docs/openapi.json');

// 1. 读取原文件
const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
const spec = JSON.parse(rawContent);
console.log('[openapi_patch_ascension] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
        console.log(`[openapi_patch_ascension] 已追加 tag: ${tag.name}`);
    } else {
        console.log(`[openapi_patch_ascension] tag 已存在，跳过: ${tag.name}`);
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
                console.log(`[openapi_patch_ascension] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
            } else {
                skippedPaths++;
                console.log(`[openapi_patch_ascension] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
            }
        }
    } else {
        // 路径不存在，整体追加
        spec.paths[pathKey] = methods;
        addedPaths += Object.keys(methods).length;
        console.log(`[openapi_patch_ascension] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
    }
}

// 4. 写回文件（4 空格缩进，保留中文可读性）
const output = JSON.stringify(spec, null, 4);
fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

console.log('\n[openapi_patch_ascension] 更新完成！');
console.log(`  - 新增 tags: ${addedTags} 个`);
console.log(`  - 新增 paths: ${addedPaths} 个方法`);
console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
console.log(`  - 当前 tags 总数: ${spec.tags.length}`);