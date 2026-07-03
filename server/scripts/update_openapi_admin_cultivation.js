/**
 * OpenAPI 文档更新脚本 - 修炼配置管理接口
 *
 * 用途：同步更新 docs/openapi.json 中新增的修炼配置管理接口文档
 *       反映本次新增的 GM 后台修炼参数热加载能力
 *
 * 用法：node scripts/update_openapi_admin_cultivation.js
 */
const fs = require('fs');
const path = require('path');

// 项目根目录位于 server/scripts/ 的上两级，docs 目录在项目根下
const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');

// 读取并解析现有 openapi.json
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

/**
 * 修炼配置管理接口（新增）
 * 提供 GM 后台对闭关与历练参数的可视化编辑与热加载
 */
openapi.paths['/api/admin/cultivation/config'] = {
  get: {
    summary: '获取修炼配置（闭关双模式 + 历练时长分级）',
    description: '查询当前闭关（常规/深度）与历练（时长分级 short/medium/long）的所有参数。\n\n返回结构：\n- seclusion.normal：常规闭关参数（max_duration, daily_limit, cooldown, exp_rate）\n- seclusion.deep：深度闭关参数（min_duration, max_duration, daily_limit, cooldown, exp_rate, min_realm, forced_penalty）\n- seclusion.base_exp_rate：闭关基础修为速率\n- adventure.duration_types：三档时长配置（short/medium/long）\n- adventure.default_duration_type：默认时长类型\n- adventure.early_finish_penalty：提前结束惩罚比例',
    tags: ['管理员-修炼配置'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '修炼配置',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                data: {
                  type: 'object',
                  properties: {
                    seclusion: {
                      type: 'object',
                      properties: {
                        base_exp_rate: { type: 'number', description: '闭关基础修为速率（每秒）', example: 1 },
                        normal: {
                          type: 'object',
                          description: '常规闭关配置',
                          properties: {
                            max_duration: { type: 'integer', description: '单次最长时长（秒）', example: 1800 },
                            daily_limit: { type: 'integer', description: '每日次数上限', example: 3 },
                            cooldown: { type: 'integer', description: '冷却时间（秒）', example: 300 },
                            exp_rate: { type: 'number', description: '收益倍率', example: 1 }
                          }
                        },
                        deep: {
                          type: 'object',
                          description: '深度闭关配置',
                          properties: {
                            min_duration: { type: 'integer', description: '最短时长（秒）', example: 14400 },
                            max_duration: { type: 'integer', description: '最长时长（秒）', example: 28800 },
                            daily_limit: { type: 'integer', description: '每日次数上限', example: 1 },
                            cooldown: { type: 'integer', description: '冷却时间（秒）', example: 3600 },
                            exp_rate: { type: 'number', description: '收益倍率', example: 2 },
                            min_realm: { type: 'string', description: '境界要求', example: '筑基期' },
                            forced_penalty: { type: 'number', description: '强行出关损失比例（0-1）', example: 0.5 }
                          }
                        }
                      }
                    },
                    adventure: {
                      type: 'object',
                      properties: {
                        duration_types: {
                          type: 'object',
                          description: '三档时长配置',
                          properties: {
                            short: { $ref: '#/components/schemas/DurationTypeConfig' },
                            medium: { $ref: '#/components/schemas/DurationTypeConfig' },
                            long: { $ref: '#/components/schemas/DurationTypeConfig' }
                          }
                        },
                        default_duration_type: { type: 'string', enum: ['short', 'medium', 'long'], example: 'medium' },
                        early_finish_penalty: { type: 'number', description: '提前结束惩罚比例（0-1）', example: 0.5 }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      },
      403: {
        description: '权限不足',
        content: { 'application/json': { example: { code: 403, error_code: 'UNAUTHORIZED', message: '权限不足：需要管理员权限' } } }
      }
    }
  }
};

openapi.paths['/api/admin/cultivation/seclusion'] = {
  post: {
    summary: '更新闭关配置（双模式整体替换，热加载）',
    description: '更新闭关（常规/深度）配置参数，写回 seclusion.json 并触发热加载，无需重启服务。\n\n安全设计：\n- 字段白名单：仅允许预定义字段更新\n- 数值范围校验：所有数值参数限定合理区间\n- 配置备份：写文件前自动备份到 server/config/backup/\n- 操作日志：记录到 AdminLog（含修改前后值）',
    tags: ['管理员-修炼配置'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              base_exp_rate: { type: 'number', description: '闭关基础修为速率（0.1-100）', nullable: true, example: 1.5 },
              normal: {
                type: 'object',
                description: '常规闭关配置（任意字段可选，仅更新提供的字段）',
                nullable: true,
                properties: {
                  max_duration: { type: 'integer', description: '单次最长时长（60-7200秒）', example: 1800 },
                  daily_limit: { type: 'integer', description: '每日次数上限（1-100）', example: 3 },
                  cooldown: { type: 'integer', description: '冷却时间（0-86400秒）', example: 300 },
                  exp_rate: { type: 'number', description: '收益倍率（0.1-100）', example: 1 }
                }
              },
              deep: {
                type: 'object',
                description: '深度闭关配置（任意字段可选，仅更新提供的字段）',
                nullable: true,
                properties: {
                  min_duration: { type: 'integer', description: '最短时长（600-86400秒）', example: 14400 },
                  max_duration: { type: 'integer', description: '最长时长（600-172800秒）', example: 28800 },
                  daily_limit: { type: 'integer', description: '每日次数上限（1-50）', example: 1 },
                  cooldown: { type: 'integer', description: '冷却时间（0-172800秒）', example: 3600 },
                  exp_rate: { type: 'number', description: '收益倍率（0.1-100）', example: 2 },
                  min_realm: { type: 'string', description: '境界要求', example: '筑基期' },
                  forced_penalty: { type: 'number', description: '强行出关损失比例（0-1）', example: 0.5 }
                }
              }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: '闭关配置已更新并热加载',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '闭关配置已更新并热加载' },
                data: {
                  type: 'object',
                  properties: {
                    normal: { type: 'object', description: '更新后的常规闭关配置' },
                    deep: { type: 'object', description: '更新后的深度闭关配置' },
                    base_exp_rate: { type: 'number', example: 1.5 },
                    backup: { type: 'string', description: '备份文件路径', nullable: true }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误（参数缺失、数值范围校验失败等）',
        content: {
          'application/json': {
            examples: {
              '参数缺失': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '请至少提供 normal、deep 或 base_exp_rate 中的一个字段' } },
              '数值范围错误': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '常规闭关单次时长必须在 60-7200 秒之间' } },
              '逻辑冲突': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '深度闭关最短时长不能大于最长时长' } }
            }
          }
        }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      },
      403: {
        description: '权限不足',
        content: { 'application/json': { example: { code: 403, error_code: 'UNAUTHORIZED', message: '权限不足：需要管理员权限' } } }
      }
    }
  }
};

openapi.paths['/api/admin/cultivation/adventure'] = {
  post: {
    summary: '更新历练配置（时长分级整体替换，热加载）',
    description: '更新历练（时长分级 short/medium/long）配置参数，写回 game_balance.json 的 adventure 段并触发热加载。\n\n安全设计：\n- 字段白名单\n- 数值范围校验\n- 配置备份\n- 操作日志',
    tags: ['管理员-修炼配置'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              duration_types: {
                type: 'object',
                description: '三档时长配置（任意字段可选）',
                nullable: true,
                properties: {
                  short: { $ref: '#/components/schemas/DurationTypeConfig' },
                  medium: { $ref: '#/components/schemas/DurationTypeConfig' },
                  long: { $ref: '#/components/schemas/DurationTypeConfig' }
                }
              },
              default_duration_type: { type: 'string', enum: ['short', 'medium', 'long'], nullable: true, example: 'medium' },
              early_finish_penalty: { type: 'number', description: '提前结束惩罚比例（0-1）', nullable: true, example: 0.5 }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: '历练配置已更新并热加载',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '历练配置已更新并热加载' },
                data: {
                  type: 'object',
                  properties: {
                    adventure: { type: 'object', description: '更新后的历练配置' },
                    backup: { type: 'string', description: '备份文件路径', nullable: true }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误',
        content: { 'application/json': { example: { code: 400, error_code: 'VALIDATION_ERROR', message: '历练 short 时长必须在 10-3600 秒之间' } } }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      },
      403: {
        description: '权限不足',
        content: { 'application/json': { example: { code: 403, error_code: 'UNAUTHORIZED', message: '权限不足：需要管理员权限' } } }
      }
    }
  }
};

// 添加 DurationTypeConfig 复用 schema
if (!openapi.components) openapi.components = {};
if (!openapi.components.schemas) openapi.components.schemas = {};

openapi.components.schemas['DurationTypeConfig'] = {
  type: 'object',
  description: '单档时长配置',
  properties: {
    duration: { type: 'integer', description: '时长（秒，10-3600）', example: 90 },
    reward_multiplier: { type: 'number', description: '奖励倍率（0.1-10）', example: 1.0 },
    injury_chance: { type: 'number', description: '受伤概率（0-1）', example: 0.05 },
    injury_hp_loss_rate: { type: 'number', description: '受伤气血损失比例（0-1）', example: 0.08 },
    label: { type: 'string', description: '显示标签', example: '中时历练' }
  }
};

// 添加新 tag 分组
if (!openapi.tags) openapi.tags = [];
if (!openapi.tags.find(t => t.name === '管理员-修炼配置')) {
  openapi.tags.push({
    name: '管理员-修炼配置',
    description: 'GM 后台修炼参数管理（闭关 + 历练，支持热加载）'
  });
}

// 写回文件
fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf8');
console.log('✓ OpenAPI 文档已更新（修炼配置管理接口）：');
console.log('  - GET  /api/admin/cultivation/config   获取修炼配置');
console.log('  - POST /api/admin/cultivation/seclusion 更新闭关配置（热加载）');
console.log('  - POST /api/admin/cultivation/adventure 更新历练配置（热加载）');
console.log('  - 新增 schema: DurationTypeConfig');
console.log('  - 新增 tag: 管理员-修炼配置');
