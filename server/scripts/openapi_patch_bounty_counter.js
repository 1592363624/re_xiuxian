/**
 * OpenAPI 文档补丁脚本：悬赏系统反悬赏接口 + 保护期机制
 *
 * 作用：向 docs/openapi.json 注入反悬赏接口定义：
 *   POST /api/bounty/{bountyId}/counter - 反悬赏（被悬赏者对悬赏者发起反向悬赏）
 *
 * 同时更新 GET /api/bounty/my 的响应 Schema，新增 targeting_me 字段（针对我的悬赏列表）
 *
 * 设计原则：
 *   - 不修改原有任何接口定义（除 my 接口的 response schema 追加字段外）
 *   - 仅做"追加"操作
 *   - 幂等性：可重复执行，相同 path+method 会被覆盖更新
 *
 * 运行方式：node server/scripts/openapi_patch_bounty_counter.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-22
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

// 通用错误响应
const errorResponses = {
    400: {
        description: '业务逻辑错误或参数校验失败',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        code: { type: 'integer', example: 400 },
                        error_code: { type: 'string', example: 'BUSINESS_LOGIC_ERROR' },
                        message: { type: 'string', example: '错误描述' }
                    }
                }
            }
        }
    },
    401: { description: '未鉴权或 token 失效' },
    403: { description: '无权限操作' },
    404: { description: '悬赏不存在' },
    500: { description: '服务器内部错误' }
};

// 通用 Bearer 鉴权
const bearerAuth = [{ bearerAuth: [] }];

// ==================== 新增接口路径 ====================
const NEW_PATHS = {
    // 反悬赏接口
    '/api/bounty/{bountyId}/counter': {
        post: {
            tags: ['悬赏系统'],
            summary: '反悬赏（被悬赏者反击悬赏者）',
            description: [
                '被悬赏的玩家可花费灵石主动反击，对悬赏自己的人发起反向悬赏。',
                '',
                '校验规则：',
                '- 反悬赏功能全局开启（counter_bounty.enabled=true）',
                '- 原悬赏存在且状态为 active 或 accepted',
                '- 调用者为原悬赏的 target_id（仅被悬赏者可反悬赏）',
                '- 反悬赏链深度未超上限（max_counter_chain=3）',
                '- 反悬赏金额 = 原悬赏金额 × amount_multiplier（默认 1.2）',
                '',
                '流程：',
                '1. 查询原悬赏，校验调用者身份与状态',
                '2. 计算反悬赏链深度（reason 中 [反悬赏] 前缀计数）',
                '3. 计算反悬赏金额',
                '4. 调用 publishBounty 创建反向悬赏（复用所有校验逻辑）'
            ].join('\n'),
            operationId: 'counterBounty',
            security: bearerAuth,
            parameters: [
                {
                    name: 'bountyId',
                    in: 'path',
                    required: true,
                    description: '原悬赏 ID',
                    schema: { type: 'integer', minimum: 1 }
                }
            ],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                reason: {
                                    type: 'string',
                                    maxLength: 180,
                                    description: '反悬赏理由（可选，最多 180 字）'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                200: {
                    description: '反悬赏发布成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '反悬赏发布成功' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            bounty_id: { type: 'integer', description: '反悬赏创建的新悬赏 ID' },
                                            publisher: {
                                                type: 'object',
                                                description: '反悬赏发起者（原悬赏目标）信息',
                                                properties: {
                                                    id: { type: 'integer' },
                                                    nickname: { type: 'string' }
                                                }
                                            },
                                            target: {
                                                type: 'object',
                                                description: '反悬赏目标（原悬赏发布者）信息',
                                                properties: {
                                                    id: { type: 'integer' },
                                                    nickname: { type: 'string' },
                                                    realm: { type: 'string' },
                                                    realm_rank: { type: 'integer' }
                                                }
                                            },
                                            bounty_amount: { type: 'integer', description: '反悬赏金额' },
                                            platform_fee: { type: 'integer', description: '平台手续费' },
                                            total_cost: { type: 'integer', description: '总消耗（金额+手续费）' },
                                            status: { type: 'string', example: 'active' },
                                            reason: { type: 'string', description: '反悬赏理由（含 [反悬赏] 前缀）' },
                                            expire_at: { type: 'string', format: 'date-time' },
                                            is_counter_bounty: { type: 'boolean', example: true },
                                            original_bounty_id: { type: 'integer', description: '原悬赏 ID' },
                                            counter_chain_depth: { type: 'integer', description: '反悬赏链深度（1=首次, 2=二次...）' },
                                            original_amount: { type: 'integer', description: '原悬赏金额' },
                                            counter_multiplier: { type: 'number', example: 1.2, description: '反悬赏倍率' }
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
    }
};

// ==================== 主逻辑 ====================

/**
 * 主函数：读取 OpenAPI 文档，注入新路径，写回文件
 */
function main() {
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error(`[ERROR] OpenAPI 文档不存在: ${OPENAPI_PATH}`);
        process.exit(1);
    }

    const doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    if (!doc.paths) {
        doc.paths = {};
    }

    let added = 0;
    let updated = 0;

    // 注入新路径
    for (const [pathKey, pathObj] of Object.entries(NEW_PATHS)) {
        if (!doc.paths[pathKey]) {
            doc.paths[pathKey] = pathObj;
            added++;
            console.log(`[ADD] ${pathKey}`);
        } else {
            doc.paths[pathKey] = pathObj;
            updated++;
            console.log(`[UPDATE] ${pathKey}`);
        }
    }

    // 更新 GET /api/bounty/my 的响应描述，添加 targeting_me 字段说明
    const myPath = doc.paths['/api/bounty/my'];
    if (myPath && myPath.get) {
        const desc = myPath.get.description || '';
        if (!desc.includes('targeting_me')) {
            myPath.get.description = (desc ? desc + '\n\n' : '') +
                '返回结构包含三个列表：\n' +
                '- published: 我发布的悬赏\n' +
                '- accepted: 我接取的悬赏\n' +
                '- targeting_me: 针对我的悬赏（我是 target，状态为 active/accepted，可用于反悬赏）';
            console.log('[UPDATE] /api/bounty/my 描述已更新（添加 targeting_me 说明）');
        }

        // 更新响应 Schema，添加 targeting_me 字段
        const okResp = myPath.get.responses?.[200];
        if (okResp?.content?.['application/json']?.schema?.properties?.data?.properties) {
            const dataProps = okResp.content['application/json'].schema.properties.data.properties;
            if (!dataProps.targeting_me) {
                dataProps.targeting_me = {
                    type: 'array',
                    description: '针对我的悬赏列表（我是 target，状态为 active/accepted）',
                    items: { '$ref': '#/components/schemas/BountyListItem' }
                };
                console.log('[UPDATE] /api/bounty/my 响应 Schema 已添加 targeting_me 字段');
            }
        }
    }

    // 写回文件
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(doc, null, 2), 'utf8');
    console.log(`\n[完成] 新增 ${added} 个路径，更新 ${updated} 个路径`);
    console.log(`OpenAPI 文档已更新: ${OPENAPI_PATH}`);
}

main();
