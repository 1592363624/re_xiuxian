/**
 * 修复 /api/sect-war/wars 路径的 GET 方法（被对象字面量覆盖）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

// 为 /api/sect-war/wars 添加 GET 方法
openapi.paths['/api/sect-war/wars'].get = {
    tags: ['宗门战'],
    summary: '获取战役列表',
    description: '分页查询战役，支持按状态过滤',
    security: [{ bearerAuth: [] }],
    parameters: [
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'preparing', 'announced', 'active', 'settled'], default: 'all' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1, maximum: 100 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }
    ],
    responses: {
        200: {
            description: '操作成功',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            data: {
                                type: 'object',
                                properties: {
                                    list: { type: 'array', items: { type: 'object' } },
                                    total: { type: 'integer' },
                                    page: { type: 'integer' },
                                    limit: { type: 'integer' }
                                }
                            }
                        }
                    }
                }
            }
        },
        401: {
            description: '未授权（JWT 缺失或失效）',
            content: { 'application/json': { schema: { type: 'object', properties: { code: { type: 'integer', example: 401 }, message: { type: 'string', example: '令牌无效或已过期' } } } } }
        }
    }
};

// 重新排序：让 GET 在 POST 之前（更符合阅读习惯）
const warsPath = openapi.paths['/api/sect-war/wars'];
const orderedPath = { get: warsPath.get, post: warsPath.post };
openapi.paths['/api/sect-war/wars'] = orderedPath;

fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), 'utf8');
console.log('修复完成。/api/sect-war/wars 现有方法:', Object.keys(openapi.paths['/api/sect-war/wars']));
console.log(`文件大小: ${fs.statSync(openapiPath).size} 字节`);
