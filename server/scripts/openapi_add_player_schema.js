/**
 * OpenAPI 文档修复脚本
 *
 * 目的：补全 components/schemas/Player 定义
 *
 * 背景：
 *   openapi.json 中有 6 处接口响应引用 #/components/schemas/Player，
 *   但该 schema 从未定义（悬空引用），导致 Apifox 等工具导入时无法解析。
 *   本脚本一次性补全 Player schema，覆盖 players 表全字段，
 *   特别是批次3 v0031 迁移新增的 9 个字段（飞升/夺舍/第二元神/小世界/道侣/侍妾/香火/神识/法则）。
 *
 * 使用：node server/scripts/openapi_add_player_schema.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');

/**
 * Player schema 定义（覆盖 players 表全字段 + 关联计算字段）
 * 字段顺序与 /api/player/me 路由返回顺序保持一致
 */
const PlayerSchema = {
    type: 'object',
    description: '玩家完整信息（含基础属性、境界、修为、寿元、批次3 飞升/夺舍/后期系统扩展字段）',
    properties: {
        id: { type: 'integer', description: '玩家ID', example: 1 },
        username: { type: 'string', description: '登录账号', example: 'hanli' },
        nickname: { type: 'string', description: '道号（游戏内显示名）', example: '韩天尊' },
        realm: { type: 'string', description: '当前境界名称', example: '化神巅峰' },
        role: { type: 'string', description: '角色身份', example: '散修' },
        is_dead: { type: 'boolean', description: '是否死亡（true 时前端显示 DeathOverlay）', example: false },
        death_reason: { type: 'string', description: '死亡原因（寿元耗尽/被击杀等）', example: null },
        realmInfo: {
            type: 'object',
            description: '境界详细信息',
            properties: {
                name: { type: 'string', example: '化神巅峰' },
                rank: { type: 'integer', description: '境界 rank（0=凡人, 23-26=化神, 40=真仙）', example: 26 },
                description: { type: 'string', example: '化神期巅峰，可尝试飞升灵界' }
            }
        },
        exp: { type: 'string', description: '当前修为（BIGINT 字符串）', example: '2744000' },
        exp_next: { type: 'string', description: '下一级所需修为', example: '2744000' },
        exp_cap: { type: 'string', description: '当前境界修为上限', example: '2744000' },
        exp_progress: { type: 'number', description: '修为进度百分比', example: 100 },
        can_breakthrough: { type: 'boolean', description: '是否可突破', example: true },
        spirit_roots: {
            type: 'object',
            description: '灵根信息',
            properties: {
                type: { type: 'string', description: '灵根属性（金/木/水/火/土/雷/冰/风）', example: '雷' },
                value: { type: 'integer', description: '灵根等级（1-9）', example: 9 }
            }
        },
        spirit_stones: { type: 'string', description: '灵石余额（BIGINT 字符串）', example: '1500' },
        // 第四阶段字段
        pawnshop_credit: { type: 'integer', description: '当铺信用额度', example: 0 },
        pvp_score: { type: 'integer', description: 'PVP 段位积分', example: 0 },
        pvp_rank: { type: 'string', description: 'PVP 段位名称', example: '散修' },
        honor: { type: 'string', description: '荣誉值（BIGINT 字符串）', example: '0' },
        karma: { type: 'integer', description: '因果值', example: 0 },
        weakness_end_time: { type: 'string', format: 'date-time', description: '虚弱状态结束时间', example: null },
        stock_account_balance: { type: 'string', description: '股市账户余额（BIGINT 字符串）', example: '0' },
        stock_margin_debt: { type: 'string', description: '融资负债金额（BIGINT 字符串）', example: '0' },
        is_stock_trading_locked: { type: 'boolean', description: '股市交易是否被锁定', example: false },
        // ===== 批次3 飞升+夺舍+后期系统字段（v0031 迁移新增） =====
        reincarnation_count: { type: 'integer', description: '历史夺舍次数（每次+1）', example: 0 },
        ascension_eligible: { type: 'integer', description: '是否满足飞升前置（0否1是，冗余字段加速查询）', example: 0 },
        second_soul_count: { type: 'integer', description: '已凝练第二元神数量（0-3）', example: 0 },
        small_world_id: { type: 'integer', description: '所属小世界ID', example: null, nullable: true },
        dao_companion_id: { type: 'integer', description: '道侣关系ID', example: null, nullable: true },
        concubine_count: { type: 'integer', description: '当前侍妾数量', example: 0 },
        incense_balance: { type: 'integer', description: '当前香火余额', example: 0 },
        divine_sense_balance: { type: 'integer', description: '当前神识余额（飞升/探寻裂缝/定星消耗）', example: 0 },
        law_points: { type: 'integer', description: '法则点数（用于法则转换）', example: 0 },
        // 寿元与属性
        age: { type: 'integer', description: '当前年龄', example: 52 },
        lifespan: {
            type: 'object',
            description: '寿元状态',
            properties: {
                current: { type: 'integer', example: 120 },
                max: { type: 'integer', example: 150 },
                percent: { type: 'integer', description: '寿元剩余百分比', example: 80 }
            }
        },
        attributes: {
            type: 'object',
            description: '玩家完整属性（含装备/灵根/境界加成）',
            properties: {
                hp_max: { type: 'integer', example: 1200 },
                mp_max: { type: 'integer', example: 800 },
                atk: { type: 'integer', example: 150 },
                def: { type: 'integer', example: 80 },
                spd: { type: 'integer', example: 60 }
            }
        },
        hp_current: { type: 'string', description: '当前生命值（BIGINT 字符串）', example: '1200' },
        hp_max: { type: 'string', description: '最大生命值（字符串，避免前端 BigInt 除法问题）', example: '1200' },
        mp_current: { type: 'string', description: '当前法力值（BIGINT 字符串）', example: '800' },
        mp_max: { type: 'string', description: '最大法力值', example: '800' },
        is_secluded: { type: 'boolean', description: '是否闭关中', example: false },
        seclusion_end_time: { type: 'string', format: 'date-time', description: '闭关结束时间', example: null },
        last_seclusion_time: { type: 'string', format: 'date-time', description: '上次闭关时间', example: null },
        created_at: { type: 'string', format: 'date-time', description: '账号创建时间' },
        updated_at: { type: 'string', format: 'date-time', description: '最后更新时间' },
        total_online_time: { type: 'integer', description: '总在线时长（秒）', example: 0 }
    }
};

/**
 * 主函数：读取 openapi.json，添加 Player schema，写回文件
 */
function main() {
    console.log('[OpenAPI] 开始补全 Player schema...');

    // 1. 读取 openapi.json
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const spec = JSON.parse(raw);

    // 2. 检查 Player schema 是否已存在
    if (spec.components?.schemas?.Player) {
        console.log('[OpenAPI] Player schema 已存在，将覆盖更新...');
    }

    // 3. 添加 Player schema（按字母顺序插入到合适位置，确保 AiConfig 之前）
    //    JSON 对象属性顺序在 ES2015+ 中保留插入顺序，这里直接赋值即可
    if (!spec.components) spec.components = {};
    if (!spec.components.schemas) spec.components.schemas = {};

    // 重建 schemas 对象，将 Player 放在 AiConfig 之前（字母序）
    const newSchemas = {};
    let inserted = false;
    for (const [key, value] of Object.entries(spec.components.schemas)) {
        // 在第一个字母序大于 Player 的 schema 之前插入
        if (!inserted && key > 'Player') {
            newSchemas.Player = PlayerSchema;
            inserted = true;
            console.log('[OpenAPI] Player schema 已插入到', key, '之前');
        }
        newSchemas[key] = value;
    }
    if (!inserted) {
        // 如果所有 schema 都小于 Player（字母序），追加到末尾
        newSchemas.Player = PlayerSchema;
        console.log('[OpenAPI] Player schema 已追加到 schemas 末尾');
    }
    spec.components.schemas = newSchemas;

    // 4. 写回文件（保留 2 空格缩进）
    const output = JSON.stringify(spec, null, 2);
    fs.writeFileSync(OPENAPI_PATH, output, 'utf8');

    console.log(`[OpenAPI] 完成！openapi.json 大小: ${output.length} 字符`);
    console.log(`[OpenAPI] schemas 总数: ${Object.keys(spec.components.schemas).length}`);
}

main();
