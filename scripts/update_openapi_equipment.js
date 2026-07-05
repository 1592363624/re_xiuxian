/**
 * OpenAPI 文档增量更新脚本：法宝深度系统接口
 * 作用：将 8 个玩家端接口 + 6 个 GM 后台接口的定义合并到 docs/openapi.json
 * 运行方式：node scripts/update_openapi_equipment.js
 * 幂等性：相同路径会覆盖旧定义，可重复执行
 */
const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.json');

// 通用安全定义
const bearerAuth = [{ bearerAuth: [] }];

// 通用错误响应
const errResp = (code, msg) => ({
  description: `${code} 错误`,
  content: {
    'application/json': {
      example: { code, message: msg }
    }
  }
});

// 通用 401 响应
const unauthorized = {
  description: '未授权（Token 缺失或失效）',
  content: {
    'application/json': {
      example: { code: 401, message: '未授权，请先登录' }
    }
  }
};

// 通用 403 GM 权限不足响应
const forbidden = {
  description: '权限不足（需要管理员权限）',
  content: {
    'application/json': {
      example: { code: 403, message: '权限不足：需要管理员权限' }
    }
  }
};

// 法宝槽位参数说明
const slotParamDesc = '装备槽位，可选值：weapon（武器）/ armor（防具）/ accessory（饰品）/ boots（靴子）/ dharma（法宝）';

// 玩家端新增接口定义
const playerEndpoints = {
  '/api/equipment/refine': {
    post: {
      summary: '祭炼法器',
      description: '消耗灵石与材料对装备进行祭炼，提升祭炼等级，按百分比增加装备属性。成功率随祭炼等级递减，失败时可能降级（按配置 fail_downgrade_rate）。达到最大祭炼等级后无法继续祭炼。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '祭炼成功或失败结果',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', description: '本次祭炼是否成功', example: true },
                  message: { type: 'string', example: '祭炼成功' },
                  slot: { type: 'string', example: 'weapon' },
                  refine_level: { type: 'integer', description: '祭炼后的等级', example: 2 },
                  cost: {
                    type: 'object',
                    description: '本次消耗',
                    properties: {
                      spirit_stones: { type: 'integer', example: 150 },
                      material_id: { type: 'string', example: 'spirit_coral' },
                      material_quantity: { type: 'integer', example: 2 }
                    }
                  }
                }
              }
            }
          }
        },
        400: errResp(400, '境界不足或材料不足'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/benming': {
    post: {
      summary: '炼制本命法器',
      description: '将装备炼制为本命法器，可获得额外的本命加成。需要满足境界排名要求（默认 realm_rank>=3），消耗灵石与魂幡碎片。每名玩家最多炼制 3 件本命法器，自动分配 benming_slot。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '本命炼制成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '本命炼制成功' },
                  slot: { type: 'string', example: 'weapon' },
                  benming_slot: { type: 'integer', description: '本命槽位编号（0~2）', example: 0 },
                  cost: {
                    type: 'object',
                    properties: {
                      spirit_stones: { type: 'integer', example: 5000 },
                      material_id: { type: 'string', example: 'soul_banner_fragment' },
                      material_quantity: { type: 'integer', example: 5 }
                    }
                  }
                }
              }
            }
          }
        },
        400: errResp(400, '境界不足或本命数量已达上限'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/summon': {
    post: {
      summary: '祭出本命法器',
      description: '将本命法器祭出激活，享受本命加成效果。仅本命法器可祭出；战斗中默认允许祭出，闭关/移动中按配置禁止祭出；同时最多祭出数量受 max_active_treasures 限制。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '祭出成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '法器已祭出' },
                  slot: { type: 'string', example: 'weapon' },
                  is_summoned: { type: 'boolean', example: true }
                }
              }
            }
          }
        },
        400: errResp(400, '非本命法器或当前状态不允许祭出'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/recall': {
    post: {
      summary: '收回本命法器',
      description: '收回已祭出的本命法器，停止本命加成效果。仅对已祭出（is_summoned=true）的法器有效。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '收回成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '法器已收回' },
                  slot: { type: 'string', example: 'weapon' },
                  is_summoned: { type: 'boolean', example: false }
                }
              }
            }
          }
        },
        400: errResp(400, '法器未祭出'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/order': {
    post: {
      summary: '调整法器排序',
      description: '调整装备在槽位中的显示顺序（0~99），用于本命法器之间的优先级排序。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot', 'new_order'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' },
                new_order: { type: 'integer', minimum: 0, maximum: 99, description: '新的排序值（0~99）', example: 5 }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '排序调整成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '排序已调整' },
                  slot: { type: 'string', example: 'weapon' },
                  sort_order: { type: 'integer', example: 5 }
                }
              }
            }
          }
        },
        400: errResp(400, '排序值超出范围'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/disperse': {
    post: {
      summary: '散念（解除本命）',
      description: '解除装备的本命法器状态，回收部分炼制材料（按 disperse_recover_rate 配置比例）。解除后 is_benming=false, spirit_power=0；已祭出的法器需先收回才能散念。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '散念成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '散念成功' },
                  slot: { type: 'string', example: 'weapon' },
                  recovered_material: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'soul_banner_fragment' },
                      quantity: { type: 'integer', example: 2 }
                    }
                  }
                }
              }
            }
          }
        },
        400: errResp(400, '非本命法器或法器已祭出'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/repair': {
    post: {
      summary: '修理法器',
      description: '消耗灵石修理单件装备，恢复耐久至当前最大耐久上限。每次修理会扣减最大耐久上限（按 max_durability_loss_per_repair 配置）。耐久为 0 的装备不提供属性加成；最大耐久低于阈值时建议通过其他途径恢复。',
      tags: ['装备'],
      security: bearerAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slot'],
              properties: {
                slot: { type: 'string', description: slotParamDesc, example: 'weapon' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '修理成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '修理成功，耐久 50 → 99' },
                  slot: { type: 'string', example: 'weapon' },
                  durability: { type: 'integer', description: '修理后耐久', example: 99 },
                  max_durability: { type: 'integer', description: '修理后最大耐久（已扣减）', example: 99 },
                  cost: {
                    type: 'object',
                    properties: {
                      spirit_stones: { type: 'integer', example: 50 },
                      max_durability_loss: { type: 'integer', example: 1 }
                    }
                  }
                }
              }
            }
          }
        },
        400: errResp(400, '耐久已满或灵石不足'),
        401: unauthorized
      }
    }
  },
  '/api/equipment/repair-all': {
    post: {
      summary: '一键修理所有法器',
      description: '遍历玩家所有装备，对耐久未满的装备执行修理。每件装备独立事务，单件失败不影响其他装备。返回总修理数量与总消耗。',
      tags: ['装备'],
      security: bearerAuth,
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
          description: '一键修理结果',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: '修理完成：成功 1 件，消耗 50 灵石' },
                  total_repaired: { type: 'integer', description: '成功修理的装备数', example: 1 },
                  total_cost: { type: 'integer', description: '总消耗灵石', example: 50 },
                  details: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        slot: { type: 'string', example: 'weapon' },
                        success: { type: 'boolean', example: true },
                        durability: { type: 'integer', example: 99 },
                        max_durability: { type: 'integer', example: 99 },
                        cost: { type: 'integer', example: 50 }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        401: unauthorized
      }
    }
  }
};

// GM 后台接口定义
const adminEndpoints = {
  '/api/admin/equipment/list': {
    get: {
      summary: 'GM 查询装备列表',
      description: 'GM 后台分页查询所有玩家的装备记录，支持按关键字（玩家昵称/物品键名）、槽位、是否本命筛选。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '页码' },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: '每页数量' },
        { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '搜索关键字（玩家昵称或物品键名）' },
        { name: 'slot', in: 'query', schema: { type: 'string', enum: ['weapon', 'armor', 'accessory', 'boots', 'dharma'] }, description: '槽位筛选' },
        { name: 'is_benming', in: 'query', schema: { type: 'boolean' }, description: '是否本命法器筛选' }
      ],
      responses: {
        200: {
          description: '装备列表',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  data: {
                    type: 'object',
                    properties: {
                      list: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer', example: 1 },
                            player_id: { type: 'integer', example: 1 },
                            slot: { type: 'string', example: 'weapon' },
                            item_key: { type: 'string', example: 'wooden_sword' },
                            equipped_at: { type: 'string', format: 'date-time' },
                            durability: { type: 'integer', example: 99 },
                            max_durability: { type: 'integer', example: 99 },
                            refine_level: { type: 'integer', example: 1 },
                            is_benming: { type: 'boolean', example: false },
                            benming_slot: { type: 'integer', nullable: true },
                            spirit_power: { type: 'integer', example: 0 },
                            sort_order: { type: 'integer', example: 5 },
                            is_summoned: { type: 'boolean', example: false },
                            createdAt: { type: 'string', format: 'date-time' }
                          }
                        }
                      },
                      total: { type: 'integer', example: 1 },
                      page: { type: 'integer', example: 1 },
                      pageSize: { type: 'integer', example: 20 }
                    }
                  }
                }
              }
            }
          }
        },
        401: unauthorized,
        403: forbidden
      }
    }
  },
  '/api/admin/equipment/{playerId}': {
    get: {
      summary: 'GM 查询玩家装备详情',
      description: 'GM 后台查询指定玩家的所有装备记录及玩家基础信息（昵称、境界、灵石）。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家 ID' }
      ],
      responses: {
        200: {
          description: '玩家装备详情',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  data: {
                    type: 'object',
                    properties: {
                      player: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer', example: 1 },
                          nickname: { type: 'string', example: '韩天尊' },
                          realm: { type: 'string', example: '炼气10层' },
                          realm_rank: { type: 'integer', example: 1 },
                          spirit_stones: { type: 'integer', example: 3350 }
                        }
                      },
                      equipments: {
                        type: 'array',
                        items: { type: 'object' }
                      },
                      count: { type: 'integer', example: 1 }
                    }
                  }
                }
              }
            }
          }
        },
        401: unauthorized,
        403: forbidden,
        404: errResp(404, '玩家不存在')
      }
    }
  },
  '/api/admin/equipment/{playerId}/record/{id}': {
    put: {
      summary: 'GM 修改装备字段',
      description: 'GM 后台修改指定装备记录的字段。支持字段白名单：durability, max_durability, refine_level, is_benming, benming_slot, spirit_power, sort_order, is_summoned。所有字段均做范围校验。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家 ID' },
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '装备记录 ID' }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                durability: { type: 'integer', minimum: 0, description: '当前耐久' },
                max_durability: { type: 'integer', minimum: 1, description: '最大耐久' },
                refine_level: { type: 'integer', minimum: 0, maximum: 15, description: '祭炼等级' },
                is_benming: { type: 'boolean', description: '是否本命法器' },
                benming_slot: { type: 'integer', nullable: true, minimum: 0, maximum: 2, description: '本命槽位' },
                spirit_power: { type: 'integer', minimum: 0, description: '本命法力值' },
                sort_order: { type: 'integer', minimum: 0, maximum: 99, description: '排序值' },
                is_summoned: { type: 'boolean', description: '是否祭出' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: '修改成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  message: { type: 'string', example: '装备记录已更新' },
                  data: { type: 'object', description: '更新后的装备记录' }
                }
              }
            }
          }
        },
        400: errResp(400, '字段值超出范围'),
        401: unauthorized,
        403: forbidden,
        404: errResp(404, '装备记录不存在')
      }
    },
    delete: {
      summary: 'GM 强制卸下装备',
      description: 'GM 后台强制卸下指定装备，将装备物品归还到玩家储物袋，并删除装备记录。用于处理异常状态或违规装备。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家 ID' },
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '装备记录 ID' }
      ],
      responses: {
        200: {
          description: '卸下成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  message: { type: 'string', example: '已强制卸下 weapon 槽位装备并归还物品' }
                }
              }
            }
          }
        },
        401: unauthorized,
        403: forbidden,
        404: errResp(404, '装备记录不存在')
      }
    }
  },
  '/api/admin/equipment/{playerId}/record/{id}/reset': {
    post: {
      summary: 'GM 重置装备',
      description: 'GM 后台重置装备到初始状态：耐久/最大耐久恢复到配置的 initial_max，祭炼等级归零，取消本命标记，法力值清零，祭出状态取消。排序值保留。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家 ID' },
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '装备记录 ID' }
      ],
      responses: {
        200: {
          description: '重置成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  message: { type: 'string', example: '装备记录已重置' },
                  data: { type: 'object', description: '重置后的装备记录' }
                }
              }
            }
          }
        },
        401: unauthorized,
        403: forbidden,
        404: errResp(404, '装备记录不存在')
      }
    }
  },
  '/api/admin/equipment/{playerId}/repair-all': {
    post: {
      summary: 'GM 一键修理（无消耗）',
      description: 'GM 后台对指定玩家的所有装备执行一键修理，不消耗灵石、不扣减最大耐久上限。用于处理玩家异常状态或补偿操作。',
      tags: ['装备管理'],
      security: bearerAuth,
      parameters: [
        { name: 'playerId', in: 'path', required: true, schema: { type: 'integer' }, description: '玩家 ID' }
      ],
      requestBody: {
        required: false,
        content: { 'application/json': { schema: { type: 'object', properties: {} } } }
      },
      responses: {
        200: {
          description: '一键修理结果',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', example: 200 },
                  message: { type: 'string', example: 'GM 一键修理完成，共修理 1 件装备' },
                  data: {
                    type: 'object',
                    properties: {
                      repaired: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer', example: 1 },
                            slot: { type: 'string', example: 'weapon' },
                            durability: { type: 'integer', example: 80 },
                            max_durability: { type: 'integer', example: 80 }
                          }
                        }
                      },
                      count: { type: 'integer', example: 1 }
                    }
                  }
                }
              }
            }
          }
        },
        401: unauthorized,
        403: forbidden
      }
    }
  }
};

// 合并新接口到 openapi.json
function updateOpenAPI() {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
  const doc = JSON.parse(raw);
  if (!doc.paths) doc.paths = {};

  let added = 0;
  let updated = 0;

  const allNew = { ...playerEndpoints, ...adminEndpoints };
  for (const [path, methods] of Object.entries(allNew)) {
    if (!doc.paths[path]) {
      doc.paths[path] = {};
      added++;
    } else {
      updated++;
    }
    Object.assign(doc.paths[path], methods);
  }

  // 确保 tags 存在
  if (!doc.tags) doc.tags = [];
  const existingTags = new Set(doc.tags.map(t => t.name));
  if (!existingTags.has('装备管理')) {
    doc.tags.push({ name: '装备管理', description: 'GM 后台装备管理接口' });
  }

  fs.writeFileSync(OPENAPI_PATH, JSON.stringify(doc, null, 2), 'utf-8');
  console.log(`[OK] 新增 ${added} 个路径，更新 ${updated} 个路径`);
  console.log(`[OK] 已写入 ${OPENAPI_PATH}`);
  console.log(`[OK] 当前总路径数: ${Object.keys(doc.paths).length}`);
}

try {
  updateOpenAPI();
} catch (err) {
  console.error('[FAIL]', err.message);
  process.exit(1);
}
