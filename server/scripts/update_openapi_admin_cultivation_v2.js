/**
 * OpenAPI 文档更新脚本 - 修炼配置管理接口扩展（历史版本与回滚）
 *
 * 用途：在已存在的 /api/admin/cultivation/* 路径下补充：
 *   - GET  /api/admin/cultivation/backups   获取配置历史版本列表
 *   - POST /api/admin/cultivation/rollback  一键回滚到指定历史版本
 *
 * 用法：node scripts/update_openapi_admin_cultivation_v2.js
 */
const fs = require('fs');
const path = require('path');

const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

/**
 * GET /api/admin/cultivation/backups
 * 获取配置历史版本列表
 */
openapi.paths['/api/admin/cultivation/backups'] = {
  get: {
    summary: '获取配置历史版本列表',
    description: '查询 server/config/backup/ 目录下所有 seclusion_*.json 和 game_balance_*.json 备份文件。\n\n安全设计：\n- 仅返回 .json 文件\n- 文件名前缀必须是 seclusion_ 或 game_balance_，防止读取其他配置备份\n- 按修改时间倒序排列（最新在前）',
    tags: ['管理员-修炼配置'],
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'type',
        in: 'query',
        description: '按配置类型筛选（不传则返回全部）',
        required: false,
        schema: { type: 'string', enum: ['seclusion', 'game_balance'] }
      }
    ],
    responses: {
      200: {
        description: '历史版本列表',
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
                      filename: { type: 'string', description: '备份文件名', example: 'seclusion_2026-07-03T06-38-07-017Z.json' },
                      configType: { type: 'string', enum: ['seclusion', 'game_balance'] },
                      configLabel: { type: 'string', description: '中文友好名称', example: '闭关配置' },
                      size: { type: 'integer', description: '文件字节数', example: 2048 },
                      sizeText: { type: 'string', description: '文件大小（人类可读）', example: '2.0 KB' },
                      mtime: { type: 'string', format: 'date-time', description: '修改时间 ISO 字符串' },
                      mtimeMs: { type: 'number', description: '修改时间戳（毫秒）', example: 1783063087017 }
                    }
                  }
                }
              }
            }
          }
        }
      },
      401: { description: '未授权', content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } } },
      403: { description: '权限不足', content: { 'application/json': { example: { code: 403, error_code: 'UNAUTHORIZED', message: '权限不足：需要管理员权限' } } } }
    }
  }
};

/**
 * POST /api/admin/cultivation/rollback
 * 一键回滚到指定历史版本
 */
openapi.paths['/api/admin/cultivation/rollback'] = {
  post: {
    summary: '一键回滚到指定历史版本',
    description: '将配置文件回滚到指定的历史备份版本。\n\n安全设计：\n- filename 仅允许字母数字下划线横线点，防止路径穿越攻击\n- 前缀必须是 seclusion_ 或 game_balance_\n- 回滚前自动备份当前版本（形成回滚链，避免误操作不可逆）\n- 回滚后触发热加载\n- 推送全服 Socket.IO 通知告知玩家配置已回滚\n- 记录操作日志（含回滚前后值）',
    tags: ['管理员-修炼配置'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['filename'],
            properties: {
              filename: { type: 'string', description: '备份文件名（不含路径）', example: 'seclusion_2026-07-03T06-38-07-017Z.json' }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: '回滚成功',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'integer', example: 200 },
                message: { type: 'string', example: '已回滚至 seclusion_2026-07-03T06-38-07-017Z.json，配置已热加载' },
                data: {
                  type: 'object',
                  properties: {
                    configType: { type: 'string', enum: ['seclusion', 'game_balance'] },
                    rollbackFrom: { type: 'string', description: '回滚源文件名' },
                    preRollbackBackup: { type: 'string', description: '回滚前自动创建的备份路径', nullable: true }
                  }
                }
              }
            }
          }
        }
      },
      400: {
        description: '业务错误',
        content: {
          'application/json': {
            examples: {
              '参数缺失': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '请提供要回滚的备份文件名 filename' } },
              '文件名格式不合法': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '备份文件名格式不合法' } },
              'JSON格式损坏': { value: { code: 400, error_code: 'VALIDATION_ERROR', message: '备份文件 xxx.json JSON 格式损坏，无法回滚' } }
            }
          }
        }
      },
      404: { description: '备份文件不存在', content: { 'application/json': { example: { code: 404, error_code: 'NOT_FOUND', message: '备份文件 xxx.json 不存在' } } } },
      401: { description: '未授权', content: { 'application/json': { example: { code: 401, message: '未授权，请先登录' } } } },
      403: { description: '权限不足', content: { 'application/json': { example: { code: 403, error_code: 'UNAUTHORIZED', message: '权限不足：需要管理员权限' } } } }
    }
  }
};

fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf8');
console.log('✓ OpenAPI 文档已更新（修炼配置历史版本与回滚接口）：');
console.log('  - GET  /api/admin/cultivation/backups   获取配置历史版本列表');
console.log('  - POST /api/admin/cultivation/rollback  一键回滚到指定历史版本');
