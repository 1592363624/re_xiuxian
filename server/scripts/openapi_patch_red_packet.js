/**
 * OpenAPI 文档补丁脚本：注入聊天红包系统接口定义
 *
 * 注入路径：
 *   1. POST /api/chat/red-packet/send - 发送红包
 *   2. POST /api/chat/red-packet/{id}/claim - 领取红包
 *   3. GET /api/chat/red-packet/{id} - 查询红包详情
 *   4. GET /api/chat/red-packet/active - 获取活跃红包列表
 *
 * 幂等执行：已存在的路径不会重复注入
 *
 * 用法：node scripts/openapi_patch_red_packet.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '..', '..', 'docs', 'openapi.json');

function main() {
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error('[OpenAPI Patch] openapi.json 不存在:', OPENAPI_PATH);
        process.exit(1);
    }

    const spec = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    if (!spec.paths) spec.paths = {};

    let injected = 0;

    // 1. POST /api/chat/red-packet/send
    const sendPath = '/api/chat/red-packet/send';
    if (!spec.paths[sendPath]) {
        spec.paths[sendPath] = {
            post: {
                tags: ['聊天红包'],
                summary: '发送红包',
                description: '在聊天频道发送红包，支持拼手气(lucky)和普通均分(equal)两种类型。发送时扣除发送者灵石，过期未领取部分自动退还。',
                operationId: 'sendRedPacket',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['total_amount', 'total_count'],
                                properties: {
                                    total_amount: { type: 'number', minimum: 10, maximum: 1000000, description: '红包总金额（灵石）' },
                                    total_count: { type: 'integer', minimum: 1, maximum: 100, description: '红包个数' },
                                    packet_type: { type: 'string', enum: ['lucky', 'equal'], default: 'lucky', description: '红包类型：lucky=拼手气，equal=普通均分' },
                                    message: { type: 'string', maxLength: 100, description: '红包附言（可选）' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: '红包发送成功',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        code: { type: 'integer', example: 201 },
                                        message: { type: 'string', example: '红包发送成功' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                red_packet_id: { type: 'integer' },
                                                sender: { type: 'object', properties: { id: { type: 'integer' }, nickname: { type: 'string' } } },
                                                total_amount: { type: 'number' },
                                                total_count: { type: 'integer' },
                                                packet_type: { type: 'string' },
                                                message: { type: 'string', nullable: true },
                                                status: { type: 'string' },
                                                expire_at: { type: 'string', format: 'date-time' },
                                                created_at: { type: 'string', format: 'date-time' },
                                                chat_message_id: { type: 'integer' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '400': { description: '参数校验失败 / 灵石不足 / 功能未开启' },
                    '401': { description: '未认证' }
                }
            }
        };
        injected++;
    }

    // 2. POST /api/chat/red-packet/{id}/claim
    const claimPath = '/api/chat/red-packet/{id}/claim';
    if (!spec.paths[claimPath]) {
        spec.paths[claimPath] = {
            post: {
                tags: ['聊天红包'],
                summary: '领取红包',
                description: '领取指定红包，返回领取金额。同一玩家对同一红包只能领取一次。拼手气红包使用二倍均值法随机分配金额，最后一个领取者触发手气最佳标记。',
                operationId: 'claimRedPacket',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: '红包ID' }
                ],
                responses: {
                    '200': {
                        description: '领取成功',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        code: { type: 'integer', example: 200 },
                                        message: { type: 'string' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                red_packet_id: { type: 'integer' },
                                                claim_id: { type: 'integer' },
                                                amount: { type: 'number', description: '领取金额（灵石）' },
                                                is_lucky_king: { type: 'boolean', description: '是否手气最佳' },
                                                is_last_claim: { type: 'boolean', description: '是否最后一个领取者' },
                                                sender_nickname: { type: 'string' },
                                                remain_count: { type: 'integer' },
                                                remain_amount: { type: 'number' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '400': { description: '红包不可领取/已领取/已过期/不能领取自己的红包' },
                    '401': { description: '未认证' },
                    '404': { description: '红包不存在' }
                }
            }
        };
        injected++;
    }

    // 3. GET /api/chat/red-packet/{id}
    const detailPath = '/api/chat/red-packet/{id}';
    if (!spec.paths[detailPath]) {
        spec.paths[detailPath] = {
            get: {
                tags: ['聊天红包'],
                summary: '查询红包详情',
                description: '查询红包详情，含所有领取记录列表和当前玩家的领取状态。',
                operationId: 'getRedPacketDetail',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: '红包ID' }
                ],
                responses: {
                    '200': {
                        description: '红包详情',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        code: { type: 'integer', example: 200 },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                red_packet_id: { type: 'integer' },
                                                sender: { type: 'object', properties: { id: { type: 'integer' }, nickname: { type: 'string' } } },
                                                total_amount: { type: 'number' },
                                                total_count: { type: 'integer' },
                                                remain_amount: { type: 'number' },
                                                remain_count: { type: 'integer' },
                                                packet_type: { type: 'string' },
                                                status: { type: 'string', enum: ['active', 'exhausted', 'expired', 'refunded'] },
                                                message: { type: 'string', nullable: true },
                                                expire_at: { type: 'string', format: 'date-time' },
                                                created_at: { type: 'string', format: 'date-time' },
                                                my_claim: {
                                                    type: 'object',
                                                    nullable: true,
                                                    properties: {
                                                        amount: { type: 'number' },
                                                        is_lucky_king: { type: 'boolean' },
                                                        claimed_at: { type: 'string', format: 'date-time' }
                                                    }
                                                },
                                                claims: {
                                                    type: 'array',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            receiver: { type: 'object', properties: { id: { type: 'integer' }, nickname: { type: 'string' } } },
                                                            amount: { type: 'number' },
                                                            is_lucky_king: { type: 'boolean' },
                                                            claimed_at: { type: 'string', format: 'date-time' }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '401': { description: '未认证' },
                    '404': { description: '红包不存在' }
                }
            }
        };
        injected++;
    }

    // 4. GET /api/chat/red-packet/active
    const activePath = '/api/chat/red-packet/active';
    if (!spec.paths[activePath]) {
        spec.paths[activePath] = {
            get: {
                tags: ['聊天红包'],
                summary: '获取活跃红包列表',
                description: '获取当前频道内可领取的活跃红包列表（状态为active且未过期）。',
                operationId: 'getActiveRedPackets',
                security: [{ bearerAuth: [] }],
                responses: {
                    '200': {
                        description: '活跃红包列表',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        code: { type: 'integer', example: 200 },
                                        data: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    red_packet_id: { type: 'integer' },
                                                    sender: { type: 'object', properties: { id: { type: 'integer' }, nickname: { type: 'string' } } },
                                                    total_amount: { type: 'number' },
                                                    total_count: { type: 'integer' },
                                                    remain_count: { type: 'integer' },
                                                    packet_type: { type: 'string' },
                                                    message: { type: 'string', nullable: true },
                                                    created_at: { type: 'string', format: 'date-time' },
                                                    expire_at: { type: 'string', format: 'date-time' }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '401': { description: '未认证' }
                }
            }
        };
        injected++;
    }

    // 写回文件
    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(spec, null, 2), 'utf8');
    console.log(`[OpenAPI Patch] 红包系统接口注入完成，新增 ${injected} 个路径`);
    if (injected === 0) {
        console.log('[OpenAPI Patch] 所有路径已存在，无需注入');
    }
}

main();
