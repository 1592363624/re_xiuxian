/**
 * OpenAPI 路径追加工具：为法宝深线系统添加 6 个接口定义
 *
 * 接口列表：
 *   GET  /api/artifact-deep-line/blood-sword/status
 *   POST /api/artifact-deep-line/blood-sword/sacrifice
 *   POST /api/artifact-deep-line/blood-sword/suppress
 *   POST /api/artifact-deep-line/blood-sword/thunder-wash
 *   POST /api/artifact-deep-line/blood-sword/imprint
 *   POST /api/artifact-deep-line/blood-sword/sheath
 *
 * 使用方式：
 *   node server/scripts/update_openapi_artifact_deep_line.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 通用错误响应（4xx/5xx）
const errorResponses = {
    400: {
        description: '业务逻辑错误或参数校验失败',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 400 },
                        error_code: {
                            type: 'string',
                            enum: ['VALIDATION_ERROR', 'BUSINESS_LOGIC_ERROR'],
                            description: '错误码'
                        },
                        message: { type: 'string', example: '错误描述' }
                    }
                }
            }
        }
    },
    401: { description: '未鉴权或 token 失效' },
    404: { description: '玩家不存在' },
    500: { description: '服务器内部错误' }
};

// 6 个接口定义
const newPaths = {
    '/api/artifact-deep-line/blood-sword/status': {
        get: {
            tags: ['法宝深线'],
            summary: '获取血魔剑残契状态',
            description: [
                '查询玩家当前血魔剑残契完整状态：',
                '- 已装备血魔剑：返回血契阶数/魔染/镇契/铭印/封鞘/各操作冷却/战力加成',
                '- 未装备血魔剑：返回 has_blood_sword=false + 获取途径提示',
                '',
                '玩法文档第19节·法宝深线第一条：血魔剑残契线',
                '血魔剑来源：掩月抢亲多人副本成功后 0.1% 掉率'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            responses: {
                200: {
                    description: '血魔剑状态快照',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            has_blood_sword: { type: 'boolean', example: true, description: '是否已装备血魔剑' },
                                            item_key: { type: 'string', example: 'blood_magic_sword' },
                                            item_name: { type: 'string', example: '血魔剑·残契' },
                                            equipment_id: { type: 'integer', example: 1, description: '装备记录ID（已装备时）' },
                                            slot: { type: 'string', example: 'weapon', description: '装备槽位' },
                                            durability: { type: 'integer', example: 100 },
                                            max_durability: { type: 'integer', example: 100 },
                                            refine_level: { type: 'integer', example: 0 },
                                            is_benming: { type: 'boolean', example: false },
                                            is_summoned: { type: 'boolean', example: false },
                                            blood_pact_stage: { type: 'integer', example: 0, description: '血契阶数 0~5' },
                                            blood_pact_stage_name: { type: 'string', example: '未启血契' },
                                            blood_pact_stage_description: { type: 'string', example: '' },
                                            blood_pact_max_stage: { type: 'integer', example: 5 },
                                            blood_pact_weekly_progress: { type: 'integer', example: 0, description: '本周血契累计进度' },
                                            blood_pact_weekly_limit: { type: 'integer', example: 36 },
                                            corruption: { type: 'integer', example: 0, description: '魔染值 0~100' },
                                            corruption_max: { type: 'integer', example: 100 },
                                            corruption_level: { type: 'string', example: '正常', enum: ['正常', '轻微反噬', '中度反噬', '严重反噬'] },
                                            corruption_extra_backlash_rate: { type: 'number', example: 0, description: '额外反噬比例' },
                                            corruption_loss_control_chance: { type: 'number', example: 0, description: '失控概率' },
                                            suppression: { type: 'integer', example: 0, description: '镇契值 0~100' },
                                            suppression_max: { type: 'integer', example: 100 },
                                            imprint_type: { type: 'string', example: 'none', enum: ['none', 'blood', 'suppress'] },
                                            imprint_name: { type: 'string', example: '无铭印' },
                                            last_imprint_at: { type: 'string', format: 'date-time', nullable: true },
                                            sheath_until: { type: 'string', format: 'date-time', nullable: true, description: '封鞘截止时间' },
                                            is_sheathed: { type: 'boolean', example: false },
                                            sheath_remaining_seconds: { type: 'integer', example: 0 },
                                            sacrifice_cooldown_remaining: { type: 'integer', example: 0, description: '祭血冷却剩余秒数' },
                                            thunder_wash_cooldown_remaining: { type: 'integer', example: 0, description: '雷洗冷却剩余秒数' },
                                            imprint_cooldown_remaining: { type: 'integer', example: 0, description: '铭印冷却剩余秒数' },
                                            combat_bonus: {
                                                type: 'object',
                                                description: '战力加成汇总',
                                                properties: {
                                                    atk_bonus_rate: { type: 'number', example: 0 },
                                                    hp_steal_bonus_rate: { type: 'number', example: 0 },
                                                    def_bonus_rate: { type: 'number', example: 0 },
                                                    crit_rate_bonus: { type: 'number', example: 0 },
                                                    crit_damage_bonus: { type: 'number', example: 0 },
                                                    blood_backlash_hp_rate_per_round: { type: 'number', example: 0, description: '每回合血反比例（仅血契铭印）' },
                                                    is_active: { type: 'boolean', example: false, description: '是否生效（封鞘期间为 false）' },
                                                    reason: { type: 'string', example: '封鞘中，不提供战力' }
                                                }
                                            },
                                            config: {
                                                type: 'object',
                                                description: '系统配置回显',
                                                properties: {
                                                    max_stage: { type: 'integer', example: 5 },
                                                    weekly_limit: { type: 'integer', example: 36 },
                                                    sacrifice_cooldown_hours: { type: 'integer', example: 18 },
                                                    thunder_wash_cooldown_hours: { type: 'integer', example: 24 },
                                                    imprint_cooldown_days: { type: 'integer', example: 7 },
                                                    sheath_duration_hours: { type: 'integer', example: 24 }
                                                }
                                            },
                                            server_time: { type: 'integer', example: 1721568000000, description: '服务端时间戳（毫秒）' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/artifact-deep-line/blood-sword/sacrifice': {
        post: {
            tags: ['法宝深线'],
            summary: '祭血推进血契阶数',
            description: [
                '祭血推进血契阶数（玩法文档第19节：.法宝 祭血 血魔剑）',
                '',
                '业务规则：',
                '1. 必须已装备血魔剑',
                '2. 血契阶数 < 5（max_stage）',
                '3. 祭血冷却已结束（18 小时）',
                '4. 本周血契进度 < 36（weekly_progress_limit）',
                '5. 消耗当前阶数→下一阶数所需材料',
                '6. 推进阶数 + 增加魔染（按阶段配置随机 8~14）+ 累加本周进度',
                '7. 封鞘中不可祭血'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: { type: 'object', properties: {} }
                    }
                }
            },
            responses: {
                200: {
                    description: '祭血成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    success: { type: 'boolean', example: true },
                                    message: { type: 'string', example: '祭血成功！血契阶数 0 → 1（血契初萌），魔染 +12（当前 12）' },
                                    blood_pact_stage: { type: 'integer', example: 1 },
                                    blood_pact_stage_name: { type: 'string', example: '血契初萌' },
                                    corruption: { type: 'integer', example: 12 },
                                    corruption_gain: { type: 'integer', example: 12 },
                                    blood_pact_weekly_progress: { type: 'integer', example: 1 },
                                    blood_pact_weekly_remaining: { type: 'integer', example: 35 },
                                    materials_consumed: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item_key: { type: 'string', example: 'xuejian_tiesui' },
                                                count: { type: 'integer', example: 2 }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/artifact-deep-line/blood-sword/suppress': {
        post: {
            tags: ['法宝深线'],
            summary: '镇契降低魔染',
            description: [
                '镇契降低魔染、提高镇契值（玩法文档第19节：.法宝 镇契 血魔剑）',
                '',
                '业务规则：',
                '1. 必须已装备血魔剑',
                '2. 消耗素女禁纹×1 + 掩月镜砂×1',
                '3. 无冷却，但魔染为 0 时不可镇契',
                '4. 降低魔染 5~10，提高镇契 5~10',
                '5. 封鞘中不可镇契'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: { type: 'object', properties: {} }
                    }
                }
            },
            responses: {
                200: {
                    description: '镇契成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    success: { type: 'boolean', example: true },
                                    message: { type: 'string', example: '镇契成功：魔染 12 → 4（-8），镇契 0 → 7（+7）' },
                                    corruption: { type: 'integer', example: 4 },
                                    suppression: { type: 'integer', example: 7 },
                                    corruption_reduce: { type: 'integer', example: 8 },
                                    suppression_gain: { type: 'integer', example: 7 },
                                    materials_consumed: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item_key: { type: 'string', example: 'sunv_jinwen' },
                                                count: { type: 'integer', example: 1 }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/artifact-deep-line/blood-sword/thunder-wash': {
        post: {
            tags: ['法宝深线'],
            summary: '雷洗强力降魔染',
            description: [
                '雷洗用天雷竹/金雷竹强力降魔染（玩法文档第19节：.法宝 雷洗 血魔剑）',
                '',
                '业务规则：',
                '1. 必须已装备血魔剑',
                '2. 冷却 24 小时',
                '3. material_type=tianlei 用天雷竹：降魔染 20~30',
                '4. material_type=jinlei 用金雷竹：降魔染 35~50',
                '5. 同时小幅提升镇契 2~5',
                '6. 封鞘中不可雷洗'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['material_type'],
                            properties: {
                                material_type: {
                                    type: 'string',
                                    enum: ['tianlei', 'jinlei'],
                                    description: '材料类型：tianlei=天雷竹 / jinlei=金雷竹'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '雷洗成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    success: { type: 'boolean', example: true },
                                    message: { type: 'string', example: '雷洗成功（天雷竹）：魔染 30 → 8（-22），镇契 5 → 8（+3）' },
                                    corruption: { type: 'integer', example: 8 },
                                    suppression: { type: 'integer', example: 8 },
                                    corruption_reduce: { type: 'integer', example: 22 },
                                    suppression_gain: { type: 'integer', example: 3 },
                                    material_type: { type: 'string', enum: ['tianlei', 'jinlei'], example: 'tianlei' },
                                    materials_consumed: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item_key: { type: 'string', example: 'tianlei_zhu' },
                                                count: { type: 'integer', example: 1 }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/artifact-deep-line/blood-sword/imprint': {
        post: {
            tags: ['法宝深线'],
            summary: '铭印选择路线',
            description: [
                '铭印选择血契或镇契路线（玩法文档第19节：.法宝 铭印 血魔剑 血契|镇契）',
                '',
                '业务规则：',
                '1. 必须已装备血魔剑',
                '2. 冷却 7 天',
                '3. imprint_type=blood 高输出+反噬（额外暴击/暴伤/吸血）',
                '4. imprint_type=suppress 稳定无反噬（额外防御/暴击/暴伤）',
                '5. 血契阶数 ≥ 1 才能铭印',
                '6. 封鞘中不可铭印'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['imprint_type'],
                            properties: {
                                imprint_type: {
                                    type: 'string',
                                    enum: ['blood', 'suppress'],
                                    description: '铭印类型：blood=血契铭印 / suppress=镇契铭印'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '铭印成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    success: { type: 'boolean', example: true },
                                    message: { type: 'string', example: '铭印成功：无铭印 → 血契铭印' },
                                    imprint_type: { type: 'string', enum: ['blood', 'suppress'], example: 'blood' },
                                    imprint_name: { type: 'string', example: '血契铭印' },
                                    last_imprint_at: { type: 'string', format: 'date-time' }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    },
    '/api/artifact-deep-line/blood-sword/sheath': {
        post: {
            tags: ['法宝深线'],
            summary: '封鞘 24 小时',
            description: [
                '封鞘 24 小时（玩法文档第19节：.法宝 封鞘 血魔剑）',
                '',
                '业务规则：',
                '1. 必须已装备血魔剑',
                '2. 未处于封鞘状态',
                '3. 血契阶数 ≥ 1 才能封鞘',
                '4. 封鞘后：24h 内不提供战力且不可祭出',
                '5. 封鞘期间不可祭血/镇契/雷洗/铭印',
                '6. 封鞘到期后由 StateCleanerService 自动结算：魔染 -25~35，镇契 +15~25'
            ].join('\n'),
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: { type: 'object', properties: {} }
                    }
                }
            },
            responses: {
                200: {
                    description: '封鞘成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    success: { type: 'boolean', example: true },
                                    message: { type: 'string', example: '血魔剑已封鞘 24 小时，期间不提供战力且不可祭出。封鞘到期后将自动结算：魔染 -25~35，镇契 +15~25' },
                                    sheath_until: { type: 'string', format: 'date-time' },
                                    sheath_duration_hours: { type: 'integer', example: 24 },
                                    is_summoned: { type: 'boolean', example: false }
                                }
                            }
                        }
                    }
                },
                ...errorResponses
            }
        }
    }
};

/**
 * 主流程
 */
function main() {
    console.log('读取 OpenAPI 文件:', OPENAPI_PATH);
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error('❌ OpenAPI 文件不存在');
        process.exit(1);
    }

    const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    console.log('当前 paths 数量:', Object.keys(openapi.paths).length);

    // 检查并添加新路径（幂等性：已存在的路径会被覆盖）
    let added = 0;
    let overwritten = 0;
    for (const [p, methods] of Object.entries(newPaths)) {
        if (openapi.paths[p]) {
            overwritten += 1;
            console.log(`  覆盖已存在路径: ${p}`);
        } else {
            added += 1;
            console.log(`  新增路径: ${p}`);
        }
        openapi.paths[p] = methods;
    }

    // 写回文件（保留 2 空格缩进）
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf8');
    console.log(`\n✓ OpenAPI 更新完成：新增 ${added} 条，覆盖 ${overwritten} 条`);
    console.log('更新后 paths 数量:', Object.keys(openapi.paths).length);
}

main();
