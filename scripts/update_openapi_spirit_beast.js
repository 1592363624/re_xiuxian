/**
 * OpenAPI 文档更新脚本：注入灵兽系统接口定义
 *
 * 功能：
 *   1. 在 tags 数组中添加"灵兽系统"标签
 *   2. 在 paths 中添加 9 个灵兽系统接口
 *   3. 在 components.schemas 中添加 SpiritBeast 相关 schema
 *
 * 幂等性：若已存在 /api/spirit-beast/* 路径则跳过
 */
const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.json');

// 灵兽系统标签定义
const SPIRIT_BEAST_TAG = {
    name: '灵兽系统',
    description: '灵兽系统 - 4阶灵兽（青云狼/火焰狮/冰魄狐/腾蛇）+ 五行相克 + 捕获/喂养/互动/出战/放生/图鉴'
};

// 标准响应 Schema 片段（每个接口复用）
function standardResponses(successDesc, errorDesc = '业务/参数错误') {
    return {
        200: {
            description: successDesc,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            success: { type: 'boolean' },
                            message: { type: 'string' },
                            data: { type: 'object', nullable: true },
                            error_code: { type: 'string', nullable: true }
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
}

// 灵兽系统所有接口路径定义
const SPIRIT_BEAST_PATHS = {
    '/api/spirit-beast/types': {
        get: {
            summary: '获取所有灵兽种类（图鉴）',
            description: '返回配置中的全部灵兽种类（4阶：青云狼/火焰狮/冰魄狐/腾蛇）+ 玩家已捕获标记 + 五行/稀有度配置。该接口为只读操作。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            responses: standardResponses('灵兽种类列表（含玩家已捕获标记）')
        }
    },
    '/api/spirit-beast/list': {
        get: {
            summary: '获取我的灵兽列表',
            description: '返回玩家拥有的所有灵兽列表，按 出战 > 星级 > 等级 > 捕获时间 排序，包含统计信息。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            responses: standardResponses('灵兽列表 + 统计信息')
        }
    },
    '/api/spirit-beast/daily-status': {
        get: {
            summary: '获取今日捕获状态',
            description: '返回今日已捕获次数、每日上限、剩余次数、灵兽背包容量。注意：此路径需在 /:beastId 之前注册以避免路由冲突。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            responses: standardResponses('今日捕获次数/上限/剩余/灵兽背包容量')
        }
    },
    '/api/spirit-beast/{beastId}': {
        get: {
            summary: '获取灵兽详情',
            description: '返回单只灵兽的完整属性、战力、元素相克关系、冷却剩余秒数。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'beastId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer', minimum: 1 },
                    description: '灵兽实例ID'
                }
            ],
            responses: standardResponses('灵兽详情（属性/战力/相克/冷却）')
        }
    },
    '/api/spirit-beast/catch': {
        post: {
            summary: '寻觅/捕获灵兽',
            description: '按 catch_chance 概率捕获指定种类的灵兽。校验境界、每日次数（20次/日）、灵力消耗、背包容量（10只上限）。失败时返还 30% 灵力。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['beast_key'],
                            properties: {
                                beast_key: {
                                    type: 'string',
                                    enum: ['qingyun_wolf', 'huoyan_lion', 'bingpo_fox', 'tenglong_snake'],
                                    description: '灵兽种类key',
                                    example: 'qingyun_wolf'
                                }
                            }
                        }
                    }
                }
            },
            responses: standardResponses('捕获结果（caught/cost_mp/return_mp/today_count 等）')
        }
    },
    '/api/spirit-beast/{beastId}/feed': {
        post: {
            summary: '喂养灵兽',
            description: '消耗灵石（= level × 100），增加经验（feed_exp）和忠诚度（+5），1 小时冷却。可能触发升级。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'beastId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer', minimum: 1 },
                    description: '灵兽实例ID'
                }
            ],
            responses: standardResponses('喂养结果（exp_gain/loyalty_gain/level_up 等）')
        }
    },
    '/api/spirit-beast/{beastId}/interact': {
        post: {
            summary: '互动灵兽',
            description: '增加忠诚度（+2）和经验（+5），10 分钟冷却，无消耗。可能触发升级。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'beastId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer', minimum: 1 },
                    description: '灵兽实例ID'
                }
            ],
            responses: standardResponses('互动结果（exp_gain/loyalty_gain/level_up 等）')
        }
    },
    '/api/spirit-beast/{beastId}/set-active': {
        post: {
            summary: '设置出战灵兽',
            description: '同时仅允许 1 只灵兽出战，会自动取消该玩家其他灵兽的出战状态。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'beastId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer', minimum: 1 },
                    description: '灵兽实例ID'
                }
            ],
            responses: standardResponses('出战设置结果（beast_id/is_active）')
        }
    },
    '/api/spirit-beast/{beastId}/release': {
        post: {
            summary: '放生灵兽',
            description: '放生灵兽，按稀有度返还部分灵石（common 20% / rare 30% / epic 40% / legendary 50%），删除灵兽记录。此操作不可撤销。',
            tags: ['灵兽系统'],
            security: [{ bearerAuth: [] }],
            parameters: [
                {
                    name: 'beastId',
                    in: 'path',
                    required: true,
                    schema: { type: 'integer', minimum: 1 },
                    description: '灵兽实例ID'
                }
            ],
            responses: standardResponses('放生结果（return_spirit_stones/new_spirit_stones）')
        }
    }
};

// SpiritBeast 相关 Schema
const SPIRIT_BEAST_SCHEMAS = {
    SpiritBeast: {
        type: 'object',
        description: '灵兽实例（玩家拥有的一只灵兽完整信息）',
        properties: {
            id: { type: 'integer', description: '灵兽实例ID', example: 1 },
            player_id: { type: 'integer', description: '所属玩家ID', example: 1 },
            beast_key: { type: 'string', description: '灵兽种类key', example: 'qingyun_wolf' },
            beast_name: { type: 'string', nullable: true, description: '自定义昵称（null 时显示默认名）' },
            display_name: { type: 'string', description: '显示名（昵称或默认名）', example: '青云狼' },
            element: { type: 'string', description: '元素属性', enum: ['metal', 'wood', 'water', 'fire', 'earth'] },
            element_name: { type: 'string', description: '元素中文名', example: '金' },
            rarity: { type: 'string', description: '稀有度', enum: ['common', 'rare', 'epic', 'legendary'] },
            rarity_name: { type: 'string', description: '稀有度中文名', example: '凡品' },
            star_level: { type: 'integer', description: '星级（1-10）', example: 1 },
            level: { type: 'integer', description: '等级（1-100）', example: 1 },
            exp: { type: 'string', description: '当前经验（字符串避免 BigInt 精度问题）', example: '0' },
            hp_max: { type: 'string', description: '气血上限（字符串）', example: '500' },
            atk: { type: 'integer', description: '攻击', example: 80 },
            def: { type: 'integer', description: '防御', example: 50 },
            speed: { type: 'integer', description: '速度', example: 90 },
            loyalty: { type: 'integer', description: '忠诚度（0-100）', example: 50 },
            is_active: { type: 'boolean', description: '是否出战中', example: false },
            last_feed_time: { type: 'string', format: 'date-time', nullable: true, description: '最后喂养时间' },
            last_interact_time: { type: 'string', format: 'date-time', nullable: true, description: '最后互动时间' },
            caught_at: { type: 'string', format: 'date-time', nullable: true, description: '捕获时间' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' },
            description: { type: 'string', description: '灵兽描述' },
            combat_power: { type: 'integer', description: '战力', example: 285 }
        }
    },
    BeastType: {
        type: 'object',
        description: '灵兽种类配置（图鉴项）',
        properties: {
            beast_key: { type: 'string', description: '灵兽种类key', example: 'qingyun_wolf' },
            name: { type: 'string', description: '默认名称', example: '青云狼' },
            element: { type: 'string', description: '元素属性', example: 'metal' },
            element_name: { type: 'string', description: '元素中文名', example: '金' },
            rarity: { type: 'string', description: '稀有度', example: 'common' },
            rarity_name: { type: 'string', description: '稀有度中文名', example: '凡品' },
            base_hp: { type: 'integer', description: '基础气血', example: 500 },
            base_atk: { type: 'integer', description: '基础攻击', example: 80 },
            base_def: { type: 'integer', description: '基础防御', example: 50 },
            base_speed: { type: 'integer', description: '基础速度', example: 90 },
            min_realm_rank: { type: 'integer', description: '最低境界rank', example: 1 },
            catch_chance: { type: 'number', format: 'float', description: '捕获成功率（0-1）', example: 0.6 },
            catch_cost_mp: { type: 'integer', description: '捕获消耗灵力', example: 50 },
            feed_exp: { type: 'integer', description: '喂养获得经验', example: 10 },
            description: { type: 'string', description: '描述' },
            caught: { type: 'boolean', description: '玩家是否已捕获', example: true },
            my_best: {
                type: 'object',
                nullable: true,
                description: '玩家拥有的最高星级记录',
                properties: {
                    star_level: { type: 'integer' },
                    level: { type: 'integer' },
                    is_active: { type: 'boolean' }
                }
            }
        }
    },
    CatchBeastResult: {
        type: 'object',
        description: '捕获灵兽响应',
        properties: {
            caught: { type: 'boolean', description: '是否捕获成功', example: true },
            beast_key: { type: 'string', description: '灵兽种类key', example: 'qingyun_wolf' },
            beast_name: { type: 'string', description: '灵兽名', example: '青云狼' },
            roll: { type: 'string', description: '随机点数（0-1）', example: '0.3421' },
            catch_chance: { type: 'number', description: '捕获成功率', example: 0.6 },
            cost_mp: { type: 'string', description: '消耗灵力', example: '50' },
            return_mp: { type: 'string', description: '失败返还灵力（成功时无）', example: '15' },
            beast_id: { type: 'integer', description: '灵兽实例ID（成功时返回）', example: 1 },
            element: { type: 'string', description: '元素属性（成功时返回）', example: 'metal' },
            rarity: { type: 'string', description: '稀有度（成功时返回）', example: 'common' },
            today_count: { type: 'integer', description: '今日已捕获次数', example: 1 },
            daily_limit: { type: 'integer', description: '每日上限', example: 20 }
        }
    },
    FeedOrInteractResult: {
        type: 'object',
        description: '喂养/互动灵兽响应',
        properties: {
            beast_id: { type: 'integer', description: '灵兽实例ID', example: 1 },
            cost_spirit_stones: { type: 'string', description: '消耗灵石（仅喂养返回）', example: '100' },
            exp_gain: { type: 'string', description: '获得经验', example: '10' },
            loyalty_gain: { type: 'integer', description: '获得忠诚度', example: 5 },
            level_up: { type: 'boolean', description: '是否升级', example: false },
            new_level: { type: 'integer', description: '新等级', example: 1 },
            new_exp: { type: 'string', description: '新经验', example: '10' },
            new_loyalty: { type: 'integer', description: '新忠诚度', example: 55 }
        }
    }
};

/**
 * 主函数：读取 → 注入 → 写回
 */
function main() {
    console.log('[OpenAPI 更新] 开始注入灵兽系统接口...');

    const raw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
    const spec = JSON.parse(raw);

    // 1. 添加 tag（幂等）
    if (!spec.tags) spec.tags = [];
    const hasTag = spec.tags.some(t => t.name === SPIRIT_BEAST_TAG.name);
    if (!hasTag) {
        spec.tags.push(SPIRIT_BEAST_TAG);
        console.log('  ✓ 添加 tag: 灵兽系统');
    } else {
        console.log('  - tag 已存在，跳过');
    }

    // 2. 添加 paths（幂等）
    if (!spec.paths) spec.paths = {};
    let addedPaths = 0;
    for (const [pathKey, pathDef] of Object.entries(SPIRIT_BEAST_PATHS)) {
        if (!spec.paths[pathKey]) {
            spec.paths[pathKey] = pathDef;
            addedPaths++;
        }
    }
    console.log(`  ✓ 添加 ${addedPaths} 个灵兽系统接口路径`);

    // 3. 添加 schemas（幂等）
    if (!spec.components) spec.components = {};
    if (!spec.components.schemas) spec.components.schemas = {};
    let addedSchemas = 0;
    for (const [schemaName, schemaDef] of Object.entries(SPIRIT_BEAST_SCHEMAS)) {
        if (!spec.components.schemas[schemaName]) {
            spec.components.schemas[schemaName] = schemaDef;
            addedSchemas++;
        }
    }
    console.log(`  ✓ 添加 ${addedSchemas} 个灵兽系统 Schema`);

    // 4. 写回（4 空格缩进，与现有文档保持一致）
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(spec, null, 4) + '\n', 'utf-8');
    console.log('[OpenAPI 更新] ✓ 完成，已写回 docs/openapi.json');
}

main();
