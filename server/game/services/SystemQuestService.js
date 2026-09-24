/**
 * 系统任务「尘缘指归」
 *
 * 一条独立线性链（三卷：识途/立心/破障）：
 *   - 建号/首次打开时自动发放第一环
 *   - 当前环条件满足 → 事务内发奖 → 自动接到下一环（无手动领取）
 *   - 老号按 state / metric 追认快进，不必重做教程
 *
 * 内容全部在 config/system_quest_data.json；动作词表封闭在本文件 ACTIONS。
 * 进度只追加到「当前环」，完成后整环归档进 completed_nodes。
 */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSystemQuest = require('../../models/playerSystemQuest');
const PlayerMetrics = require('../stats/PlayerMetrics');
const { grantItems, describeGrant } = require('../items/itemGrant');
const { itemName } = require('../items/itemNaming');
const { addTitleToInstance } = require('../persistence/PlayerStateStore');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { logOnce } = require('../../utils/logOnce');

/** onAction 只认这些名字；未知动作忽略并 warn 一次 */
const ACTIONS = new Set([
    'view_player_status',
    'settle_cultivate',
    'use_item',
    'pve_win',
    'map_move',
    'choose_taoism_gate',
    'join_sect',
    'sect_check_in',
    'sect_transfer',
    'gather_complete',
    'alchemy_success',
    'open_cave',
    'breakthrough_success',
    'market_deal',
    'sect_quest_submit',
    'refine_artifact',
    'awaken_spirit',
    'beast_interact',
    'beast_deploy',
    'divine_sense_use',
    'divine_sense_duel',
    'dayan_practice',
    'ask_dao',
    'world_event_touch',
    'trial_tower',
    'world_risk_open',
    'law_fragment_gain',
    'incense_gain',
    'claim_achievement'
]);

/** state 键 → 异步判定（查不到一律 false，不抛） */
const STATE_CHECKERS = {
    has_cave: async (playerId) => {
        const row = await require('../../models/playerCave').findOne({ where: { player_id: playerId } });
        return !!(row && (row.is_opened || Number(row.spirit_vein_level) > 0));
    },
    has_spirit_beast: async (playerId) => {
        const n = await require('../../models/spiritBeast').count({ where: { player_id: playerId } });
        return n > 0;
    },
    has_sect: async (playerId) => {
        const row = await require('../../models/playerSect').findOne({ where: { player_id: playerId } });
        return !!(row && row.sect_id);
    },
    has_taoism_gate: async (playerId) => {
        const row = await require('../../models/playerTaoismGate').findOne({ where: { player_id: playerId } });
        return !!(row && row.dao_path);
    },
    has_law_fragment: async (playerId) => {
        const row = await require('../../models/playerLaw').findOne({ where: { player_id: playerId } });
        if (!row) return false;
        const keys = Object.keys(row.get?.({ plain: true }) || row.dataValues || row).filter(k => k.startsWith('law_fragments_'));
        return keys.some(k => Number(row[k] ?? row.get?.(k) ?? 0) > 0)
            || Number(row.total_earned || 0) > 0;
    },
    has_artifact_refined: async (playerId) => {
        const n = await require('../../models/playerEquipment').count({
            where: { player_id: playerId, refine_level: { [Op.gt]: 0 } }
        });
        return n > 0;
    },
    has_artifact_spirit: async (playerId) => {
        const n = await require('../../models/playerArtifactSpirit').count({ where: { player_id: playerId } });
        return n > 0;
    },
    has_achievement_claimed: async (playerId) => {
        const n = await require('../../models/playerAchievement').count({
            where: { player_id: playerId, claimed: true }
        });
        return n > 0;
    },
    has_divine_sense: async (playerId) => {
        const row = await require('../../models/playerDivineSense').findOne({ where: { player_id: playerId } });
        return !!(row && (Number(row.divine_sense_max) > 0 || Number(row.divine_sense_current) > 0 || Number(row.total_consumed) > 0));
    },
    has_dayan_or_ask_dao: async (playerId, player) => {
        try {
            const DayanService = require('./DayanService');
            const info = await DayanService.getStatus?.(playerId);
            if (info && Number(info.current_level) > 0) return true;
        } catch { /* 未开放也算没有 */ }
        const insight = Number(player?.ask_dao_insight || 0);
        if (insight > 0) return true;
        try {
            const attrs = typeof player?.attributes === 'string'
                ? JSON.parse(player.attributes || '{}')
                : (player?.attributes || {});
            return Number(attrs.ask_dao_insight || 0) > 0;
        } catch {
            return false;
        }
    },
    has_world_touch: async (playerId, player) => {
        try {
            const attrs = typeof player?.attributes === 'string'
                ? JSON.parse(player.attributes || '{}')
                : (player?.attributes || {});
            const tw = attrs.trial_tower;
            if (tw && (Number(tw.best_floor) > 0 || Number(tw.floor) > 0 || Number(tw.cleared) > 0)) return true;
            const we = attrs.world_events;
            if (we && (Number(we.participated) > 0 || Number(we.kills) > 0)) return true;
        } catch { /* blob 解析失败按无 */ }
        return false;
    },
    has_incense: async (playerId) => {
        try {
            const n = await require('../../models/playerIncenseLog').count({ where: { player_id: playerId } });
            return n > 0;
        } catch {
            return false;
        }
    },
    chain_done: async () => false
};

const UNKNOWN_ACTION_WARNED = new Set();
const UNKNOWN_STATE_WARNED = new Set();
const MAX_FAST_FORWARD = 32;

function parseJson(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function emptyProgress() {
    return { actionCounts: {}, flags: {}, satisfiedBy: null };
}

class SystemQuestService {
    initialize(configLoader) {
        this.configLoader = configLoader;
        this._validated = false;
    }

    getConfig() {
        try {
            return this.configLoader?.getConfig('system_quest_data') || {};
        } catch (e) {
            logOnce('SystemQuestService.getConfig', 'system_quest_data 读取失败，指归按未配置兜底: ' + e.message);
            return {};
        }
    }

    /** 启动期内容闸：节点/目标/动作/奖励形状；不过直接抛 */
    assertContent() {
        const cfg = this.getConfig();
        const errors = [];
        if (!cfg.chain?.id) errors.push('缺少 chain.id');
        const nodes = cfg.nodes || [];
        if (!nodes.length) errors.push('nodes 为空');

        const ids = new Set();
        for (const n of nodes) {
            if (!n.id || ids.has(n.id)) errors.push(`节点 id 重复或缺失: ${n.id}`);
            ids.add(n.id);
            if (!n.name) errors.push(`${n.id} 缺 name`);
            if (!Array.isArray(n.objectives) || !n.objectives.length) errors.push(`${n.id} 缺 objectives`);
            const walk = (obj, path) => {
                if (!obj || typeof obj !== 'object') {
                    errors.push(`${path} 不是对象`);
                    return;
                }
                const type = obj.type;
                if (type === 'action') {
                    const acts = Array.isArray(obj.actions) ? obj.actions : [obj.actions].filter(Boolean);
                    if (!acts.length) errors.push(`${path} action 无 actions`);
                    for (const a of acts) {
                        if (!ACTIONS.has(a)) errors.push(`${path} 未登记动作 ${a}`);
                    }
                } else if (type === 'state') {
                    if (!STATE_CHECKERS[obj.state]) errors.push(`${path} 未登记状态 ${obj.state}`);
                } else if (type === 'metric') {
                    if (!obj.metric) errors.push(`${path} metric 缺 metric`);
                } else if (type === 'or_group') {
                    if (!Array.isArray(obj.children) || !obj.children.length) errors.push(`${path} or_group 无 children`);
                    (obj.children || []).forEach((c, i) => walk(c, `${path}.children[${i}]`));
                } else {
                    errors.push(`${path} 未知目标类型 ${type}`);
                }
            };
            (n.objectives || []).forEach((o, i) => walk(o, `${n.id}.objectives[${i}]`));
            const logic = n.logic || 'and';
            if (logic !== 'and' && logic !== 'or') errors.push(`${n.id} logic 非法: ${logic}`);
            // panel 必须是前端 actionCatalog 里真实存在的 id（客户端 catalog 是元数据、不可 require，
            // 这里用「常见合法 id 白名单 + 非空字符串」拦明显写错；精确核对由前端 registry 自检负责）
            if (n.panel != null && (typeof n.panel !== 'string' || !n.panel)) {
                errors.push(`${n.id} panel 形状不对`);
            }
            const reward = n.rewards || {};
            if (reward.title_id && typeof reward.title_id !== 'string') errors.push(`${n.id} title_id 形状不对`);
        }

        // 卷内 order 连续且全局顺序 = 卷序 × order
        const byAct = new Map();
        for (const n of nodes) {
            if (!byAct.has(n.act)) byAct.set(n.act, []);
            byAct.get(n.act).push(n);
        }
        for (const [act, list] of byAct) {
            list.sort((a, b) => (a.order || 0) - (b.order || 0));
            list.forEach((n, i) => {
                if (Number(n.order) !== i + 1) errors.push(`卷${act} order 不连续: ${n.id} order=${n.order} 期望 ${i + 1}`);
            });
        }

        if (errors.length) {
            throw new Error(`[SystemQuestService] 内容自检失败：\n- ${errors.join('\n- ')}`);
        }
        this._validated = true;
        return true;
    }

    sortedNodes() {
        const nodes = [...(this.getConfig().nodes || [])];
        nodes.sort((a, b) => (Number(a.act) - Number(b.act)) || (Number(a.order) - Number(b.order)));
        return nodes;
    }

    nodeById(id) {
        return (this.getConfig().nodes || []).find(n => n.id === id) || null;
    }

    titleName(titleId) {
        const titles = this.configLoader?.getConfig('titles') || [];
        return (titles.find(t => t && t.id === titleId) || {}).name || null;
    }

    rewardWithNames(reward) {
        const out = { ...(reward || {}) };
        if (Array.isArray(out.items)) {
            out.items = out.items.map(entry => {
                const isObject = entry && typeof entry === 'object';
                const key = isObject ? (entry.item_key ?? entry.item_id) : entry;
                const quantity = isObject
                    ? (Number(entry.quantity ?? entry.qty ?? entry.count ?? entry.num) || 1)
                    : 1;
                const name = itemName(key);
                return {
                    item_key: String(key ?? ''),
                    quantity,
                    ...(name ? { item_name: name } : {})
                };
            });
        }
        if (typeof out.title_id === 'string' && out.title_id) {
            const name = this.titleName(out.title_id);
            if (name) out.title_name = name;
        }
        return out;
    }

    /** 评估单项目标；or_group 任一子项满足即真 */
    async evalObjective(obj, player, progress, playerId) {
        if (!obj) return { done: false, progress: 0, target: 1 };
        if (obj.type === 'or_group') {
            for (const child of obj.children || []) {
                const r = await this.evalObjective(child, player, progress, playerId);
                if (r.done) return { done: true, progress: 1, target: 1, via: child.id };
            }
            return { done: false, progress: 0, target: 1 };
        }
        if (obj.type === 'action') {
            const acts = Array.isArray(obj.actions) ? obj.actions : [obj.actions].filter(Boolean);
            const count = Number(obj.count) || 1;
            const got = acts.reduce((s, a) => s + (Number(progress.actionCounts?.[a]) || 0), 0);
            return { done: got >= count, progress: Math.min(got, count), target: count };
        }
        if (obj.type === 'state') {
            const fn = STATE_CHECKERS[obj.state];
            if (!fn) {
                if (!UNKNOWN_STATE_WARNED.has(obj.state)) {
                    UNKNOWN_STATE_WARNED.add(obj.state);
                    console.warn(`[SystemQuestService] 未登记状态 ${obj.state}，按未满足处理`);
                }
                return { done: false, progress: 0, target: 1 };
            }
            const ok = await fn(playerId, player);
            return { done: !!ok, progress: ok ? 1 : 0, target: 1 };
        }
        if (obj.type === 'metric') {
            const target = Number(obj.target) || 0;
            const value = await PlayerMetrics.metricValue(obj.metric, player, { configLoader: this.configLoader });
            return { done: value >= target, progress: Math.min(value, target), target };
        }
        return { done: false, progress: 0, target: 1 };
    }

    async evalNode(node, player, progress, playerId) {
        const list = node.objectives || [];
        const parts = [];
        for (const o of list) {
            parts.push({ id: o.id, label: o.label || o.id, ...(await this.evalObjective(o, player, progress, playerId)) });
        }
        const logic = node.logic === 'or' ? 'or' : 'and';
        const done = logic === 'or'
            ? parts.some(p => p.done)
            : parts.length > 0 && parts.every(p => p.done);
        return { done, parts, logic };
    }

    /** 面板环名：OR 路径完成时按 name_alt 锁定显示名 */
    displayName(node, progress) {
        if (!node) return '';
        if (node.name_alt && progress?.satisfiedBy && node.name_alt[progress.satisfiedBy]) {
            return node.name_alt[progress.satisfiedBy];
        }
        // 子目标 id 命中 name_alt（or_group / 平铺 OR）
        if (node.name_alt && progress?.flags) {
            for (const [k, v] of Object.entries(progress.flags)) {
                if (v && node.name_alt[k]) return node.name_alt[k];
            }
        }
        return node.name;
    }

    async getOrCreateRow(playerId, options = {}) {
        const t = options.transaction;
        const where = { player_id: playerId, chain_id: 'zhigui' };
        // 建行必须在事务外（或调用方显式传入的事务之外先建好）：
        // 与 AchievementService.claimReward 同一坑 —— 事务里 INSERT 空行会锁住索引间隙，
        // 并发 ensure 互相挡住直到锁等待超时。
        if (!t) {
            let row = await PlayerSystemQuest.findOne({ where });
            if (row) return { row, created: false };
            const first = this.sortedNodes()[0];
            row = await PlayerSystemQuest.create({
                player_id: playerId,
                chain_id: 'zhigui',
                current_node_id: first ? first.id : null,
                status: first ? 'active' : 'done',
                progress: JSON.stringify(emptyProgress()),
                completed_nodes: JSON.stringify([])
            });
            return { row, created: true };
        }
        let row = await PlayerSystemQuest.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
        if (row) return { row, created: false };
        // 事务内只允许读到已建好的行；调用方应先 ensure 走无事务路径建行
        row = await PlayerSystemQuest.findOne({ where });
        if (row) return { row, created: false };
        throw new AppError('指归进度行尚未创建', 500, ErrorCodes.INTERNAL_ERROR);
    }

    /**
     * 确保链存在并追认快进。
     * 发奖失败（背包满等）**不吞错进事务**：整笔回滚，保证不半发；外层捕获后仍返回可展示的 board。
     * @returns {Promise<{row, advanced: Array, grant_error?: string}>}
     */
    async ensureChain(playerId) {
        if (!this.getConfig().nodes?.length) return { row: null, advanced: [] };
        // 先在事务外建行，避免间隙锁
        await this.getOrCreateRow(playerId);
        try {
            const result = await sequelize.transaction(async (t) => {
                const row = await PlayerSystemQuest.findOne({
                    where: { player_id: playerId, chain_id: 'zhigui' },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!row) return { row: null, advanced: [] };
                const advanced = await this._fastForward(row, playerId, t);
                return { row, advanced };
            });
            if (result.advanced?.length) await this._notify(playerId, result.advanced);
            return result;
        } catch (e) {
            if (e instanceof AppError) {
                // 发奖失败：事务已整笔回滚，行停在当前环；面板照常可开
                logOnce(`SystemQuestService.ensureChain.${playerId}`, `指归追认暂不推进: ${e.message}`);
                const row = await PlayerSystemQuest.findOne({ where: { player_id: playerId, chain_id: 'zhigui' } });
                return { row, advanced: [], grant_error: e.message };
            }
            throw e;
        }
    }

    async _fastForward(row, playerId, t) {
        const advanced = [];
        for (let i = 0; i < MAX_FAST_FORWARD; i++) {
            if (row.status === 'done' || !row.current_node_id) break;
            const node = this.nodeById(row.current_node_id);
            if (!node) break;
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) break;
            const progress = parseJson(row.progress, emptyProgress());
            const result = await this.evalNode(node, player, progress, playerId);
            if (!result.done) break;
            // 用判定结果补全 satisfiedBy（OR 路径）
            if (!progress.satisfiedBy) {
                const hit = result.parts.find(p => p.done);
                if (hit) progress.satisfiedBy = hit.id;
            }
            // 发奖失败必须抛出事务：半发会 commit 已入包的件，重试再整包 → 重复发
            const grant = await this._completeCurrent(row, player, node, progress, t);
            advanced.push({ node_id: node.id, name: this.displayName(node, progress), reward: grant });
        }
        return advanced;
    }

    /**
     * 发奖并推进指针。调用方必须已在事务中持有行锁。
     * 发奖失败抛错 → 整笔回滚，不推进。
     */
    async _completeCurrent(row, player, node, progress, t) {
        const reward = node.rewards || {};
        const ss = Number(reward.spirit_stones) || 0;
        const exp = Number(reward.exp) || 0;
        const itemEntries = Array.isArray(reward.items) ? reward.items : [];
        const titleId = typeof reward.title_id === 'string' ? reward.title_id : '';

        let itemsText = '';
        if (itemEntries.length) {
            const grant = await grantItems(player.id, itemEntries, t, { label: `指归:${node.id}` });
            if (grant.failed.length) {
                const detail = grant.failed
                    .map(f => `${itemName(f.item_key) || f.item_key}×${f.quantity}：${f.reason}`)
                    .join('；');
                throw new AppError(
                    `背包放不下，指归《${node.name}》奖励未发放（${detail}）。清理背包后会自动补发，本次不推进`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            itemsText = describeGrant(grant.granted).text;
        }

        const titleAdded = titleId ? addTitleToInstance(player, titleId) : false;
        const titleText = (titleId && titleAdded) ? (this.titleName(titleId) || titleId) : '';

        if (ss > 0) player.spirit_stones = Number(player.spirit_stones) + ss;
        if (exp > 0) player.exp = Number(player.exp) + exp;
        await player.save({ transaction: t });

        try {
            WebSocketNotificationService.notifyPlayerUpdate(player.id, 'resource', {
                spirit_stones: player.spirit_stones,
                exp: player.exp
            });
        } catch { /* 通知失败不影响发奖 */ }

        const completed = parseJson(row.completed_nodes, []);
        completed.push({
            id: node.id,
            name: this.displayName(node, progress),
            at: new Date().toISOString(),
            satisfiedBy: progress.satisfiedBy || null
        });

        const nodes = this.sortedNodes();
        const idx = nodes.findIndex(n => n.id === node.id);
        const next = idx >= 0 ? nodes[idx + 1] : null;

        row.completed_nodes = JSON.stringify(completed);
        if (next) {
            row.current_node_id = next.id;
            row.progress = JSON.stringify(emptyProgress());
            row.status = 'active';
        } else {
            row.current_node_id = null;
            row.progress = JSON.stringify(emptyProgress());
            row.status = 'done';
            row.completed_at = new Date();
        }
        await row.save({ transaction: t });

        const parts = [];
        if (ss > 0) parts.push(`${ss} 灵石`);
        if (exp > 0) parts.push(`${exp} 修为`);
        if (itemsText) parts.push(itemsText);
        if (titleText) parts.push(`称号《${titleText}》`);
        else if (titleId) parts.push(`${this.titleName(titleId) || titleId}（此前已在身）`);

        return {
            message: `指归《${this.displayName(node, progress)}》：${parts.length ? parts.join('、') : '无'}`,
            spirit_stones: ss,
            exp,
            items: this.rewardWithNames(reward).items || [],
            title_id: titleId || null,
            title_added: titleAdded,
            next_node_id: next ? next.id : null,
            chain_done: !next
        };
    }

    /**
     * 事件点上报动作。幂等累加；可能触发自动续环。
     * 故意不抛错：接线点是业务成功路径末尾，不能因指归挂掉而影响原业务。
     */
    async onAction(playerId, action, meta = {}) {
        try {
            if (!playerId || !ACTIONS.has(action)) {
                if (action && !UNKNOWN_ACTION_WARNED.has(action)) {
                    UNKNOWN_ACTION_WARNED.add(action);
                    console.warn(`[SystemQuestService] 未登记动作 "${action}"，已忽略`);
                }
                return null;
            }
            const cfg = this.getConfig();
            if (!cfg.nodes?.length) return null;

            // 1) 先落进度（独立事务）：动作已发生，发奖失败也不能把计数弄丢
            await this.getOrCreateRow(playerId);
            await sequelize.transaction(async (t) => {
                const row = await PlayerSystemQuest.findOne({
                    where: { player_id: playerId, chain_id: 'zhigui' },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!row || row.status === 'done' || !row.current_node_id) return;
                const progress = parseJson(row.progress, emptyProgress());
                progress.actionCounts = progress.actionCounts || {};
                const delta = Number(meta.count) > 0 ? Number(meta.count) : 1;
                progress.actionCounts[action] = (Number(progress.actionCounts[action]) || 0) + delta;
                progress.flags = progress.flags || {};
                progress.flags[action] = true;
                // OR 路径名锁定：只在动作真的被当前环目标引用时写入
                const node = this.nodeById(row.current_node_id);
                if (!progress.satisfiedBy && this._actionUsedByNode(node, action)) {
                    progress.satisfiedBy = action;
                }
                row.progress = JSON.stringify(progress);
                await row.save({ transaction: t });
            });

            // 2) 再尝试推进（独立事务）：发奖失败整笔回滚，不半发
            const result = await sequelize.transaction(async (t) => {
                const row = await PlayerSystemQuest.findOne({
                    where: { player_id: playerId, chain_id: 'zhigui' },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!row || row.status === 'done' || !row.current_node_id) return { advanced: [] };
                const advanced = await this._fastForward(row, playerId, t);
                return { advanced };
            });
            if (result?.advanced?.length) {
                await this._notify(playerId, result.advanced);
            }
            return result;
        } catch (e) {
            logOnce(`SystemQuestService.onAction.${action}`, `指归 onAction(${action}) 失败（不影响原业务）: ${e.message}`);
            return null;
        }
    }

    /** 当前环是否用到该动作（用于 OR 显示名锁定） */
    _actionUsedByNode(node, action) {
        if (!node) return false;
        const walk = (obj) => {
            if (!obj || typeof obj !== 'object') return false;
            if (obj.type === 'action') {
                const acts = Array.isArray(obj.actions) ? obj.actions : [obj.actions].filter(Boolean);
                return acts.includes(action);
            }
            if (obj.type === 'or_group') {
                return (obj.children || []).some(walk);
            }
            return false;
        };
        return (node.objectives || []).some(walk);
    }

    async _notify(playerId, advanced) {
        try {
            const last = advanced[advanced.length - 1];
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'system_quest', {
                advanced: advanced.map(a => ({ node_id: a.node_id, name: a.name, message: a.reward?.message })),
                chain_done: !!(last?.reward?.chain_done)
            });
            if (last?.reward?.message) {
                WebSocketNotificationService.sendToPlayer(playerId, {
                    type: 'system_quest',
                    title: '尘缘指归',
                    message: last.reward.message
                });
            }
        } catch (e) { /* 通知失败不影响推进 */ }
    }

    /**
     * 面板全量。先 ensure（含追认快进）。
     */
    async getBoard(playerId) {
        const cfg = this.getConfig();
        if (!cfg.nodes?.length) {
            throw new AppError('尘缘指归尚未配置', 503, ErrorCodes.FEATURE_DISABLED);
        }
        const { row, advanced, grant_error } = await this.ensureChain(playerId);
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const progress = parseJson(row.progress, emptyProgress());
        const completed = parseJson(row.completed_nodes, []);
        const completedIds = new Set(completed.map(c => c.id));
        const nodes = this.sortedNodes();

        const outNodes = [];
        for (const n of nodes) {
            const isDone = completedIds.has(n.id);
            const isActive = row.current_node_id === n.id && row.status === 'active';
            const locked = !isDone && !isActive;
            let objectiveParts = [];
            let name = n.name;
            if (isDone) {
                const rec = completed.find(c => c.id === n.id);
                name = rec?.name || n.name;
            } else if (isActive) {
                const result = await this.evalNode(n, player, progress, playerId);
                objectiveParts = result.parts.map(p => ({
                    id: p.id,
                    label: p.label,
                    done: !!p.done,
                    progress: p.progress,
                    target: p.target
                }));
                name = this.displayName(n, progress);
            }
            outNodes.push({
                id: n.id,
                act: n.act,
                order: n.order,
                name,
                tagline: isActive || isDone ? n.tagline : null,
                body: isActive || isDone ? n.body : null,
                hint: isActive ? n.hint : null,
                teach: n.teach,
                panel: isActive ? n.panel : null,
                logic: n.logic || 'and',
                state: isDone ? 'done' : (isActive ? 'active' : 'locked'),
                objectives: objectiveParts,
                rewards: locked ? null : this.rewardWithNames(n.rewards)
            });
        }

        const current = outNodes.find(x => x.state === 'active') || null;
        return {
            chain: {
                id: cfg.chain.id,
                name: cfg.chain.name,
                short_name: cfg.chain.short_name,
                intro: cfg.chain.intro,
                ending: row.status === 'done' ? cfg.chain.ending : null,
                status: row.status,
                final_title_id: cfg.chain.final_title_id || null
            },
            acts: (cfg.acts || []).map(a => ({
                id: a.id,
                name: a.name,
                subtitle: a.subtitle,
                epilogue: a.epilogue
            })),
            nodes: outNodes,
            current_node_id: row.current_node_id,
            completed_count: completed.length,
            total_count: nodes.length,
            last_grant: advanced.length ? advanced[advanced.length - 1].reward : null,
            grant_error: grant_error || null
        };
    }

    async getCurrent(playerId) {
        const board = await this.getBoard(playerId);
        const current = board.nodes.find(n => n.state === 'active') || null;
        return {
            chain: board.chain,
            current_node_id: board.current_node_id,
            current,
            completed_count: board.completed_count,
            total_count: board.total_count
        };
    }
}

module.exports = new SystemQuestService();
module.exports.ACTIONS = ACTIONS;
module.exports.STATE_CHECKERS = STATE_CHECKERS;
