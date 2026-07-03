/**
 * OpenAPI 文档更新脚本
 *
 * 用途：同步更新 docs/openapi.json 中闭关与历练相关接口文档，
 *       反映本次重构（常规/深度闭关、时长分级、提前结束惩罚、强行出关）。
 *
 * 用法：node scripts/update_openapi_seclusion_adventure.js
 */
const fs = require('fs');
const path = require('path');

// 项目根目录位于 server/scripts/ 的上两级，docs 目录在项目根下
const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');

// 读取并解析现有 openapi.json
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

/**
 * 闭关接口（重构版）
 * 区分常规闭关（normal）与深度闭关（deep）
 */
openapi.paths['/api/seclusion/start'] = {
  post: {
    summary: '开始闭关（支持常规/深度双模式）',
    description: '开始闭关修炼。\n\n两种模式：\n- 常规闭关（normal）：短时挂机，单次最长 30 分钟，每日 3 次，冷却 5 分钟，基础收益。\n- 深度闭关（deep）：长线挂机 4-8 小时，每日 1 次，2 倍收益，需筑基期以上境界。\n\n深度闭关未达最短时长结束时按强行出关处理，损失 50% 收益。',
    tags: ['闭关修炼'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['normal', 'deep'],
                default: 'normal',
                description: '闭关模式：normal=常规闭关，deep=深度闭关'
              },
              duration: {
                type: 'integer',
                description: '期望闭关时长（秒）。常规闭关最长 1800 秒，深度闭关 14400-28800 秒。',
                example: 1800
              }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: '进入闭关状态',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '进入常规闭关状态' },
                data: {
                  type: 'object',
                  properties: {
                    is_secluded: { type: 'boolean', example: true },
                    seclusion_mode: { type: 'string', enum: ['normal', 'deep'], example: 'normal' },
                    seclusion_start_time: { type: 'string', format: 'date-time' },
                    seclusion_end_time: { type: 'string', format: 'date-time' },
                    seclusion_duration: { type: 'integer', description: '闭关总时长（秒）', example: 1800 }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误（已在闭关中、移动中、境界不足、次数用尽、冷却中）',
        content: {
          'application/json': {
            examples: {
              '已在闭关中': { value: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '玩家已在闭关中' } },
              '境界不足': { value: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '深度闭关需达到 筑基期 境界' } },
              '次数用尽': { value: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '今日常规闭关次数已用尽（每日 3 次）' } },
              '冷却中': { value: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '闭关冷却中，还需等待 5 分钟' } }
            }
          }
        }
      },
      401: {
        description: '未授权（Token 缺失或失效）',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      }
    }
  }
};

openapi.paths['/api/seclusion/end'] = {
  post: {
    summary: '结束闭关（正常结算）',
    description: '结束当前闭关并结算修为收益。\n\n- 常规闭关：可随时结束，按实际时长 × 基础收益 × 境界加成结算。\n- 深度闭关：未达最短时长时按强行出关处理，损失 forced_penalty（默认 50%）比例收益；达到最短时长后正常结算。',
    tags: ['闭关修炼'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '闭关结算成功',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '常规闭关结束，本次获得修为 1800 点。下次闭关需间隔 5 分钟。' },
                data: {
                  type: 'object',
                  properties: {
                    exp_gain: { type: 'integer', description: '本次获得修为', example: 1800 },
                    actual_duration: { type: 'integer', description: '实际闭关时长（秒）', example: 1800 },
                    seclusion_mode: { type: 'string', enum: ['normal', 'deep'], example: 'normal' },
                    forced_end: { type: 'boolean', description: '是否属于强行出关（深度闭关未达最短时长）', example: false },
                    penalty_rate: { type: 'number', description: '收益系数（强行出关时为 0.5，正常为 1.0）', example: 1.0 },
                    cooldown_seconds: { type: 'integer', description: '下次闭关冷却时间（秒）', example: 300 },
                    player: {
                      type: 'object',
                      properties: {
                        exp: { type: 'string', description: '玩家当前修为（字符串避免大数溢出）' },
                        is_secluded: { type: 'boolean', example: false },
                        last_seclusion_time: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误（未在闭关中）',
        content: { 'application/json': { example: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '玩家未在闭关中' } } }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      }
    }
  }
};

// 新增：强行出关接口
openapi.paths['/api/seclusion/force-end'] = {
  post: {
    summary: '强行出关（深度闭关专用快捷接口）',
    description: '强行结束深度闭关。逻辑等同 /api/seclusion/end，仅作为语义上的快捷入口。\n\n深度闭关未达最短时长时，损失 forced_penalty（默认 50%）比例收益。',
    tags: ['闭关修炼'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '强行出关结算成功（响应格式同 /api/seclusion/end）',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '深度闭关结束，本次获得修为 7200 点（强行出关，损失 50% 收益）。下次闭关需间隔 60 分钟。' },
                data: {
                  type: 'object',
                  properties: {
                    exp_gain: { type: 'integer', example: 7200 },
                    actual_duration: { type: 'integer', example: 7200 },
                    seclusion_mode: { type: 'string', example: 'deep' },
                    forced_end: { type: 'boolean', example: true },
                    penalty_rate: { type: 'number', example: 0.5 },
                    cooldown_seconds: { type: 'integer', example: 3600 }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误（未在闭关中）',
        content: { 'application/json': { example: { code: 400, error_code: 'BUSINESS_LOGIC_ERROR', message: '玩家未在闭关中' } } }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      }
    }
  }
};

openapi.paths['/api/seclusion/status'] = {
  get: {
    summary: '获取闭关状态（含双模式配置与每日次数）',
    description: '查询当前闭关状态，包括：\n- 闭关模式（normal/deep）与进度\n- 已获修为、剩余时间\n- 每日剩余次数（常规/深度）\n- 闭关配置信息（供前端展示与模式选择）\n\n跨日时会自动重置每日闭关次数。',
    tags: ['闭关修炼'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '闭关状态',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                data: {
                  type: 'object',
                  properties: {
                    is_secluded: { type: 'boolean', example: false },
                    seclusion_mode: { type: 'string', enum: ['normal', 'deep'], example: 'normal' },
                    seclusion_start_time: { type: 'string', format: 'date-time', nullable: true },
                    seclusion_end_time: { type: 'string', format: 'date-time', nullable: true },
                    seclusion_duration: { type: 'integer', example: 0 },
                    exp_rate: { type: 'number', description: '基础修为速率（每秒）', example: 1 },
                    exp_gained: { type: 'integer', description: '已获修为（闭关中实时计算）', example: 0 },
                    current_duration: { type: 'integer', description: '已闭关时长（秒）', example: 0 },
                    remaining_time: { type: 'integer', description: '剩余时间（秒）', example: 0 },
                    progress: { type: 'integer', description: '进度百分比（0-100）', example: 0 },
                    daily_seclusion_count: { type: 'integer', description: '今日常规闭关已用次数', example: 0 },
                    daily_deep_seclusion_count: { type: 'integer', description: '今日深度闭关已用次数', example: 0 },
                    normal_remaining: { type: 'integer', description: '今日常规闭关剩余次数', example: 3 },
                    deep_remaining: { type: 'integer', description: '今日深度闭关剩余次数', example: 1 },
                    normal_config: {
                      type: 'object',
                      description: '常规闭关配置',
                      properties: {
                        max_duration: { type: 'integer', example: 1800 },
                        daily_limit: { type: 'integer', example: 3 },
                        cooldown: { type: 'integer', example: 300 },
                        exp_rate: { type: 'number', example: 1 }
                      }
                    },
                    deep_config: {
                      type: 'object',
                      description: '深度闭关配置',
                      properties: {
                        min_duration: { type: 'integer', example: 14400 },
                        max_duration: { type: 'integer', example: 28800 },
                        daily_limit: { type: 'integer', example: 1 },
                        cooldown: { type: 'integer', example: 3600 },
                        exp_rate: { type: 'number', example: 2 },
                        min_realm: { type: 'string', example: '筑基期' },
                        forced_penalty: { type: 'number', example: 0.5 }
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
      }
    }
  }
};

/**
 * 历练接口（重构版）
 * 时长分级 short/medium/long，含提前结束惩罚与受伤风险
 */
openapi.paths['/api/map/explore/start'] = {
  post: {
    summary: '开始历练（支持时长分级 short/medium/long）',
    description: '在当前地图开始历练，生成随机事件。\n\n时长分级：\n- short（短时历练）：30 秒，0.6x 奖励，0% 受伤概率\n- medium（中时历练，默认）：90 秒，1.0x 奖励，5% 受伤概率\n- long（长时历练）：300 秒，1.8x 奖励，10% 受伤概率\n\n提前结束惩罚：奖励 = 基础奖励 × (已时长/总时长) × (1 - early_finish_penalty)，early_finish_penalty 默认 0.5，不设保底，防止玩家反复"开始→立即结束"刷保底。',
    tags: ['历练探索'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              durationType: {
                type: 'string',
                enum: ['short', 'medium', 'long'],
                default: 'medium',
                description: '时长类型：short=短时(30s,0.6x)，medium=中时(90s,1.0x)，long=长时(300s,1.8x)'
              },
              duration: {
                type: 'integer',
                description: '（兼容旧参数）直接指定时长（秒），durationType 优先',
                nullable: true
              }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: '历练已开始',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '历练已开始' },
                data: {
                  type: 'object',
                  properties: {
                    adventure_id: { type: 'integer', example: 62 },
                    event: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['peaceful', 'combat', 'encounter'], example: 'peaceful' },
                        title: { type: 'string', example: '修炼感悟' },
                        description: { type: 'string', example: '正午的越国显得格外宁静，你漫步其中，心中感悟颇多' },
                        duration: { type: 'integer', description: '历练时长（秒）', example: 30 },
                        aiGenerated: { type: 'boolean', example: true }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误（已在历练中、闭关中、移动中等）',
        content: { 'application/json': { example: { code: 400, message: '您正在闭关中，无法开始历练' } } }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      },
      503: {
        description: '历练服务暂不可用',
        content: { 'application/json': { example: { code: 503, message: '历练服务暂不可用' } } }
      }
    }
  }
};

openapi.paths['/api/map/explore/complete'] = {
  post: {
    summary: '完成历练（结算奖励，含提前结束惩罚与受伤风险）',
    description: '结束当前历练并领取奖励。\n\n奖励计算：\n- 正常完成：奖励 = 基础奖励 × 时长倍率\n- 提前结束：奖励 = 基础奖励 × (已时长/总时长) × (1 - early_finish_penalty) × 时长倍率，不设保底\n\n风险机制：历练结束时按 injury_chance 概率受伤，损失当前气血的 injury_hp_loss_rate 比例。',
    tags: ['历练探索'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '历练完成',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '历练完成' },
                data: {
                  type: 'object',
                  properties: {
                    rewards: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean', example: true },
                        granted: {
                          type: 'object',
                          properties: {
                            exp: { type: 'integer', description: '获得修为', example: 54 },
                            items: { type: 'array', items: { type: 'object' }, description: '获得物品列表' },
                            spirit_stones: { type: 'integer', description: '获得灵石', example: 10 }
                          }
                        },
                        early_finish: { type: 'boolean', description: '是否提前结束', example: true },
                        reward_scale: { type: 'string', description: '奖励缩放比例（提前结束时返回，如 "25%"）', example: '25%' },
                        injury: {
                          type: 'object',
                          nullable: true,
                          description: '受伤信息（按概率触发，可为 null）',
                          properties: {
                            hp_loss: { type: 'integer', description: '损失的气血', example: 24 }
                          }
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
      400: {
        description: '业务错误（未在历练中、历练尚未结束等）',
        content: { 'application/json': { example: { code: 'ADVENTURE_NOT_COMPLETED', message: '历练尚未结束，请等待 0分40秒' } } }
      },
      401: {
        description: '未授权',
        content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } }
      }
    }
  }
};

// 写回文件（UTF-8 无 BOM，2 空格缩进）
fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf8');
console.log('✓ OpenAPI 文档已更新：');
console.log('  - /api/seclusion/start（新增 mode 参数与深度闭关说明）');
console.log('  - /api/seclusion/end（新增 forced_end、penalty_rate 字段）');
console.log('  - /api/seclusion/force-end（新增强行出关接口）');
console.log('  - /api/seclusion/status（新增双模式配置与每日次数字段）');
console.log('  - /api/map/explore/start（新增 durationType 参数与时长分级说明）');
console.log('  - /api/map/explore/complete（新增提前结束惩罚与受伤风险说明）');
