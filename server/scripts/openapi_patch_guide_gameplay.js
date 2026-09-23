/**
 * 注入批次6 指南补完·纯玩法 的 OpenAPI 路径
 * 玩法：琉璃古塔 / 剑诀线 / 事件奇遇 / 宗门外交 / 落云宗定脉
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OPENAPI = path.join(__dirname, '../../docs/openapi.json');
const doc = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));
doc.paths = doc.paths || {};
doc.tags = doc.tags || [];

function ensureTag(name, description) {
    if (!doc.tags.find(t => t.name === name)) {
        doc.tags.push({ name, description });
    }
}

function okRef(desc) {
    return {
        200: {
            description: '成功',
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            code: { type: 'integer', example: 200 },
                            message: { type: 'string', example: desc },
                            data: { type: 'object' }
                        }
                    }
                }
            }
        }
    };
}

function get(pathKey, tag, summary, description) {
    doc.paths[pathKey] = doc.paths[pathKey] || {};
    doc.paths[pathKey].get = {
        tags: [tag],
        summary,
        description,
        responses: okRef(summary),
        security: [{ bearerAuth: [] }]
    };
}

function post(pathKey, tag, summary, description, bodyProps) {
    doc.paths[pathKey] = doc.paths[pathKey] || {};
    doc.paths[pathKey].post = {
        tags: [tag],
        summary,
        description,
        requestBody: bodyProps ? {
            required: false,
            content: {
                'application/json': {
                    schema: { type: 'object', properties: bodyProps }
                }
            }
        } : undefined,
        responses: okRef(summary),
        security: [{ bearerAuth: [] }]
    };
}

ensureTag('琉璃古塔', '玩法文档第30节·古塔流程：闯塔/继续/退出/重置 + 琉璃塔榜');
ensureTag('剑诀', '玩法文档第30节·剑诀线：合成/参悟/炼剑/剑阵');
ensureTag('事件奇遇', '玩法文档第22节·隐藏/事件式命令');
ensureTag('宗门外交', '玩法文档第33节·天下大势/示好/结盟/敌对');
ensureTag('灵树定脉', '玩法文档第25节·落云宗云梦灵眼定脉');

get('/api/pagoda/info', '琉璃古塔', '获取古塔配置', '返回全局参数与各层守关灵影配置');
get('/api/pagoda/status', '琉璃古塔', '获取闯塔状态', '最高层/今日次数/冷却/首通标记');
get('/api/pagoda/ranking', '琉璃古塔', '琉璃塔榜', '按最佳分降序 Top N');
get('/api/pagoda/history', '琉璃古塔', '闯关历史', '最近闯关记录');
post('/api/pagoda/climb', '琉璃古塔', '闯塔/继续闯塔', '自动回合制模拟守关灵影，胜则推进层数', {});
post('/api/pagoda/exit', '琉璃古塔', '退出古塔', '放弃本轮塔中进度', {});
post('/api/pagoda/reset', '琉璃古塔', '重置古塔', '花费灵石清空最高层进度', {});

get('/api/sword-art/info', '剑诀', '获取剑诀配置', '剑诀图鉴与剑阵列表');
get('/api/sword-art/status', '剑诀', '我的剑诀', '已掌握剑诀/剑意/炼剑阶/剑阵状态');
post('/api/sword-art/compose', '剑诀', '合成剑诀', '消耗古剑诀残篇合成剑诀', { manual_id: { type: 'string' } });
post('/api/sword-art/comprehend', '剑诀', '参悟剑诀', '消耗修为提升剑意', { manual_id: { type: 'string' } });
post('/api/sword-art/refine', '剑诀', '炼剑', '分阶推进炼剑阶数', { manual_id: { type: 'string' } });
post('/api/sword-art/formation/inspect', '剑诀', '参悟剑阵', '检查剑阵解锁条件', { formation_id: { type: 'string' } });
post('/api/sword-art/formation/deploy', '剑诀', '布下剑阵', '布下剑阵获得展示向护持状态', { formation_id: { type: 'string' } });

get('/api/fated-event/info', '事件奇遇', '奇遇图鉴', '七类事件与命令提示');
get('/api/fated-event/status', '事件奇遇', '当前奇遇', '未决奇遇与最近记录');
post('/api/fated-event/trigger', '事件奇遇', '感应天机', '触发一次奇遇', { event_id: { type: 'string' } });
post('/api/fated-event/choose', '事件奇遇', '作出抉择', '抉择或答题，结算奖惩', { choice_id: { type: 'string' } });

get('/api/sect-diplomacy/info', '宗门外交', '外交配置', '宗门列表与行动规则');
get('/api/sect-diplomacy/world', '宗门外交', '天下大势', '全服宗门关系两两矩阵');
get('/api/sect-diplomacy/mine', '宗门外交', '本宗关系', '我所在宗门的外交关系');
post('/api/sect-diplomacy/act', '宗门外交', '外交行动', '示好/结盟/敌对/解除', {
    target_sect_id: { type: 'string' },
    action: { type: 'string', enum: ['goodwill', 'ally', 'hostile', 'break_relation'] }
});

get('/api/dingmai/info', '灵树定脉', '定脉配置', '动作/脉象/灵根修正');
get('/api/dingmai/status', '灵树定脉', '定脉状态', '树态/个人次数/榜单');
post('/api/dingmai/act', '灵树定脉', '定脉动作', '注灵/固脉/净浊/冲脉', {
    action: { type: 'string', enum: ['infuse', 'stabilize', 'purify', 'charge'] },
    element: { type: 'string', enum: ['metal', 'wood', 'water', 'fire', 'earth'] }
});

fs.writeFileSync(OPENAPI, JSON.stringify(doc, null, 2) + '\n', 'utf8');
const added = [
    '/api/pagoda/info', '/api/pagoda/status', '/api/pagoda/ranking', '/api/pagoda/history',
    '/api/pagoda/climb', '/api/pagoda/exit', '/api/pagoda/reset',
    '/api/sword-art/info', '/api/sword-art/status', '/api/sword-art/compose', '/api/sword-art/comprehend',
    '/api/sword-art/refine', '/api/sword-art/formation/inspect', '/api/sword-art/formation/deploy',
    '/api/fated-event/info', '/api/fated-event/status', '/api/fated-event/trigger', '/api/fated-event/choose',
    '/api/sect-diplomacy/info', '/api/sect-diplomacy/world', '/api/sect-diplomacy/mine', '/api/sect-diplomacy/act',
    '/api/dingmai/info', '/api/dingmai/status', '/api/dingmai/act'
];
console.log(`OpenAPI 注入完成：+${added.length} paths，+5 tags`);
console.log(`当前 paths 总数：${Object.keys(doc.paths).length}`);
