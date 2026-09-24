/**
 * 玩家档案编辑器路由（GM 后台）
 *
 * 解决"后台能改的玩家属性太少"的问题：除了基础的昵称/境界/灵石，这里把
 * 战斗属性、统计计数、灵根、状态标记、高阶属性，以及玩家名下的**背包物品 / 装备 / 功法**
 * 全部开放为可编辑，并提供物品与功法字典供下拉选择。
 *
 * 设计约定：
 *   1. **可编辑字段不写死在代码里**：全部来自 config/admin_player_editor.json，
 *      新增一个字段只需在配置里加一项，前后端都不用改代码（前端按 /schema 动态渲染）。
 *   2. **玩家标量列与整块 JSON 列的写入一律走 PlayerStateStore.patchPlayerState**：
 *      行锁内读最新一份再补丁写回，绕过 numericWriteGuard / blobWriteGuard 覆盖保护会直接报错，
 *      也避免 GM 操作和玩家在线行为互相覆盖。
 *   3. 背包数量改动走事务 + 行锁；默认绕过储物袋容量（GM 补发/回收不该被普通容量挡住，
 *      由配置 inventory.default_ignore_capacity 控制）。
 *   4. 所有写操作落 admin_logs 并通过 WebSocket 通知目标玩家刷新。
 */
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const sequelize = require('../config/database');

const Player = require('../models/player');
const Item = require('../models/item');
const PlayerEquipment = require('../models/playerEquipment');
const PlayerTechnique = require('../models/playerTechnique');
const Realm = require('../models/realm');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
// 统一通过 modules/index.js 导出引用 ConfigLoader，避免路径混乱
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const InventoryService = require('../game/services/InventoryService');
const webSocketNotificationService = require('../game/services/WebSocketNotificationService');

const CONFIG_NAME = 'admin_player_editor';

/** 配置缺失/未加载时的兜底，保证编辑页仍可打开（只是没有可编辑字段） */
const FALLBACK_CONFIG = {
    player_field_groups: [],
    blob_field_groups: [],
    inventory: { max_quantity: 999999, max_add_quantity: 99999, page_size_default: 100, page_size_max: 500, allow_unknown_item: true, default_ignore_capacity: true, batch_max_items: 50 },
    equipment: { editable_fields: [], slots: [], refine_level_range: [0, 15], durability_range: [0, 999999], attr_multiplier_range: [0.0001, 99.9999], spirit_power_range: [0, 9999999], deep_lines: [] },
    techniques: { editable_fields: [], equip_slots: ['main', 'auxiliary'], layer_range: [1, 999], proficiency_range: [0, 9999999], fail_streak_range: [0, 9999], practice_count_range: [0, 99999999], allow_unknown_technique: true },
    dictionaries: { item_option_limit_default: 50, item_option_limit_max: 500, technique_option_limit_default: 50, technique_option_limit_max: 500 }
};

/**
 * 管理员权限中间件
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 读取编辑器配置（配置缺失时返回兜底，不让整个页面挂掉）
 */
function readEditorConfig() {
    try {
        const cfg = configLoader.getConfig(CONFIG_NAME);
        return cfg && typeof cfg === 'object' ? cfg : FALLBACK_CONFIG;
    } catch (e) {
        console.warn(`[admin_player_editor] 配置 ${CONFIG_NAME} 读取失败，使用兜底配置: ${e.message}`);
        return FALLBACK_CONFIG;
    }
}

/**
 * 记录管理员操作日志
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection.remoteAddress
        });
    } catch (error) {
        console.error('记录管理员日志失败:', error);
    }
}

/**
 * 参数校验失败：统一带 400 出去，前端直接展示 message
 */
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

/**
 * 把请求里的原始值按字段声明收敛成可写库的值
 *
 * 只认配置里声明过的字段类型（string / number / boolean / enum），
 * 越界与非法枚举一律拒绝而不是静默截断 —— GM 填错要当场看见，不能"改了个没生效的数"。
 * @param {Object} field - 配置中的字段声明
 * @param {*} raw - 请求里的原始值
 * @returns {*} 收敛后的值
 */
function coerceFieldValue(field, raw) {
    // 时间类字段允许清空（null / 空串），所以要在"不能为空"这道通用判断之前处理
    if (field.type === 'datetime') {
        if (raw === undefined || raw === null || raw === '') return null;
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) throw new ValidationError(`${field.label || field.key} 不是合法时间`);
        return date;
    }
    if (field.type === 'date') {
        if (raw === undefined || raw === null || raw === '') return null;
        const text = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            throw new ValidationError(`${field.label || field.key} 必须是 YYYY-MM-DD 格式`);
        }
        return text;
    }

    if (raw === undefined || raw === null || raw === '') {
        throw new ValidationError(`${field.label || field.key} 不能为空`);
    }
    switch (field.type) {
        case 'string': {
            const text = String(raw).trim();
            if (!text) throw new ValidationError(`${field.label || field.key} 不能为空`);
            if (field.max_length && text.length > field.max_length) {
                throw new ValidationError(`${field.label || field.key} 长度不能超过 ${field.max_length}`);
            }
            return text;
        }
        case 'number': {
            const num = Number(raw);
            if (!Number.isFinite(num)) throw new ValidationError(`${field.label || field.key} 必须是数字`);
            if (field.min !== undefined && num < field.min) throw new ValidationError(`${field.label || field.key} 不能小于 ${field.min}`);
            if (field.max !== undefined && num > field.max) throw new ValidationError(`${field.label || field.key} 不能大于 ${field.max}`);
            return num;
        }
        case 'boolean':
            return raw === true || raw === 'true' || raw === 1 || raw === '1';
        case 'enum': {
            const allowed = (field.options || []).map(o => o.value);
            if (!allowed.includes(raw)) {
                throw new ValidationError(`${field.label || field.key} 只能是：${allowed.join(' / ')}`);
            }
            return raw;
        }
        default:
            return raw;
    }
}

/**
 * 建立"玩家标量列字段"索引：key → 字段声明
 * @param {Object} cfg 编辑器配置
 * @returns {Map<string, Object>}
 */
function buildPlayerFieldIndex(cfg) {
    const index = new Map();
    for (const group of cfg.player_field_groups || []) {
        for (const field of group.fields || []) {
            index.set(field.key, { ...field, group: group.id });
        }
    }
    return index;
}

/**
 * 建立"整块 JSON 列字段"索引：`column.key` → 字段声明
 * @param {Object} cfg 编辑器配置
 * @returns {Map<string, Object>}
 */
function buildBlobFieldIndex(cfg) {
    const index = new Map();
    for (const group of cfg.blob_field_groups || []) {
        if (!group.column) continue;
        for (const field of group.fields || []) {
            index.set(`${group.column}.${field.key}`, { ...field, group: group.id, column: group.column });
        }
    }
    return index;
}

/**
 * 校验并整理"玩家档案补丁"
 *
 * @param {Object} body 请求体 { columns?: {}, blobs?: { attributes: {}, stats: {}, spirit_roots: {} }, titles?: string[] }
 * @param {Object} cfg 编辑器配置
 * @returns {{ columns: Object, blobs: Object, changed: string[] }}
 */
function buildPlayerPatch(body, cfg) {
    const playerIndex = buildPlayerFieldIndex(cfg);
    const blobIndex = buildBlobFieldIndex(cfg);
    const columns = {};
    const blobs = {};
    const changed = [];

    for (const [key, raw] of Object.entries(body.columns || {})) {
        const field = playerIndex.get(key);
        if (!field) throw new ValidationError(`字段 ${key} 不允许编辑`);
        const value = coerceFieldValue(field, raw);
        columns[key] = value;
        changed.push(key);
    }

    for (const [column, patch] of Object.entries(body.blobs || {})) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new ValidationError(`blobs.${column} 必须是对象`);
        }
        blobs[column] = {};
        for (const [key, raw] of Object.entries(patch)) {
            const field = blobIndex.get(`${column}.${key}`);
            if (!field) throw new ValidationError(`字段 ${column}.${key} 不允许编辑`);
            blobs[column][key] = coerceFieldValue(field, raw);
            changed.push(`${column}.${key}`);
        }
    }

    if (!changed.length) throw new ValidationError('没有需要更新的字段');
    return { columns, blobs, changed };
}

/**
 * 把 blob 补丁翻译成 PlayerStateStore.patchPlayerState 的形状
 */
function toStatePatch(blobs) {
    return {
        attributes: blobs.attributes,
        stats: blobs.stats,
        spiritRoots: blobs.spirit_roots,
        timeSystemData: blobs.time_system_data
    };
}

/**
 * 读取物品字典（item_data），返回 key → 静态配置
 */
function readItemDictionary() {
    try {
        const data = configLoader.getConfig('item_data') || {};
        return Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        console.warn('[admin_player_editor] item_data 读取失败:', e.message);
        return [];
    }
}

/**
 * 读取功法字典（technique_data），返回 [{ id, name, grade }]
 * techniques 是以 id 为键的对象，且混有 `_comment` 这类说明键，需要过滤
 */
function readTechniqueDictionary() {
    try {
        const data = configLoader.getConfig('technique_data') || {};
        const raw = data.techniques || {};
        return Object.entries(raw)
            .filter(([id]) => id && !id.startsWith('_'))
            .map(([id, cfg]) => ({ id, name: cfg?.name || id, grade: cfg?.grade || '', element: cfg?.element || '' }));
    } catch (e) {
        console.warn('[admin_player_editor] technique_data 读取失败:', e.message);
        return [];
    }
}

/**
 * 解析玩家 ID 参数
 */
function parsePlayerId(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('玩家 ID 不合法');
    return id;
}

/**
 * 解析分页/条数参数（带上限，防止一次把整张表拉出来）
 */
function parseLimit(raw, def, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(n, max);
}

/**
 * 给背包/装备记录补上静态名称，便于 GM 在表格里认出是哪件东西
 */
function decorateWithItemName(record, dict) {
    const data = typeof record.toJSON === 'function' ? record.toJSON() : { ...record };
    const staticCfg = dict.get(String(data.item_key));
    data.item_name = staticCfg?.name || '';
    data.item_type = staticCfg?.type || '';
    data.item_quality = staticCfg?.quality || '';
    data.config_missing = !staticCfg;
    return data;
}

/**
 * 解析 JSON 字段（metadata / deep_line_state 这类 TEXT/JSON 列）
 */
function parseJsonField(raw) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        throw new ValidationError('JSON 字段格式不正确');
    }
}

/* ==================== 编辑元数据 ==================== */

/**
 * 获取可编辑字段 schema（前端据此动态渲染表单）
 * GET /api/admin/player-editor/schema
 */
router.get('/schema', auth, adminCheck, async (req, res) => {
    try {
        const cfg = readEditorConfig();
        // 动态选项：境界取自 realms 表，灵根取自 role_init 配置，避免后台手输错字
        let realmOptions = [];
        try {
            const realms = await Realm.findAll({ attributes: ['name', 'rank'], order: [['rank', 'ASC']] });
            realmOptions = realms.map(r => ({ value: r.name, label: r.name, meta: `阶数 ${r.rank}` }));
        } catch (e) {
            console.warn('[admin_player_editor] 境界列表读取失败:', e.message);
        }

        let spiritRootOptions = [];
        try {
            const roleInit = configLoader.getConfig('role_init') || {};
            spiritRootOptions = (roleInit.spirit_roots || [])
                .filter(r => r && r.type)
                .map(r => ({ value: r.type, label: r.name || r.type, meta: r.type }));
        } catch (e) {
            console.warn('[admin_player_editor] 灵根列表读取失败:', e.message);
        }

        // 幻世轮相位：取自 artifact_deep_lines 配置，新增相位不用回后台改代码
        let wheelPhaseOptions = [];
        try {
            const wheelCfg = configLoader.getConfig('artifact_deep_lines')?.settings?.five_element_wheel || {};
            wheelPhaseOptions = Object.entries(wheelCfg.phases || {})
                .filter(([key]) => key && !key.startsWith('_'))
                .map(([key, phase]) => ({ value: key, label: phase?.name || key }));
        } catch (e) {
            console.warn('[admin_player_editor] 幻世轮相位读取失败:', e.message);
        }

        /** 把配置里的 options_from 占位替换成真实选项 */
        const fillField = (field) => {
            if (field.options_from === 'realms') return { ...field, options: realmOptions };
            if (field.options_from === 'spirit_roots') return { ...field, options: spiritRootOptions };
            if (field.options_from === 'wheel_phases') return { ...field, options: wheelPhaseOptions };
            return field;
        };
        const fillOptions = (group) => ({ ...group, fields: (group.fields || []).map(fillField) });

        // 背包筛选用的词表：类型取自 item_data 实际取值，品质档名取自 game_balance.item_qualities
        // （品质字典以前被 9 个面板各抄一份，后台这里也不另抄，直接用服务端那份）
        const eqCfg = cfg.equipment || FALLBACK_CONFIG.equipment;
        let itemQualities = [];
        try {
            const qualities = configLoader.getConfig('game_balance')?.item_qualities || {};
            itemQualities = Object.values(qualities)
                .filter(q => q && typeof q === 'object' && q.id)
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .map(q => ({ value: q.id, label: q.label || q.id }));
        } catch (e) {
            console.warn('[admin_player_editor] 品质词表读取失败:', e.message);
        }
        const itemTypes = [...new Set(readItemDictionary().map(i => i.type).filter(Boolean))].sort();

        res.json({
            code: 200,
            data: {
                player_field_groups: (cfg.player_field_groups || []).map(fillOptions),
                blob_field_groups: (cfg.blob_field_groups || []).map(fillOptions),
                inventory: cfg.inventory || FALLBACK_CONFIG.inventory,
                equipment: {
                    ...eqCfg,
                    deep_lines: (eqCfg.deep_lines || []).map(line => ({ ...line, fields: (line.fields || []).map(fillField) }))
                },
                techniques: cfg.techniques || FALLBACK_CONFIG.techniques,
                dictionaries: {
                    ...(cfg.dictionaries || FALLBACK_CONFIG.dictionaries),
                    item_types: itemTypes,
                    item_qualities: itemQualities
                }
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取字段配置失败', error: error.message });
    }
});

/**
 * 物品字典检索（供背包新增时下拉选择）
 * GET /api/admin/player-editor/item-options
 */
router.get('/item-options', auth, adminCheck, async (req, res) => {
    try {
        const cfg = readEditorConfig();
        const dict = cfg.dictionaries || FALLBACK_CONFIG.dictionaries;
        const limit = parseLimit(req.query.limit, dict.item_option_limit_default, dict.item_option_limit_max);
        const keyword = String(req.query.keyword || '').trim().toLowerCase();
        const type = String(req.query.type || '').trim();

        let items = readItemDictionary();
        if (type) items = items.filter(i => String(i.type || '') === type);
        if (keyword) {
            items = items.filter(i => `${i.id} ${i.name} ${i.type} ${i.subtype || ''}`.toLowerCase().includes(keyword));
        }
        res.json({
            code: 200,
            data: {
                items: items.slice(0, limit).map(i => ({
                    value: i.id,
                    label: i.name || i.id,
                    meta: `${i.id} · ${i.type || '未知类型'}${i.quality ? ' · ' + i.quality : ''}`,
                    group: i.type || '未分类'
                })),
                total: items.length
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取物品字典失败', error: error.message });
    }
});

/**
 * 功法字典检索（供授予功法时下拉选择）
 * GET /api/admin/player-editor/technique-options
 */
router.get('/technique-options', auth, adminCheck, async (req, res) => {
    try {
        const cfg = readEditorConfig();
        const dict = cfg.dictionaries || FALLBACK_CONFIG.dictionaries;
        const limit = parseLimit(req.query.limit, dict.technique_option_limit_default, dict.technique_option_limit_max);
        const keyword = String(req.query.keyword || '').trim().toLowerCase();

        let list = readTechniqueDictionary();
        if (keyword) {
            list = list.filter(t => `${t.id} ${t.name} ${t.grade} ${t.element}`.toLowerCase().includes(keyword));
        }
        res.json({
            code: 200,
            data: {
                techniques: list.slice(0, limit).map(t => ({
                    value: t.id,
                    label: t.name,
                    meta: `${t.id}${t.grade ? ' · ' + t.grade : ''}`,
                    group: t.grade || '未分阶'
                })),
                total: list.length
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取功法字典失败', error: error.message });
    }
});

/* ==================== 玩家档案 ==================== */

/**
 * 获取玩家完整档案（含背包 / 装备 / 功法）
 * GET /api/admin/player-editor/:playerId
 */
router.get('/:playerId', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const player = await Player.findByPk(playerId, { attributes: { exclude: ['password'] } });
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const cfg = readEditorConfig();
        const invCfg = cfg.inventory || FALLBACK_CONFIG.inventory;
        const itemDict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        const techDict = new Map(readTechniqueDictionary().map(t => [String(t.id), t]));

        const [inventory, equipment, techniques] = await Promise.all([
            Item.findAll({ where: { player_id: playerId }, order: [['id', 'ASC']] }),
            PlayerEquipment.findAll({ where: { player_id: playerId }, order: [['sort_order', 'ASC'], ['id', 'ASC']] }),
            PlayerTechnique.findAll({ where: { player_id: playerId }, order: [['id', 'ASC']] })
        ]);

        const items = inventory.map(r => decorateWithItemName(r, itemDict));
        const totalQuantity = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);

        res.json({
            code: 200,
            data: {
                player: player.toJSON(),
                inventory: {
                    items,
                    total_kinds: items.length,
                    total_quantity: totalQuantity,
                    capacity: InventoryService.getInventoryConfig().capacity || 100,
                    max_quantity: invCfg.max_quantity
                },
                equipment: equipment.map(r => decorateWithItemName(r, itemDict)),
                techniques: techniques.map(r => {
                    const data = r.toJSON();
                    const staticCfg = techDict.get(String(data.technique_id));
                    data.technique_name = staticCfg?.name || '';
                    data.technique_grade = staticCfg?.grade || '';
                    data.config_missing = !staticCfg;
                    return data;
                })
            }
        });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '获取玩家档案失败', error: error.message });
    }
});

/**
 * 局部更新玩家档案（标量列 + 整块 JSON 列的键级补丁）
 * PATCH /api/admin/player-editor/:playerId
 */
router.patch('/:playerId', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const { columns, blobs, changed } = buildPlayerPatch(req.body || {}, cfg);

        const player = await Player.findByPk(playerId);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        // 走 patchPlayerState：行锁内读最新一份再写回，避免与玩家在线行为互相覆盖
        const updated = await PlayerStateStore.patchPlayerState(playerId, { columns, ...toStatePatch(blobs) });

        await logAdminAction(req.player.id, 'edit_player_profile', {
            target_id: playerId,
            changes: changed,
            columns,
            blobs
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor', { changed });

        res.json({
            code: 200,
            message: `已更新 ${changed.length} 个字段`,
            data: { changed, player: updated.toJSON() }
        });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '更新玩家档案失败', error: error.message });
    }
});

/* ==================== 背包 ==================== */

/**
 * 背包列表（支持按关键字 / 类型 / 品质筛选）
 * GET /api/admin/player-editor/:playerId/inventory
 *
 * 类型与品质只存在于 item_data 配置里（player_items 表没有这两列），
 * 所以筛选是"先按词表算出命中的 item_key，再拿它查库"，不是加 WHERE 条件。
 */
router.get('/:playerId/inventory', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const invCfg = cfg.inventory || FALLBACK_CONFIG.inventory;
        const limit = parseLimit(req.query.limit, invCfg.page_size_default, invCfg.page_size_max);
        const keyword = String(req.query.keyword || '').trim().toLowerCase();
        const type = String(req.query.type || '').trim();
        const quality = String(req.query.quality || '').trim();

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        const where = { player_id: playerId };

        // 需要按配置里的静态属性过滤时，先把命中的 item_key 收窄，再交给数据库查
        if (keyword || type || quality) {
            const matchedKeys = [...dict.entries()]
                .filter(([key, cfgItem]) => {
                    if (type && String(cfgItem.type || '') !== type) return false;
                    if (quality && String(cfgItem.quality || '') !== quality) return false;
                    if (!keyword) return true;
                    return key.toLowerCase().includes(keyword)
                        || `${cfgItem.name || ''}`.toLowerCase().includes(keyword);
                })
                .map(([key]) => key);
            where.item_key = { [Op.in]: matchedKeys.length ? matchedKeys : ['__no_match__'] };
        }

        const rows = await Item.findAll({ where, order: [['id', 'ASC']], limit });
        const items = rows.map(r => decorateWithItemName(r, dict));
        const totalQuantity = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);

        res.json({
            code: 200,
            data: {
                items,
                total_kinds: items.length,
                total_quantity: totalQuantity,
                capacity: InventoryService.getInventoryConfig().capacity || 100,
                max_quantity: invCfg.max_quantity
            }
        });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '获取背包失败', error: error.message });
    }
});

/**
 * 法宝深线状态补丁：按"线 → 字段"两级白名单校验后合并进现有状态
 *
 * 四条深线（血魔剑 / 虚天鼎 / 掌天瓶 / 幻世轮）共用 deep_line_state 一个 JSON 列，
 * 整块覆盖会把**其它线**的键一起抹掉；所以 GM 也只能交键级补丁，
 * 且字段名必须落在配置声明的范围内（写错字段名要当场报，而不是存进去没人读）。
 *
 * @param {Object} current 库里当前的 deep_line_state
 * @param {Object} patch   请求里的补丁 { blood_sword: { corruption: 20 } }
 * @param {Array} deepLineCfg 配置中的 deep_lines 声明
 * @returns {{ next: Object, changed: string[] }}
 */
function buildDeepLinePatch(current, patch, deepLineCfg) {
    const lines = new Map((deepLineCfg || []).map(line => [line.key, line]));
    const next = { ...(current || {}) };
    const changed = [];

    for (const [lineKey, linePatch] of Object.entries(patch || {})) {
        const lineCfg = lines.get(lineKey);
        if (!lineCfg) throw new ValidationError(`法宝深线 ${lineKey} 不允许编辑`);

        // 传 null = 整条线清空（如把玩家从某条线上摘下来）
        if (linePatch === null) {
            delete next[lineKey];
            changed.push(`${lineKey}（整条清空）`);
            continue;
        }
        if (!linePatch || typeof linePatch !== 'object' || Array.isArray(linePatch)) {
            throw new ValidationError(`深线 ${lineKey} 的补丁必须是对象`);
        }

        const merged = { ...(next[lineKey] || {}) };
        for (const [key, raw] of Object.entries(linePatch)) {
            const field = (lineCfg.fields || []).find(f => f.key === key);
            if (!field) throw new ValidationError(`深线 ${lineKey} 不允许编辑字段 ${key}`);
            merged[key] = coerceFieldValue(field, raw);
            changed.push(`${lineKey}.${key}`);
        }
        next[lineKey] = merged;
    }

    if (!changed.length) throw new ValidationError('深线补丁为空');
    return { next, changed };
}

/**
 * 校验并归一化一条"背包写入"请求（单条与批量共用同一套校验，避免两处口径漂移）
 * @returns {{ itemKey: string, quantity: number, mode: 'add'|'set', metadata: object|null|undefined }}
 */
function normalizeInventoryEntry(entry, invCfg, dict, defaultMode) {
    const itemKey = String(entry?.item_key || '').trim();
    if (!itemKey) throw new ValidationError('物品ID不能为空');

    const quantity = Number(entry?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) throw new ValidationError('数量必须是正整数');
    if (quantity > invCfg.max_add_quantity) throw new ValidationError(`数量不能超过 ${invCfg.max_add_quantity}`);

    if (!dict.has(itemKey) && !invCfg.allow_unknown_item) {
        throw new ValidationError(`物品 ${itemKey} 不在 item_data 配置中`);
    }

    const metadata = parseJsonField(entry?.metadata);
    if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
        throw new ValidationError('metadata 必须是对象');
    }

    return { itemKey, quantity, mode: entry?.mode === 'set' || entry?.mode === 'add' ? entry.mode : defaultMode, metadata };
}

/**
 * 在给定事务里写入一条背包记录（累加或整值设定）
 *
 * GM 直写路径必须锁行：背包数量是"读出 → 加减 → 整值写回"的形状，
 * 不锁就会和玩家同时用掉这件物品的那一笔互相覆盖。
 * 调用方负责事务的提交 / 回滚；这里只管这一行。
 */
async function writeInventoryItem(t, { playerId, itemKey, quantity, mode, metadata, ignoreCapacity, invCfg }) {
    if (mode === 'add' && !ignoreCapacity) {
        // 走正规发放通道：带容量检查（GM 想被容量挡住时就用这条）
        await InventoryService.addItem(playerId, itemKey, quantity, t, metadata || null, { allowUnknownItem: !!invCfg.allow_unknown_item });
        return Item.findOne({ where: { player_id: playerId, item_key: itemKey }, transaction: t });
    }

    const record = await Item.findOne({
        where: { player_id: playerId, item_key: itemKey },
        transaction: t,
        lock: t.LOCK.UPDATE
    });
    if (record) {
        const current = Number(record.quantity) || 0;
        record.quantity = Math.min(mode === 'set' ? quantity : current + quantity, invCfg.max_quantity);
        if (metadata !== undefined) record.metadata = metadata;
        await record.save({ transaction: t });
        return record;
    }
    return Item.create({
        player_id: playerId,
        item_key: itemKey,
        quantity: Math.min(quantity, invCfg.max_quantity),
        metadata: metadata === undefined ? null : metadata
    }, { transaction: t });
}

/**
 * 新增 / 追加背包物品
 * POST /api/admin/player-editor/:playerId/inventory
 *
 * @body {string} item_key   物品配置键
 * @body {number} quantity   数量（默认 1）
 * @body {string} mode       add=累加（默认） / set=直接设为该数量
 * @body {boolean} ignore_capacity 是否绕过储物袋容量（默认取配置 inventory.default_ignore_capacity）
 * @body {Object} metadata   物品动态元数据（如炼制品质倍率）
 */
router.post('/:playerId/inventory', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const invCfg = cfg.inventory || FALLBACK_CONFIG.inventory;

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        const { itemKey, quantity, mode, metadata } = normalizeInventoryEntry(req.body, invCfg, dict, 'add');

        const player = await Player.findByPk(playerId);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const ignoreCapacity = req.body.ignore_capacity === undefined
            ? invCfg.default_ignore_capacity !== false
            : !!req.body.ignore_capacity;

        const t = await sequelize.transaction();
        let record;
        try {
            record = await writeInventoryItem(t, { playerId, itemKey, quantity, mode, metadata, ignoreCapacity, invCfg });
            await t.commit();
        } catch (inner) {
            await t.rollback();
            throw inner;
        }

        await logAdminAction(req.player.id, 'edit_player_inventory', {
            target_id: playerId,
            action: mode === 'set' ? 'set_item' : 'add_item',
            item_key: itemKey,
            quantity,
            ignore_capacity: ignoreCapacity
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { item_key: itemKey, quantity });

        res.json({
            code: 200,
            message: '背包物品已更新',
            data: { item: decorateWithItemName(record, dict) }
        });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '更新背包失败', error: error.message });
    }
});

/**
 * 批量发放 / 调整背包物品
 * POST /api/admin/player-editor/:playerId/inventory/batch
 *
 * 为什么不整批回滚：GM 一次勾 20 件，其中一件 ID 拼错就让另外 19 件也发不出去，
 * 排查时只能"再试一次看还错在哪"。这里改成逐条处理、逐条记结果 ——
 * 成功的照发，失败的把原因带回前端，GM 一眼看到该改哪一行。
 *
 * @body {Array} items  [{ item_key, quantity?, mode?, metadata? }]
 * @body {string} mode  未逐条指定 mode 时的默认方式（add / set）
 * @body {boolean} ignore_capacity 同单条接口
 */
router.post('/:playerId/inventory/batch', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const invCfg = cfg.inventory || FALLBACK_CONFIG.inventory;

        const list = Array.isArray(req.body.items) ? req.body.items : [];
        if (!list.length) throw new ValidationError('批量列表为空');
        const maxItems = Number(invCfg.batch_max_items) || 50;
        if (list.length > maxItems) throw new ValidationError(`单次批量最多 ${maxItems} 条`);

        const player = await Player.findByPk(playerId);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        const defaultMode = req.body.mode === 'set' ? 'set' : 'add';
        const ignoreCapacity = req.body.ignore_capacity === undefined
            ? invCfg.default_ignore_capacity !== false
            : !!req.body.ignore_capacity;

        const results = [];
        const t = await sequelize.transaction();
        try {
            for (const entry of list) {
                try {
                    const normalized = normalizeInventoryEntry(entry, invCfg, dict, defaultMode);
                    const record = await writeInventoryItem(t, {
                        playerId,
                        itemKey: normalized.itemKey,
                        quantity: normalized.quantity,
                        mode: normalized.mode,
                        metadata: normalized.metadata,
                        ignoreCapacity,
                        invCfg
                    });
                    results.push({
                        ok: true,
                        item_key: normalized.itemKey,
                        item_name: dict.get(normalized.itemKey)?.name || '',
                        mode: normalized.mode,
                        quantity: Number(record?.quantity) || 0
                    });
                } catch (itemError) {
                    results.push({
                        ok: false,
                        item_key: String(entry?.item_key || '').trim(),
                        message: itemError.message
                    });
                }
            }
            await t.commit();
        } catch (outer) {
            await t.rollback();
            throw outer;
        }

        const succeeded = results.filter(r => r.ok).length;
        const failed = results.length - succeeded;

        await logAdminAction(req.player.id, 'edit_player_inventory', {
            target_id: playerId,
            action: 'batch_grant',
            total: results.length,
            succeeded,
            failed,
            mode: defaultMode,
            ignore_capacity: ignoreCapacity,
            item_keys: results.filter(r => r.ok).map(r => r.item_key)
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { batch: true, succeeded, failed });

        res.json({
            code: 200,
            message: failed ? `批量发放完成：成功 ${succeeded} 条，失败 ${failed} 条` : `批量发放完成：成功 ${succeeded} 条`,
            data: { succeeded, failed, results }
        });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '批量发放失败', error: error.message });
    }
});

/**
 * 修改背包物品（数量 / 元数据）
 * PUT /api/admin/player-editor/:playerId/inventory/:itemId
 *
 * 数量传 0 表示删除这条记录（回收物品比留一条 0 数量的脏数据干净）
 */
router.put('/:playerId/inventory/:itemId', auth, adminCheck, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const itemId = parsePlayerId(req.params.itemId);
        const cfg = readEditorConfig();
        const invCfg = cfg.inventory || FALLBACK_CONFIG.inventory;

        const record = await Item.findOne({ where: { id: itemId, player_id: playerId }, lock: t.LOCK.UPDATE, transaction: t });
        if (!record) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '背包中没有这条物品记录' });
        }

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        const changes = {};

        if (req.body.quantity !== undefined) {
            const quantity = Number(req.body.quantity);
            if (!Number.isInteger(quantity) || quantity < 0) throw new ValidationError('数量必须是不小于 0 的整数');
            if (quantity > invCfg.max_quantity) throw new ValidationError(`数量不能超过 ${invCfg.max_quantity}`);
            changes.quantity = quantity;
        }
        if (req.body.metadata !== undefined) {
            const metadata = parseJsonField(req.body.metadata);
            if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
                throw new ValidationError('metadata 必须是对象');
            }
            changes.metadata = metadata;
        }
        if (!Object.keys(changes).length) throw new ValidationError('没有需要更新的字段');

        // 数量归零等价于删除：留在库里会让"背包有这条但用不了"变成幽灵数据
        if (changes.quantity === 0) {
            await record.destroy({ transaction: t });
            await t.commit();
            await logAdminAction(req.player.id, 'edit_player_inventory', {
                target_id: playerId, action: 'remove_item', item_key: record.item_key, item_id: itemId
            }, req);
            webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { item_key: record.item_key, removed: true });
            return res.json({ code: 200, message: '物品已回收', data: { removed: true } });
        }

        for (const [key, value] of Object.entries(changes)) record[key] = value;
        await record.save({ transaction: t });
        await t.commit();

        await logAdminAction(req.player.id, 'edit_player_inventory', {
            target_id: playerId, action: 'update_item', item_key: record.item_key, item_id: itemId, changes: Object.keys(changes)
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { item_key: record.item_key });

        res.json({ code: 200, message: '背包物品已更新', data: { item: decorateWithItemName(record, dict) } });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '更新背包物品失败', error: error.message });
    }
});

/**
 * 删除背包物品记录
 * DELETE /api/admin/player-editor/:playerId/inventory/:itemId
 */
router.delete('/:playerId/inventory/:itemId', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const itemId = parsePlayerId(req.params.itemId);

        const record = await Item.findOne({ where: { id: itemId, player_id: playerId } });
        if (!record) return res.status(404).json({ code: 404, message: '背包中没有这条物品记录' });

        const itemKey = record.item_key;
        const quantity = record.quantity;
        await record.destroy();

        await logAdminAction(req.player.id, 'edit_player_inventory', {
            target_id: playerId, action: 'delete_item', item_key: itemKey, item_id: itemId, quantity
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { item_key: itemKey, removed: true });

        res.json({ code: 200, message: '物品已删除' });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '删除背包物品失败', error: error.message });
    }
});

/**
 * 清空背包
 * POST /api/admin/player-editor/:playerId/inventory/clear
 */
router.post('/:playerId/inventory/clear', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const player = await Player.findByPk(playerId);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const removed = await Item.destroy({ where: { player_id: playerId } });

        await logAdminAction(req.player.id, 'edit_player_inventory', {
            target_id: playerId, action: 'clear_inventory', removed_kinds: removed
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_inventory', { cleared: true });

        res.json({ code: 200, message: `已清空背包（${removed} 种物品）`, data: { removed_kinds: removed } });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '清空背包失败', error: error.message });
    }
});

/* ==================== 装备 ==================== */

/**
 * 强制穿戴 / 覆盖槽位（同一槽位已存在则改成新装备，避免撞唯一索引报错）
 * POST /api/admin/player-editor/:playerId/equipment
 */
router.post('/:playerId/equipment', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const eqCfg = cfg.equipment || FALLBACK_CONFIG.equipment;

        const slot = String(req.body.slot || '').trim();
        const itemKey = String(req.body.item_key || '').trim();
        if (!slot || !itemKey) throw new ValidationError('槽位与物品ID都不能为空');
        if (eqCfg.slots?.length && !eqCfg.slots.includes(slot)) {
            throw new ValidationError(`槽位只能是：${eqCfg.slots.join(' / ')}`);
        }

        const player = await Player.findByPk(playerId);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        if (!dict.has(itemKey)) throw new ValidationError(`物品 ${itemKey} 不在 item_data 配置中`);

        const payload = {
            player_id: playerId,
            slot,
            item_key: itemKey,
            equipped_at: new Date()
        };
        // 可选初始值：refine_level / durability 等
        for (const key of ['durability', 'max_durability', 'refine_level', 'spirit_power', 'sort_order', 'attr_multiplier', 'is_benming', 'benming_slot', 'is_summoned']) {
            if (req.body[key] !== undefined && (eqCfg.editable_fields || []).includes(key)) payload[key] = req.body[key];
        }

        // 一个槽位只能有一件：先删旧的再插新的比 upsert 更直白，也顺带清掉旧装备的深线状态
        const existing = await PlayerEquipment.findOne({ where: { player_id: playerId, slot } });
        if (existing) {
            await existing.destroy();
        }
        const record = await PlayerEquipment.create(payload);

        await logAdminAction(req.player.id, 'edit_player_equipment', {
            target_id: playerId, action: 'equip', slot, item_key: itemKey, replaced: !!existing
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_equipment', { slot, item_key: itemKey });

        res.json({ code: 200, message: '装备已穿戴', data: { equipment: decorateWithItemName(record, dict) } });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '穿戴装备失败', error: error.message });
    }
});

/**
 * 修改装备记录（耐久 / 祭炼等级 / 本命 / 属性倍率…）
 * PUT /api/admin/player-editor/:playerId/equipment/:equipmentId
 */
router.put('/:playerId/equipment/:equipmentId', auth, adminCheck, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const equipmentId = parsePlayerId(req.params.equipmentId);
        const cfg = readEditorConfig();
        const eqCfg = cfg.equipment || FALLBACK_CONFIG.equipment;

        const record = await PlayerEquipment.findOne({ where: { id: equipmentId, player_id: playerId }, lock: t.LOCK.UPDATE, transaction: t });
        if (!record) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '装备记录不存在' });
        }

        const allowed = eqCfg.editable_fields || [];
        const changes = {};

        /** 数值字段统一走范围校验，范围本身也在配置里 */
        const applyNumber = (key, range) => {
            if (req.body[key] === undefined) return;
            const value = Number(req.body[key]);
            if (!Number.isFinite(value)) throw new ValidationError(`${key} 必须是数字`);
            if (range && (value < range[0] || value > range[1])) {
                throw new ValidationError(`${key} 必须在 ${range[0]} ~ ${range[1]} 之间`);
            }
            changes[key] = value;
        };

        if (req.body.item_key !== undefined) {
            const itemKey = String(req.body.item_key).trim();
            if (!itemKey) throw new ValidationError('物品ID不能为空');
            changes.item_key = itemKey;
        }
        if (req.body.slot !== undefined) {
            const slot = String(req.body.slot).trim();
            if (eqCfg.slots?.length && !eqCfg.slots.includes(slot)) throw new ValidationError(`槽位只能是：${eqCfg.slots.join(' / ')}`);
            changes.slot = slot;
        }
        applyNumber('durability', eqCfg.durability_range);
        applyNumber('max_durability', eqCfg.durability_range);
        applyNumber('refine_level', eqCfg.refine_level_range);
        applyNumber('spirit_power', eqCfg.spirit_power_range);
        applyNumber('attr_multiplier', eqCfg.attr_multiplier_range);
        applyNumber('sort_order', null);
        applyNumber('benming_slot', null);
        for (const key of ['is_benming', 'is_summoned']) {
            if (req.body[key] !== undefined) changes[key] = req.body[key] === true || req.body[key] === 'true' || req.body[key] === 1;
        }
        let deepLineChanged = [];
        if (req.body.deep_line_state !== undefined) {
            const patch = parseJsonField(req.body.deep_line_state);
            if (patch === null) {
                // 显式传 null = 清空全部深线状态
                changes.deep_line_state = {};
                deepLineChanged = ['（全部清空）'];
            } else {
                if (typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('deep_line_state 必须是对象');
                const built = buildDeepLinePatch(record.deep_line_state, patch, eqCfg.deep_lines);
                changes.deep_line_state = built.next;
                deepLineChanged = built.changed;
            }
        }

        const unknown = Object.keys(changes).filter(key => !allowed.includes(key) && key !== 'deep_line_state');
        if (unknown.length) throw new ValidationError(`字段 ${unknown.join(', ')} 不允许编辑`);
        if (!Object.keys(changes).length) throw new ValidationError('没有需要更新的字段');

        for (const [key, value] of Object.entries(changes)) record[key] = value;
        // TEXT + JSON 存取器：换上的是新对象时 changed() 本就为真，这里显式标一次，
        // 免得"取出来改字段再赋回同一引用"那种写法静默丢写（ArtifactDeepLineService 也是这么标的）
        if (changes.deep_line_state) record.changed('deep_line_state', true);
        await record.save({ transaction: t });
        await t.commit();

        const dict = new Map(readItemDictionary().map(i => [String(i.id), i]));
        await logAdminAction(req.player.id, 'edit_player_equipment', {
            target_id: playerId,
            action: 'update',
            equipment_id: equipmentId,
            changes: Object.keys(changes),
            deep_line_changes: deepLineChanged
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_equipment', { equipment_id: equipmentId });

        res.json({ code: 200, message: '装备已更新', data: { equipment: decorateWithItemName(record, dict) } });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '更新装备失败', error: error.message });
    }
});

/**
 * 强制卸下（删除）装备记录
 * DELETE /api/admin/player-editor/:playerId/equipment/:equipmentId
 */
router.delete('/:playerId/equipment/:equipmentId', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const equipmentId = parsePlayerId(req.params.equipmentId);

        const record = await PlayerEquipment.findOne({ where: { id: equipmentId, player_id: playerId } });
        if (!record) return res.status(404).json({ code: 404, message: '装备记录不存在' });

        const slot = record.slot;
        const itemKey = record.item_key;
        await record.destroy();

        await logAdminAction(req.player.id, 'edit_player_equipment', {
            target_id: playerId, action: 'unequip', equipment_id: equipmentId, slot, item_key: itemKey
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_equipment', { slot, removed: true });

        res.json({ code: 200, message: '装备已卸下' });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '卸下装备失败', error: error.message });
    }
});

/* ==================== 功法 ==================== */

/**
 * 授予功法（已习得则改为更新进度，避免撞唯一索引）
 * POST /api/admin/player-editor/:playerId/techniques
 */
router.post('/:playerId/techniques', auth, adminCheck, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const cfg = readEditorConfig();
        const techCfg = cfg.techniques || FALLBACK_CONFIG.techniques;

        const techniqueId = String(req.body.technique_id || '').trim();
        if (!techniqueId) throw new ValidationError('功法ID不能为空');

        const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
        if (!player) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        const dict = new Map(readTechniqueDictionary().map(x => [String(x.id), x]));
        if (!dict.has(techniqueId) && !techCfg.allow_unknown_technique) {
            throw new ValidationError(`功法 ${techniqueId} 不在 technique_data 配置中`);
        }

        const payload = { player_id: playerId, technique_id: techniqueId, acquired_at: new Date() };
        if (req.body.layer !== undefined) payload.layer = Number(req.body.layer) || 1;
        if (req.body.proficiency !== undefined) payload.proficiency = Number(req.body.proficiency) || 0;
        if (req.body.equip_slot !== undefined) payload.equip_slot = req.body.equip_slot || null;
        if (Array.isArray(req.body.comprehended_skills)) {
            payload['comprehended_skills'] = req.body.comprehended_skills;
        }

        const existing = await PlayerTechnique.findOne({
            where: { player_id: playerId, technique_id: techniqueId },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        let record;
        if (existing) {
            for (const [key, value] of Object.entries(payload)) {
                if (key === 'player_id' || key === 'technique_id') continue;
                existing[key] = value;
            }
            await existing.save({ transaction: t });
            record = existing;
        } else {
            record = await PlayerTechnique.create(payload, { transaction: t });
        }
        await t.commit();

        await logAdminAction(req.player.id, 'edit_player_technique', {
            target_id: playerId, action: 'grant', technique_id: techniqueId, updated: !!existing
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_technique', { technique_id: techniqueId });

        res.json({ code: 200, message: '功法已授予', data: { technique: record.toJSON() } });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '授予功法失败', error: error.message });
    }
});

/**
 * 修改功法进度（层数 / 熟练度 / 装备槽 / 已领悟神通…）
 * PUT /api/admin/player-editor/:playerId/techniques/:techniqueId
 */
router.put('/:playerId/techniques/:techniqueId', auth, adminCheck, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const techniqueId = parsePlayerId(req.params.techniqueId);
        const cfg = readEditorConfig();
        const techCfg = cfg.techniques || FALLBACK_CONFIG.techniques;

        const record = await PlayerTechnique.findOne({ where: { id: techniqueId, player_id: playerId }, lock: t.LOCK.UPDATE, transaction: t });
        if (!record) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '功法记录不存在' });
        }

        const allowed = techCfg.editable_fields || [];
        const changes = {};

        /** 数值字段按配置区间校验 */
        const applyNumber = (key, range) => {
            if (req.body[key] === undefined) return;
            const value = Number(req.body[key]);
            if (!Number.isFinite(value)) throw new ValidationError(`${key} 必须是数字`);
            if (range && (value < range[0] || value > range[1])) {
                throw new ValidationError(`${key} 必须在 ${range[0]} ~ ${range[1]} 之间`);
            }
            changes[key] = value;
        };

        applyNumber('layer', techCfg.layer_range);
        applyNumber('proficiency', techCfg.proficiency_range);
        applyNumber('fail_streak', techCfg.fail_streak_range);
        applyNumber('practice_count', techCfg.practice_count_range);
        applyNumber('daily_practice_count', techCfg.practice_count_range);
        if (req.body.equip_slot !== undefined) {
            const slot = req.body.equip_slot ? String(req.body.equip_slot) : null;
            if (slot && techCfg.equip_slots?.length && !techCfg.equip_slots.includes(slot)) {
                throw new ValidationError(`装备槽只能是：${techCfg.equip_slots.join(' / ')} 或空`);
            }
            changes.equip_slot = slot;
        }
        if (req.body.comprehended_skills !== undefined) {
            if (!Array.isArray(req.body.comprehended_skills)) throw new ValidationError('comprehended_skills 必须是数组');
            changes.comprehended_skills = req.body.comprehended_skills;
        }

        const unknown = Object.keys(changes).filter(key => !allowed.includes(key));
        if (unknown.length) throw new ValidationError(`字段 ${unknown.join(', ')} 不允许编辑`);
        if (!Object.keys(changes).length) throw new ValidationError('没有需要更新的字段');

        for (const [key, value] of Object.entries(changes)) record[key] = value;
        await record.save({ transaction: t });
        await t.commit();

        await logAdminAction(req.player.id, 'edit_player_technique', {
            target_id: playerId, action: 'update', technique_record_id: techniqueId, changes: Object.keys(changes)
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_technique', { technique_record_id: techniqueId });

        res.json({ code: 200, message: '功法已更新', data: { technique: record.toJSON() } });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '更新功法失败', error: error.message });
    }
});

/**
 * 删除（遗忘）功法
 * DELETE /api/admin/player-editor/:playerId/techniques/:techniqueId
 */
router.delete('/:playerId/techniques/:techniqueId', auth, adminCheck, async (req, res) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const techniqueId = parsePlayerId(req.params.techniqueId);

        const record = await PlayerTechnique.findOne({ where: { id: techniqueId, player_id: playerId } });
        if (!record) return res.status(404).json({ code: 404, message: '功法记录不存在' });

        const techniqueKey = record.technique_id;
        await record.destroy();

        await logAdminAction(req.player.id, 'edit_player_technique', {
            target_id: playerId, action: 'forget', technique_id: techniqueKey, technique_record_id: techniqueId
        }, req);
        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_player_editor_technique', { technique_id: techniqueKey, removed: true });

        res.json({ code: 200, message: '功法已删除' });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(400).json({ code: 400, message: error.message });
        res.status(500).json({ code: 500, message: '删除功法失败', error: error.message });
    }
});

module.exports = router;
