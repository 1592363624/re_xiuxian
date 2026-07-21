/**
 * OpenAPI 文档补丁脚本：道侣/双修系统（玩家间 1v1 长期社交玩法）
 *
 * 作用：向 docs/openapi.json 注入道侣/双修系统的 10 个玩家接口定义：
 *   路由前缀 /api/dao-companion，对应 server/routes/dao_companion.js
 *     1.  POST /api/dao-companion/propose                       - 求婚
 *     2.  POST /api/dao-companion/respond                        - 响应求婚（accept/refuse）
 *     3.  GET  /api/dao-companion/my                             - 我的道侣信息
 *     4.  POST /api/dao-companion/interact                       - 道侣互动（每日问安）
 *     5.  POST /api/dao-companion/dual-cultivation               - 双修
 *     6.  POST /api/dao-companion/break                          - 解除道侣关系
 *     7.  GET  /api/dao-companion/proposals                      - 我收到的求婚列表
 *     8.  POST /api/dao-companion/heart-tribulation/respond      - 心劫抉择
 *     9.  GET  /api/dao-companion/heart-tribulation/status       - 心劫状态
 *    10.  POST /api/dao-companion/heart-imprint                  - 凝聚心印
 *
 * 与旧道侣/侍妾系统的区别：
 *   - 旧系统 tag "道侣侍妾" 对应 server/routes/companion.js（无亲密度，主 1vN）
 *   - 新系统 tag "道侣双修系统" 对应 server/routes/dao_companion.js（含亲密度，1v1）
 *
 * 设计原则：
 *   - 不修改原有任何接口定义，仅做"追加"操作
 *   - 在 tags 数组末尾追加 1 个新 tag（道侣双修系统）
 *   - 在 paths 对象中追加新路径（若 path+method 已存在则跳过，保证幂等）
 *   - 在 components.schemas 中追加新的响应 Schema（仅追加，不覆盖）
 *
 * 运行方式：node server/scripts/openapi_patch_dao_companion.js
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
        name: '道侣双修系统',
        description: '玩家间 1v1 长期社交玩法 - 求婚/响应/互动/双修/解除/心劫抉择/心印凝聚/心契等级（0-9）/亲密度（0-100）'
    }
];

// ==================== 通用响应构造工具 ====================
/**
 * 构造通用响应对象（200/400/401/500）
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
                            success: { type: 'boolean', example: true },
                            message: { type: 'string' },
                            data: { type: 'object', nullable: true },
                            error_code: { type: 'string', description: '业务失败时的错误码（success=false 时存在）' }
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
                            message: { type: 'string', example: 'target_player_id 必填且必须为数字' }
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
};

// 通用的 security 要求（需要 bearer token）
const securityRequirement = [{ bearerAuth: [] }];

// 玩家接口的通用响应
const playerResponses = (description) => securityResponses(description);

// ==================== 10 个新接口定义 ====================
const NEW_PATHS = {
    // ============== 1. 求婚 ==============
    '/api/dao-companion/propose': {
        post: {
            summary: '求婚',
            description: '向目标玩家发起道侣求婚（创建 pending 状态的 dao_companions 记录）。校验：境界≥结丹期(rank 15)、双方无活跃道侣、外发求婚≤1、解除冷却期7天。成功后通过 WebSocket 通知目标玩家。',
            tags: ['道侣双修系统'],
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
                                    minimum: 1,
                                    description: '目标玩家ID（不可为自己）',
                                    example: 2
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('求婚结果（proposal_id、target_player 信息、created_at）')
        }
    },
    // ============== 2. 响应求婚 ==============
    '/api/dao-companion/respond': {
        post: {
            summary: '响应求婚',
            description: '响应求婚：accept 时 status→accepted，亲密度+10 初始值；refuse 时 status→refused。仅被求婚方（player_b_id）可响应，且求婚状态须为 pending。accept 后通过 WebSocket 通知求婚方。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['proposal_id', 'action'],
                            properties: {
                                proposal_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '求婚记录ID',
                                    example: 1
                                },
                                action: {
                                    type: 'string',
                                    enum: ['accept', 'refuse'],
                                    description: 'accept=接受求婚，refuse=拒绝求婚',
                                    example: 'accept'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('响应结果（companion_id、partner 信息、初始亲密度）')
        }
    },
    // ============== 3. 我的道侣信息 ==============
    '/api/dao-companion/my': {
        get: {
            summary: '我的道侣信息',
            description: '获取当前玩家的道侣信息：道侣详情（亲密度、心契等级、心印数量、双修次数）+ 对方玩家信息（昵称、境界、在线状态）+ 双修加成比例 + 各项冷却剩余。无道侣时返回 has_companion=false + 境界是否满足求婚要求。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('我的道侣信息（has_companion、partner、intimacy、heart_contract_level 等）')
        }
    },
    // ============== 4. 道侣互动 ==============
    '/api/dao-companion/interact': {
        post: {
            summary: '道侣互动（每日问安）',
            description: '道侣互动（每日问安/灵力反哺）：24 小时冷却，亲密度+2，双方各获得少量修为（相当于30秒修炼收益）。亲密度≥50 时有 10% 概率触发心劫事件。互动后通过 WebSocket 推送双方玩家状态更新。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('互动结果（intimacy_gain、new_intimacy、player_exp_gain、partner_exp_gain）')
        }
    },
    // ============== 5. 双修 ==============
    '/api/dao-companion/dual-cultivation': {
        post: {
            summary: '双修（双人闭关）',
            description: '与道侣进行双修：双方必须都在线，且未闭关/未战斗/未双修（状态机互斥校验）。收益公式：duration × base_exp_rate × 1.5 × (1 + intimacy/200) × realmMultiplier × (1 + heart_contract_level × 0.05)。双修状态通过 last_dual_cultivation_time 时间戳判断激活，持续 60-300 秒后自动结束。收益在双修开始时一次性发放，避免结算时玩家离线。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('双修结果（player_exp_gain、partner_exp_gain、intimacy_gain、duration、dual_cultivation_count）')
        }
    },
    // ============== 6. 解除道侣 ==============
    '/api/dao-companion/break': {
        post: {
            summary: '解除道侣关系',
            description: '单方面解除道侣关系：亲密度-20 惩罚（仅记录），7 天冷却期内不能再次求婚。解除后双方均恢复可求婚状态。通过 WebSocket 通知对方玩家。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('解除结果（companion_id、intimacy_penalty、broken_at、cooldown_days）')
        }
    },
    // ============== 7. 求婚列表 ==============
    '/api/dao-companion/proposals': {
        get: {
            summary: '我收到的求婚列表',
            description: '获取当前玩家收到的所有 pending 状态的求婚记录，含求婚方玩家信息（昵称、境界、境界等阶）和求婚时间。最多返回 3 条（配置项 max_pending_proposals_per_receiver）。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('求婚列表（proposals 数组、count、max_pending）')
        }
    },
    // ============== 8. 心劫抉择 ==============
    '/api/dao-companion/heart-tribulation/respond': {
        post: {
            summary: '心劫抉择',
            description: '对 pending 心劫事件进行抉择。三选项含不同成功率与奖惩：trust(信任,成功率0.8,亲密度+5)、doubt(怀疑,成功率0.5,亲密度-3)、trial(考验,成功率0.3,成功亲密度+15)。失败时亲密度-10、心契等级-1。抉择后事件状态变为 resolved，24 小时内必须抉择否则自动失败。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['event_id', 'option'],
                            properties: {
                                event_id: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '心劫事件ID',
                                    example: 1
                                },
                                option: {
                                    type: 'string',
                                    enum: ['trust', 'doubt', 'trial'],
                                    description: '抉择选项：trust=信任 / doubt=怀疑 / trial=考验',
                                    example: 'trust'
                                }
                            }
                        }
                    }
                }
            },
            responses: playerResponses('抉择结果（is_success、chosen_option、success_rate、new_intimacy、new_heart_contract_level、reward/penalty）')
        }
    },
    // ============== 9. 心劫状态 ==============
    '/api/dao-companion/heart-tribulation/status': {
        get: {
            summary: '心劫状态查询',
            description: '查询当前玩家是否有 pending 心劫事件，返回事件详情（event_id、created_at、expires_at）和三选项详情（option、name、success_rate、intimacy_gain、description）。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('心劫状态（has_pending、pending_event 含 options 数组）')
        }
    },
    // ============== 10. 凝聚心印 ==============
    '/api/dao-companion/heart-imprint': {
        post: {
            summary: '凝聚心印',
            description: '凝聚心印：亲密度>=80 时可凝聚，消耗双方各 1000 修为。heart_imprint_count+1，每 3 个心印提升 1 级心契（上限 9 级）。心契等级影响双修加成（每级 +5%）。',
            tags: ['道侣双修系统'],
            security: securityRequirement,
            responses: playerResponses('凝聚结果（exp_cost、new_heart_imprint_count、new_heart_contract_level、level_up、imprint_to_next_level）')
        }
    }
};

// ==================== 新增 Schema 定义 ====================
// 为关键响应定义专属 schema，便于前端/工具引用（仅追加，不覆盖同名 schema）
const NEW_SCHEMAS = {
    // 我的道侣信息响应
    DaoCompanionMyResponse: {
        type: 'object',
        description: '我的道侣信息响应数据',
        properties: {
            has_companion: { type: 'boolean', description: '是否已有道侣' },
            companion_id: { type: 'integer', description: '道侣关系ID', nullable: true },
            partner: {
                type: 'object',
                description: '道侣对方玩家信息',
                nullable: true,
                properties: {
                    id: { type: 'integer', description: '玩家ID' },
                    nickname: { type: 'string', description: '玩家道号' },
                    realm: { type: 'string', description: '境界名称' },
                    realm_rank: { type: 'integer', description: '境界等阶' },
                    is_online: { type: 'boolean', description: '是否在线' }
                }
            },
            status: {
                type: 'string',
                enum: ['pending', 'accepted', 'refused', 'broken'],
                description: '关系状态',
                nullable: true
            },
            intimacy: { type: 'integer', minimum: 0, maximum: 100, description: '亲密度（0-100）' },
            heart_contract_level: { type: 'integer', minimum: 0, maximum: 9, description: '心契等级（0-9）' },
            heart_imprint_count: { type: 'integer', minimum: 0, description: '心印数量' },
            dual_cultivation_count: { type: 'integer', minimum: 0, description: '历史双修总次数' },
            dual_cultivation_bonus_rate: { type: 'number', description: '双修加成比例（如 1.65）' },
            interact_cooldown_remaining: { type: 'integer', description: '互动冷却剩余秒数' },
            dual_cultivation_cooldown_remaining: { type: 'integer', description: '双修冷却剩余秒数' },
            last_interaction_time: { type: 'string', format: 'date-time', nullable: true, description: '最后互动时间' },
            last_dual_cultivation_time: { type: 'string', format: 'date-time', nullable: true, description: '最后双修时间' },
            created_at: { type: 'string', format: 'date-time', description: '结侣时间' },
            settings: {
                type: 'object',
                description: '道侣系统配置（前端展示用）',
                properties: {
                    min_intimacy_for_heart_tribulation: { type: 'integer', description: '心劫触发所需最低亲密度' },
                    min_intimacy_for_heart_imprint: { type: 'integer', description: '凝聚心印所需最低亲密度' },
                    heart_imprint_exp_cost: { type: 'integer', description: '凝聚心印消耗修为' },
                    heart_imprint_count_per_level: { type: 'integer', description: '提升心契等级所需心印数' },
                    max_heart_contract_level: { type: 'integer', description: '心契等级上限' }
                }
            },
            min_realm_rank: { type: 'integer', description: '求婚所需最低境界等阶（无道侣时存在）', nullable: true },
            min_realm_name: { type: 'string', description: '求婚所需最低境界名称（无道侣时存在）', nullable: true },
            can_propose: { type: 'boolean', description: '是否满足求婚境界要求（无道侣时存在）', nullable: true }
        }
    },
    // 求婚记录项
    DaoCompanionProposalItem: {
        type: 'object',
        description: '求婚记录项',
        properties: {
            proposal_id: { type: 'integer', description: '求婚记录ID' },
            from_player: {
                type: 'object',
                description: '求婚方玩家信息',
                nullable: true,
                properties: {
                    id: { type: 'integer', description: '玩家ID' },
                    nickname: { type: 'string', description: '玩家道号' },
                    realm: { type: 'string', description: '境界名称' },
                    realm_rank: { type: 'integer', description: '境界等阶' }
                }
            },
            created_at: { type: 'string', format: 'date-time', description: '求婚时间' }
        }
    },
    // 求婚列表响应
    DaoCompanionProposalListResponse: {
        type: 'object',
        description: '我收到的求婚列表响应',
        properties: {
            proposals: {
                type: 'array',
                description: '求婚记录列表',
                items: { $ref: '#/components/schemas/DaoCompanionProposalItem' }
            },
            count: { type: 'integer', description: '求婚数量' },
            max_pending: { type: 'integer', description: '接收方最大待处理求婚数' }
        }
    },
    // 心劫选项详情
    DaoCompanionHeartTribulationOption: {
        type: 'object',
        description: '心劫抉择选项详情',
        properties: {
            option: { type: 'string', enum: ['trust', 'doubt', 'trial'], description: '选项 key' },
            name: { type: 'string', description: '选项中文名（信任/怀疑/考验）' },
            success_rate: { type: 'number', minimum: 0, maximum: 1, description: '成功率（0-1）' },
            intimacy_gain: { type: 'integer', description: '亲密度变化（正为增加，负为减少）' },
            heart_contract_exp_gain: { type: 'integer', description: '心契经验增加量' },
            description: { type: 'string', description: '选项描述' }
        }
    },
    // 心劫状态响应
    DaoCompanionHeartTribulationStatusResponse: {
        type: 'object',
        description: '心劫状态响应',
        properties: {
            has_pending: { type: 'boolean', description: '是否有待处理心劫事件' },
            pending_event: {
                type: 'object',
                description: '待处理心劫事件',
                nullable: true,
                properties: {
                    event_id: { type: 'integer', description: '心劫事件ID' },
                    companion_id: { type: 'integer', description: '关联道侣关系ID' },
                    created_at: { type: 'string', format: 'date-time', description: '触发时间' },
                    expires_at: { type: 'string', format: 'date-time', description: '过期时间（24 小时内必须抉择）' },
                    options: {
                        type: 'array',
                        description: '三选项详情',
                        items: { $ref: '#/components/schemas/DaoCompanionHeartTribulationOption' }
                    }
                }
            }
        }
    },
    // 心劫抉择结果响应
    DaoCompanionHeartTribulationResultResponse: {
        type: 'object',
        description: '心劫抉择结果响应',
        properties: {
            is_success: { type: 'boolean', description: '是否成功' },
            chosen_option: { type: 'string', enum: ['trust', 'doubt', 'trial'], description: '选择的选项' },
            option_name: { type: 'string', description: '选项中文名' },
            success_rate: { type: 'number', description: '成功率' },
            new_intimacy: { type: 'integer', description: '新的亲密度' },
            new_heart_contract_level: { type: 'integer', description: '新的心契等级' },
            reward: {
                type: 'object',
                description: '奖励详情（成功时存在）',
                nullable: true,
                properties: {
                    intimacy_gain: { type: 'integer', description: '亲密度增加量' },
                    heart_contract_exp_gain: { type: 'integer', description: '心契经验增加量' }
                }
            },
            penalty: {
                type: 'object',
                description: '惩罚详情（失败时存在）',
                nullable: true,
                properties: {
                    intimacy_loss: { type: 'integer', description: '亲密度减少量' },
                    heart_contract_level_loss: { type: 'integer', description: '心契等级减少量' }
                }
            }
        }
    },
    // 双修结果响应
    DaoCompanionDualCultivationResultResponse: {
        type: 'object',
        description: '双修结果响应',
        properties: {
            player_exp_gain: { type: 'string', description: '自己修为增加量（BigInt 序列化为字符串）' },
            partner_exp_gain: { type: 'string', description: '道侣修为增加量（BigInt 序列化为字符串）' },
            intimacy_gain: { type: 'integer', description: '亲密度增加量' },
            new_intimacy: { type: 'integer', description: '新的亲密度' },
            duration: { type: 'integer', description: '双修持续秒数（60-300）' },
            dual_cultivation_count: { type: 'integer', description: '双修总次数' },
            last_dual_cultivation_time: { type: 'string', format: 'date-time', description: '最后双修时间' }
        }
    },
    // 凝聚心印结果响应
    DaoCompanionHeartImprintResultResponse: {
        type: 'object',
        description: '凝聚心印结果响应',
        properties: {
            exp_cost: { type: 'string', description: '消耗修为（BigInt 序列化为字符串）' },
            new_heart_imprint_count: { type: 'integer', description: '新的心印数量' },
            new_heart_contract_level: { type: 'integer', description: '新的心契等级' },
            level_up: { type: 'boolean', description: '是否提升心契等级' },
            imprint_to_next_level: { type: 'integer', description: '距离下次升级还差的心印数' }
        }
    },
    // 求婚结果响应
    DaoCompanionProposeResultResponse: {
        type: 'object',
        description: '求婚结果响应',
        properties: {
            proposal_id: { type: 'integer', description: '求婚记录ID' },
            target_player: {
                type: 'object',
                description: '目标玩家信息',
                properties: {
                    id: { type: 'integer', description: '玩家ID' },
                    nickname: { type: 'string', description: '玩家道号' },
                    realm: { type: 'string', description: '境界名称' }
                }
            },
            created_at: { type: 'string', format: 'date-time', description: '求婚时间' }
        }
    },
    // 响应求婚结果
    DaoCompanionRespondResultResponse: {
        type: 'object',
        description: '响应求婚结果',
        properties: {
            companion_id: { type: 'integer', description: '道侣关系ID（accept 时存在）' },
            partner: {
                type: 'object',
                description: '对方玩家信息（accept 时存在）',
                nullable: true,
                properties: {
                    id: { type: 'integer', description: '玩家ID' },
                    nickname: { type: 'string', description: '玩家道号' },
                    realm: { type: 'string', description: '境界名称' }
                }
            },
            intimacy: { type: 'integer', description: '初始亲密度（accept 时为 10）', nullable: true },
            action: { type: 'string', enum: ['accept', 'refuse'], description: '动作' }
        }
    },
    // 解除道侣结果响应
    DaoCompanionBreakResultResponse: {
        type: 'object',
        description: '解除道侣结果响应',
        properties: {
            companion_id: { type: 'integer', description: '道侣关系ID' },
            intimacy_penalty: { type: 'integer', description: '亲密度惩罚（-20）' },
            broken_at: { type: 'string', format: 'date-time', description: '解除时间' },
            cooldown_days: { type: 'integer', description: '重新求婚冷却天数（7）' }
        }
    },
    // 道侣互动结果响应
    DaoCompanionInteractResultResponse: {
        type: 'object',
        description: '道侣互动结果响应',
        properties: {
            intimacy_gain: { type: 'integer', description: '亲密度增加量（+2）' },
            new_intimacy: { type: 'integer', description: '新的亲密度' },
            player_exp_gain: { type: 'string', description: '自己修为增加量（BigInt 序列化为字符串）' },
            partner_exp_gain: { type: 'string', description: '道侣修为增加量（BigInt 序列化为字符串）' },
            last_interaction_time: { type: 'string', format: 'date-time', description: '最后互动时间' }
        }
    }
};

// ==================== 主流程 ====================
console.log('[openapi_patch_dao_companion] 开始更新 docs/openapi.json');

// 1. 读取原文件
if (!fs.existsSync(OPENAPI_PATH)) {
    console.error('[openapi_patch_dao_companion] 错误：docs/openapi.json 不存在');
    process.exit(1);
}
const rawContent = fs.readFileSync(OPENAPI_PATH, 'utf8');
const spec = JSON.parse(rawContent);
console.log('[openapi_patch_dao_companion] 原始文件已加载，paths 数量:', Object.keys(spec.paths || {}).length);

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
        console.log(`[openapi_patch_dao_companion] 已追加 tag: ${tag.name}`);
    } else {
        console.log(`[openapi_patch_dao_companion] tag 已存在，跳过: ${tag.name}`);
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
                console.log(`[openapi_patch_dao_companion] 已追加方法: ${method.toUpperCase()} ${pathKey}`);
            } else {
                skippedPaths++;
                console.log(`[openapi_patch_dao_companion] 方法已存在，跳过: ${method.toUpperCase()} ${pathKey}`);
            }
        }
    } else {
        // 路径不存在，整体追加
        spec.paths[pathKey] = methods;
        addedPaths += Object.keys(methods).length;
        console.log(`[openapi_patch_dao_companion] 已追加路径: ${pathKey} (${Object.keys(methods).length} 个方法)`);
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
        console.log(`[openapi_patch_dao_companion] 已追加 schema: ${schemaName}`);
    } else {
        console.log(`[openapi_patch_dao_companion] schema 已存在，跳过: ${schemaName}`);
    }
}

// 5. 写回文件（4 空格缩进，保留中文可读性）
const output = JSON.stringify(spec, null, 4);
fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

console.log('\n[openapi_patch_dao_companion] 更新完成！');
console.log(`  - 新增 tags: ${addedTags} 个`);
console.log(`  - 新增 paths: ${addedPaths} 个方法`);
console.log(`  - 跳过（已存在）: ${skippedPaths} 个方法`);
console.log(`  - 新增 schemas: ${addedSchemas} 个`);
console.log(`  - 当前 paths 总数: ${Object.keys(spec.paths).length}`);
console.log(`  - 当前 tags 总数: ${spec.tags.length}`);
console.log(`  - 当前 schemas 总数: ${Object.keys(spec.components.schemas).length}`);
