/**
 * OpenAPI 文档批量更新脚本：为血色试炼（xuese）接入接口定义
 *
 * 更新内容：
 *   1. /api/multi-dungeon/create：dungeon_key enum 添加 "xuese"，description 添加血色试炼说明
 *   2. /api/multi-dungeon/advance：summary 改为"昆吾山第四幕 / 虚天殿第六幕 / 苍坤洞府第四幕 / 血色试炼第四幕"
 *   3. /api/multi-dungeon/rewards：dungeon_key enum 添加 "xuese"，description 添加血色奖励特色说明
 *   4. /api/multi-dungeon/cooldown：description 改为"共 8 个副本"
 *   5. /api/admin/multi-dungeon/grant-reward：dungeon_key enum 添加 "xuese"
 *   6. /api/admin/multi-dungeon/reset-cooldown：dungeon_key enum 添加 "xuese"
 *
 * 幂等性：脚本可重复执行，已存在 "xuese" 则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const fs = require('fs');
const path = require('path');

const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
const data = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));

/**
 * 向 dungeon_key enum 数组追加 "xuese"（幂等）
 * @param {string} path - 接口路径
 * @param {string} method - HTTP 方法
 * @param {string} location - enum 所在位置：'body'（requestBody）或 'param'（parameters）
 */
function appendXuese(pathKey, method, location) {
    const op = data.paths[pathKey]?.[method];
    if (!op) {
        console.warn(`[warn] ${method.toUpperCase()} ${pathKey} 不存在`);
        return;
    }

    if (location === 'body') {
        const schema = op.requestBody?.content?.['application/json']?.schema;
        const enumArr = schema?.properties?.dungeon_key?.enum;
        if (Array.isArray(enumArr)) {
            if (!enumArr.includes('xuese')) {
                enumArr.push('xuese');
                console.log(`[ok] ${method.toUpperCase()} ${pathKey} requestBody.dungeon_key.enum 追加 "xuese"`);
            } else {
                console.log(`[skip] ${method.toUpperCase()} ${pathKey} requestBody.dungeon_key.enum 已含 "xuese"`);
            }
        }
    } else if (location === 'param') {
        const params = op.parameters || [];
        for (const param of params) {
            if (param.name === 'dungeon_key' && Array.isArray(param.schema?.enum)) {
                if (!param.schema.enum.includes('xuese')) {
                    param.schema.enum.push('xuese');
                    console.log(`[ok] ${method.toUpperCase()} ${pathKey} param.dungeon_key.enum 追加 "xuese"`);
                } else {
                    console.log(`[skip] ${method.toUpperCase()} ${pathKey} param.dungeon_key.enum 已含 "xuese"`);
                }
            }
        }
    }
}

// 1. /api/multi-dungeon/create：enum + description
appendXuese('/api/multi-dungeon/create', 'post', 'body');
{
    const op = data.paths['/api/multi-dungeon/create']?.post;
    if (op) {
        const desc = op.description || '';
        if (!desc.includes('血色试炼')) {
            op.description = (desc ? desc + '\n\n' : '') +
                '2026-07-21 扩展：新增 xuese（血色试炼）4-6人 PVPvE 淘汰制副本。\n' +
                '血色试炼特色：\n' +
                '  - 前3幕玩家互相博弈累积杀戮分、削减他人血气，每幕淘汰血气最低者\n' +
                '  - 第4幕幸存者合作对抗血色尊者（HP=1200000）\n' +
                '  - 双重压力机制：侵略（高伤害高杀戮分但自损血气）vs 共生（保血气多幸存）\n' +
                '  - 门票物品：blood_token（血色令牌）×1\n' +
                '  - 队长境界要求：筑基后期（rank≥13），队员境界要求：筑基初期（rank≥11）\n' +
                '  - 冷却：48 小时';
            console.log('[ok] POST /api/multi-dungeon/create description 追加血色试炼说明');
        } else {
            console.log('[skip] POST /api/multi-dungeon/create description 已含血色试炼');
        }
    }
}

// 2. /api/multi-dungeon/advance：summary 更新
{
    const op = data.paths['/api/multi-dungeon/advance']?.post;
    if (op) {
        const oldSummary = op.summary || '';
        const newSummary = '队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕 / 苍坤洞府第四幕 / 血色试炼第四幕）';
        if (oldSummary !== newSummary) {
            op.summary = newSummary;
            console.log(`[ok] POST /api/multi-dungeon/advance summary 更新为 "${newSummary}"`);
        } else {
            console.log('[skip] POST /api/multi-dungeon/advance summary 已是最新');
        }

        const desc = op.description || '';
        if (!desc.includes('血色试炼')) {
            op.description = (desc ? desc + '\n\n' : '') +
                '2026-07-21 扩展：新增血色试炼第四幕自动决战。\n' +
                '血色试炼第四幕特色：\n' +
                '  - 幸存者合作对抗血色尊者（HP=1200000）\n' +
                '  - 6 回合自动决战，每回合伤害 = 100000 + blood_fury × 3000 + survivor_count × 20000\n' +
                '  - 每回合全队平均血气 -10，归零即团灭失败\n' +
                '  - 无需 escape_choice 参数（苍坤洞府专用）';
            console.log('[ok] POST /api/multi-dungeon/advance description 追加血色试炼说明');
        } else {
            console.log('[skip] POST /api/multi-dungeon/advance description 已含血色试炼');
        }
    }
}

// 3. /api/multi-dungeon/rewards：enum + description
appendXuese('/api/multi-dungeon/rewards', 'get', 'param');
{
    const op = data.paths['/api/multi-dungeon/rewards']?.get;
    if (op) {
        const desc = op.description || '';
        if (!desc.includes('血色试炼')) {
            op.description = (desc ? desc + '\n\n' : '') +
                '2026-07-21 扩展：新增 xuese（血色试炼）奖励池查询。\n' +
                '血色试炼奖励特色：\n' +
                '  - 基础奖励：35000 修为 / 10000 灵石 / 60 神识\n' +
                '  - 普通掉落：4 项（blood_token/blood_soul_crystal/blood_sha_charm/blood_relic_fragment）\n' +
                '  - 首通奖励：血色试炼幸存者称号 + 血色残刃×1 + 50000 灵石 + 全服公告\n' +
                '  - 稀有掉落：blood_battle_armor（血色战甲，0.8% 概率，随机分给幸存者）\n' +
                '  - 杀戮分加成：每10点 +2000 修为 +150 灵石（仅幸存者）\n' +
                '  - 幸存者加成：每位幸存者 +5000 修为 +800 灵石（仅幸存者）\n' +
                '  - 完美通关加成：零淘汰时每人 +10000 修为 +2000 灵石（全员）';
            console.log('[ok] GET /api/multi-dungeon/rewards description 追加血色试炼说明');
        } else {
            console.log('[skip] GET /api/multi-dungeon/rewards description 已含血色试炼');
        }
    }
}

// 4. /api/multi-dungeon/cooldown：description 更新
{
    const op = data.paths['/api/multi-dungeon/cooldown']?.get;
    if (op) {
        const desc = op.description || '';
        const oldDesc = '2026-07-21 扩展：返回 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun 共7个副本键的当前冷却';
        const newDesc = '2026-07-21 扩展：返回 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese 共8个副本键的当前冷却。\n' +
            '血色试炼冷却时长：48 小时';
        if (desc.includes(oldDesc)) {
            op.description = desc.replace(oldDesc, newDesc);
            console.log('[ok] GET /api/multi-dungeon/cooldown description 更新为共8个副本');
        } else if (!desc.includes('xuese')) {
            op.description = (desc ? desc + '\n\n' : '') + newDesc;
            console.log('[ok] GET /api/multi-dungeon/cooldown description 追加血色试炼说明');
        } else {
            console.log('[skip] GET /api/multi-dungeon/cooldown description 已含血色试炼');
        }
    }
}

// 5. /api/admin/multi-dungeon/grant-reward：enum 更新
appendXuese('/api/admin/multi-dungeon/grant-reward', 'post', 'body');

// 6. /api/admin/multi-dungeon/reset-cooldown：enum 更新
appendXuese('/api/admin/multi-dungeon/reset-cooldown', 'post', 'body');

// 写回文件（2 空格缩进）
fs.writeFileSync(openapiPath, JSON.stringify(data, null, 2), 'utf-8');

// 验证
const verify = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
console.log('\n========================================');
console.log('  验证结果');
console.log('========================================');
console.log('paths count:', Object.keys(verify.paths).length);
console.log('tags count:', (verify.tags || []).length);

const createEnum = verify.paths['/api/multi-dungeon/create']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.dungeon_key?.enum || [];
console.log('create dungeon_key enum:', JSON.stringify(createEnum));

const rewardsParams = verify.paths['/api/multi-dungeon/rewards']?.get?.parameters || [];
for (const p of rewardsParams) {
    if (p.name === 'dungeon_key') {
        console.log('rewards dungeon_key enum:', JSON.stringify(p.schema?.enum));
    }
}

console.log('advance summary:', verify.paths['/api/multi-dungeon/advance']?.post?.summary);
console.log('cooldown description 含 xuese:', (verify.paths['/api/multi-dungeon/cooldown']?.get?.description || '').includes('xuese'));
console.log('admin grant-reward enum:', JSON.stringify(verify.paths['/api/admin/multi-dungeon/grant-reward']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.dungeon_key?.enum || []));
console.log('admin reset-cooldown enum:', JSON.stringify(verify.paths['/api/admin/multi-dungeon/reset-cooldown']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.dungeon_key?.enum || []));

console.log('\n✅ OpenAPI 文档更新完成');
