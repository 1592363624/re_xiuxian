/**
 * 世界动态日志服务
 *
 * 把「别人刚做了什么」推进全服在线玩家的修仙日志「全部」流，
 * 让单人挂机时也能感知到世界里还有别的道友在动。
 *
 * 设计约束：
 *   - 只广播配置白名单里的关键结果（突破/陨落/闭关/历练/道侣…），
 *     不广播每一次采集/每一回合战斗，避免刷成聊天室。
 *   - 不回推给操作者本人：自己的动作前端本来就以 actorId='self' 写日志。
 *   - 非重要动态按人冷却 + 全服每分钟上限；重要动态可穿透冷却。
 *   - 文案模板只用调用方 changes 里的公开字段，不夹带灵石余额等隐私。
 */
const fs = require('fs');
const path = require('path');
const configLoader = require('../../modules/infrastructure/ConfigLoader');

const CONFIG_FILE = path.join(__dirname, '../../config/world_activity.json');

const FALLBACK = {
    enabled: true,
    rate_limit: { per_actor_ms: 10000, global_per_minute: 60, important_bypass: true },
    events: {}
};

class WorldActivityService {
    constructor() {
        /** @type {Map<string, number>} actorKey -> last publish ts */
        this.lastByActor = new Map();
        /** @type {number[]} 最近全服发布时间戳，用于每分钟限流 */
        this.recentGlobal = [];
        /** @type {Map<string, {name: string, at: number}>} 玩家道号短缓存 */
        this.nameCache = new Map();
        this.nameCacheTtlMs = 60_000;
    }

    getConfig() {
        // 优先走 ConfigLoader（热更/资料片合并后的视图）
        try {
            const hot = configLoader.peekConfig?.('world_activity');
            if (hot) return hot;
        } catch { /* 未初始化时继续读盘 */ }
        // 启动前 / 单测：ConfigLoader 还没 loadAllConfigs，直接读盘拿白名单
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch {
            return FALLBACK;
        }
    }

    /**
     * 模板插值：{key} 取 changes[key]；缺字段则整段模板放弃（避免出现 "{new_realm}" 原文）
     * @param {string} template
     * @param {Object} vars
     * @returns {string|null}
     */
    renderTemplate(template, vars = {}) {
        if (!template) return null;
        let ok = true;
        const text = String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
            const v = vars[key];
            if (v === undefined || v === null || v === '') {
                ok = false;
                return '';
            }
            return String(v);
        });
        return ok && text.trim() ? text.trim() : null;
    }

    /**
     * 解析玩家道号（带短缓存；失败回退「某位道友」）
     * @param {number|string} playerId
     * @param {string} [hint]
     * @returns {Promise<string>}
     */
    async resolveNickname(playerId, hint) {
        if (hint) return hint;
        const key = String(playerId);
        const hit = this.nameCache.get(key);
        if (hit && Date.now() - hit.at < this.nameCacheTtlMs) return hit.name;
        try {
            const Player = require('../../models/player');
            const player = await Player.findByPk(playerId, { attributes: ['id', 'nickname'] });
            const name = player?.nickname || '某位道友';
            this.nameCache.set(key, { name, at: Date.now() });
            return name;
        } catch {
            return '某位道友';
        }
    }

    /**
     * 限流：非重要动态按人冷却 + 全服每分钟上限
     * @returns {boolean} true = 允许发出
     */
    allow(actorKey, isImportant, cfg) {
        const rl = cfg.rate_limit || FALLBACK.rate_limit;
        const now = Date.now();

        // 全服每分钟
        this.recentGlobal = this.recentGlobal.filter(ts => now - ts < 60_000);
        if (this.recentGlobal.length >= (rl.global_per_minute ?? 60)) {
            if (!isImportant || !rl.important_bypass) return false;
        }

        if (!isImportant || !rl.important_bypass) {
            const last = this.lastByActor.get(actorKey) || 0;
            if (now - last < (rl.per_actor_ms ?? 10_000)) return false;
        }

        this.lastByActor.set(actorKey, now);
        this.recentGlobal.push(now);
        return true;
    }

    /**
     * 发布一条世界动态（推给除 actor 以外的在线玩家）
     *
     * @param {Object} params
     * @param {number|string} params.playerId 操作者
     * @param {string} [params.nickname] 道号（缺省会查库）
     * @param {string} params.content 不含道号的动作描述
     * @param {string} [params.type] 日志类型（对齐前端 logTypes）
     * @param {boolean} [params.isImportant]
     */
    async publish({ playerId, nickname, content, type = 'info', isImportant = false }) {
        const cfg = this.getConfig();
        if (!cfg.enabled || !content) return false;

        const actorKey = String(playerId ?? 'anon');
        if (!this.allow(actorKey, !!isImportant, cfg)) return false;

        const actorName = await this.resolveNickname(playerId, nickname);
        const payload = {
            playerId: playerId ?? null,
            actorId: playerId ?? null,
            actorName,
            content,
            type,
            isImportant: !!isImportant,
            timestamp: new Date().toISOString()
        };

        try {
            // 懒加载，避免与 WebSocketNotificationService 循环 require
            const WebSocketNotificationService = require('./WebSocketNotificationService');
            WebSocketNotificationService.broadcastActivity(payload);
            return true;
        } catch (e) {
            console.warn('[WorldActivity] 广播失败:', e.message);
            return false;
        }
    }

    /**
     * 从 notifyPlayerUpdate 的 updateType/changes 自动映射成一条世界动态。
     * 白名单与文案在 config/world_activity.json，新增玩法只改配置。
     *
     * @param {number|string} playerId
     * @param {string} updateType
     * @param {Object} changes
     */
    async fromPlayerUpdate(playerId, updateType, changes = {}) {
        const cfg = this.getConfig();
        if (!cfg.enabled) return false;
        const rule = cfg.events?.[updateType];
        if (!rule) return false;

        const content = this.renderTemplate(rule.content, changes);
        if (!content) return false;

        return this.publish({
            playerId,
            nickname: changes.nickname || changes.actorName,
            content,
            type: rule.type || 'info',
            isImportant: !!rule.isImportant
        });
    }
}

module.exports = new WorldActivityService();
