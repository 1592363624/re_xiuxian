/**
 * OpenAPI 文档增量更新脚本：追加切磋木人 GM 手动结算接口定义
 *
 * 新增路径：
 *   POST /api/sparring/settle - [GM] 手动触发每日排行榜结算
 *
 * 运行方式：node server/scripts/update_openapi_sparring_settle.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '..', '..', 'docs', 'openapi.json');

// 新增的路径定义
const NEW_PATHS = {
    '/api/sparring/settle': {
        post: {
            tags: ['切磋木人', 'GM 管理接口'],
            summary: '[GM] 手动触发切磋木人排行榜每日结算',
            description: [
                '**权限要求：管理员（role=admin）**',
                '',
                '使用场景：',
                '- 调度器未到点但需要立即结算（如紧急修复后补结算昨日数据）',
                '- 测试环境验证结算逻辑',
                '- 服务长时间宕机后补结算某日数据',
                '',
                '**幂等性保证**：',
                '- Service 层通过 SystemConfig 表记录已结算日期，双重幂等',
                '- 已结算的日期再次调用会返回 already_settled=true，不会重复发放奖励',
                '',
                '**结算逻辑**：',
                '1. 计算目标日期（默认昨天：00:00:00 ~ 23:59:59）',
                '2. 按玩家聚合取当日 MAX(score)，按分数降序取前 N 名（N=ranking_top_n）',
                '3. 按 ranking_daily_reward 配置发放经验/灵石/称号奖励',
                '4. 标记该日所有切磋记录的 settled_at（含 lose/timeout）',
                '5. 写入 SystemConfig 记录该日已结算',
                '6. 推送 WebSocket 通知给上榜玩家',
                '',
                '**奖励配置**（sparring_woodman.json → global.ranking_daily_reward）：',
                '- 第 1 名：exp=5000, spirit_stones=3000, title=木人切磋·天下第一',
                '- 第 2 名：exp=3000, spirit_stones=2000',
                '- 第 3 名：exp=2000, spirit_stones=1000',
                '- 第 4-10 名（default）：exp=1000, spirit_stones=500'
            ].join('\n'),
            operationId: 'settleSparringDailyRanking',
            security: [{ bearerAuth: [] }],
            requestBody: {
                required: false,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                target_date: {
                                    type: 'string',
                                    format: 'date',
                                    description: '目标结算日期（YYYY-MM-DD 格式，如 2026-07-20）。不传则默认结算昨日。',
                                    example: '2026-07-20'
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                '200': {
                    description: '结算成功',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 200 },
                                    message: { type: 'string', example: '排行榜 2026-07-20 结算完成，共 3 名上榜' },
                                    data: {
                                        type: 'object',
                                        properties: {
                                            settle_date: { type: 'string', format: 'date', description: '实际结算日期（YYYY-MM-DD）' },
                                            already_settled: { type: 'boolean', description: '是否已结算过（true 表示跳过，未发放奖励）' },
                                            settled_count: { type: 'integer', description: '上榜玩家数' },
                                            rewards: {
                                                type: 'array',
                                                description: '各名次奖励发放详情',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        rank: { type: 'integer', description: '名次（1-10）' },
                                                        player_id: { type: 'integer', description: '玩家ID' },
                                                        nickname: { type: 'string', description: '玩家昵称' },
                                                        realm_name: { type: 'string', description: '境界名称' },
                                                        best_score: { type: 'integer', description: '当日最高分' },
                                                        best_tier: { type: 'integer', description: '最高分对应的木人档次' },
                                                        best_woodman: { type: 'string', description: '最高分对应的木人名称' },
                                                        status: {
                                                            type: 'string',
                                                            enum: ['rewarded', 'skipped'],
                                                            description: 'rewarded=已发放奖励，skipped=跳过（玩家不存在或已陨落）'
                                                        },
                                                        reason: {
                                                            type: 'string',
                                                            description: '跳过原因（仅 status=skipped 时有值）',
                                                            nullable: true
                                                        },
                                                        rewards: {
                                                            type: 'object',
                                                            properties: {
                                                                exp: { type: 'integer', description: '获得修为' },
                                                                spirit_stones: { type: 'integer', description: '获得灵石' },
                                                                title: {
                                                                    type: 'string',
                                                                    description: '获得称号ID（如木人切磋·天下第一）',
                                                                    nullable: true
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                            message: { type: 'string', description: '结算结果描述' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                '400': {
                    description: '参数校验失败',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 400 },
                                    error_code: { type: 'string', example: 'VALIDATION_ERROR' },
                                    message: { type: 'string', example: 'target_date 参数无效，需为 YYYY-MM-DD 格式字符串' }
                                }
                            }
                        }
                    }
                },
                '401': {
                    description: '未登录或 token 无效',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 401 },
                                    error_code: { type: 'string', example: 'UNAUTHORIZED' },
                                    message: { type: 'string', example: '未授权访问' }
                                }
                            }
                        }
                    }
                },
                '403': {
                    description: '权限不足（非管理员）',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    code: { type: 'integer', example: 403 },
                                    error_code: { type: 'string', example: 'BUSINESS_LOGIC_ERROR' },
                                    message: { type: 'string', example: '权限不足：需要管理员权限' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

// ============== 主流程 ==============
function main() {
    if (!fs.existsSync(OPENAPI_PATH)) {
        console.error(`❌ OpenAPI 文档不存在: ${OPENAPI_PATH}`);
        process.exit(1);
    }

    console.log('读取 OpenAPI 文档...');
    const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf-8'));

    if (!openapi.paths) {
        openapi.paths = {};
    }

    let added = 0;
    let skipped = 0;
    for (const [pathKey, pathDef] of Object.entries(NEW_PATHS)) {
        if (openapi.paths[pathKey]) {
            console.log(`  ⚠ 路径已存在，跳过: ${pathKey}`);
            skipped++;
            continue;
        }
        openapi.paths[pathKey] = pathDef;
        console.log(`  ✅ 新增路径: ${pathKey}`);
        added++;
    }

    fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2), 'utf-8');
    console.log(`\n✓ OpenAPI 文档更新完成：新增 ${added} 条路径，跳过 ${skipped} 条已存在路径`);
    console.log(`  文档路径: ${OPENAPI_PATH}`);

    // 统计当前路径总数
    const totalPaths = Object.keys(openapi.paths).length;
    console.log(`  当前总路径数: ${totalPaths}`);
}

try {
    main();
} catch (err) {
    console.error('❌ 更新 OpenAPI 文档失败:', err.message);
    console.error(err.stack);
    process.exit(1);
}
