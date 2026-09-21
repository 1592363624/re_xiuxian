/**
 * 属性服务：对外的属性计算入口，内部委托给 StatEngine + StatRegistry。
 *
 * 改造要点（2026-09-20）：
 *   旧实现在这一个函数里手写 9 个加成来源、并硬编码 3 份属性词表
 *   （base 初值、可加点白名单、描述与图标），且三种百分比口径互相冲突：
 *   天赋/称号按"基础值"乘算、法宝深线按"最终值"乘算、修炼速度又是另一套。
 *   结果是给一件武器加一个新属性，需要同时改本文件、AttributeMaxService、
 *   game_balance 的祭炼表、各 Service 的战力公式和前端标签表共 23+ 处。
 *
 *   现在：词表来自 stat_definitions（可被资料片追加），来源以 provider 注册，
 *   聚合口径全游戏唯一 —— value = clamp((base + Σflat) × (1 + Σpct))。
 *   加属性只改数据；加来源只注册 provider；本文件不再认识具体玩法。
 *
 * 口径变化（唯一的数值行为变更，需要留意平衡）：
 *   天赋/称号的 *_pct 加成正从"只乘境界基础值"变为"乘含装备等全部绝对值后的基数"。
 *   同时旧代码会把 atk_pct 这类键原样留在 final 里污染属性面板，现在不会了。
 *
 * 同步 / 异步两条路径的边界与改造前保持一致：
 *   calculateFullAttributes(player)        静态快照：境界 + 灵根 + 加点/丹药 + 天赋 + 称号
 *   calculateFullAttributesAsync(player)   完整快照：再叠加 装备 / 灵兽 / 功法 / 法宝深线
 *   （副本与宗门战开局刻意使用静态快照，避免战斗中途换装导致属性突变。）
 */
const { statRegistry, ensureStatRegistryLoaded } = require('../stats');
const { StatEngine } = require('../stats');
const { buildProviders } = require('../stats/providers');
const { spiritRootBonus } = require('../stats/SpiritRoot');
const PlayerStateStore = require('../persistence/PlayerStateStore');

/** attribute_system.json: attribute_reset 缺失时的兜底规则 */
const DEFAULT_RESET_CONFIG = {
    cost_spirit_stones: 500,
    cooldown_minutes: 1440
};

/** 存储键 → 前端属性名，由注册表推导，用于回收加点时反查 */
const ALLOCATION_LEDGER_KEY = 'attribute_point_allocations';

/** 单属性单次加点上限（总量上限仍由 attribute_pill_limits 统一钳制） */
const MAX_POINTS_PER_ATTRIBUTE = 100;
const MAX_TOTAL_BONUS_PER_ATTRIBUTE = 1000000;

/** provider id → 旧 breakdown 分组名，保持前端与 WorldBossService 等调用点的读取路径不变 */
const LEGACY_BREAKDOWN_GROUPS = [
    ['spirit_root', 'spirit_root'],
    ['allocated', 'allocated'],
    ['talent', 'talent'],
    ['title', 'title'],
    ['equipment', 'equipment'],
    ['spirit_beast', 'spirit_beast'],
    ['artifact_deep_line', 'artifact_deep_line'],
    ['technique', 'cultivation'],
    // 傀儡此前只在 by_stat / info 里有，legacy breakdown 里没有这一组：
    // 任何按来源分组读明细的地方（"加成来自哪里"列表）都会漏掉出战傀儡。
    ['puppet', 'puppet']
];

class AttributeService {
    constructor() {
        this.configLoader = null;
        this._engine = null;
    }

    /**
     * 初始化属性服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        this._engine = null; // 换配置源时重建
    }

    /** 属性词表：正常由内容层装配，独立使用本服务时退回基础定义 */
    get registry() {
        return ensureStatRegistryLoaded(this.configLoader);
    }

    /** 懒建引擎：provider 依赖 configLoader 与注册表，装配发生在内容层就绪之后 */
    get engine() {
        if (!this._engine) {
            this._engine = new StatEngine(this.registry, { strict: false });
            for (const provider of buildProviders(this.registry, this.configLoader)) {
                this._engine.registerProvider(provider);
            }
        }
        return this._engine;
    }

    /**
     * 获取角色初始化配置
     * @returns {Object} 角色初始化配置
     */
    getRoleInitConfig() {
        return this.configLoader?.getConfig('role_init') || {};
    }

    /**
     * 获取境界配置
     * @param {string} realmName - 境界名称
     * @returns {Object|null} 境界配置
     */
    getRealmConfig(realmName) {
        let config = null;
        try {
            config = this.configLoader?.getConfig('realm_breakthrough');
        } catch (error) {
            // 配置文件缺失/未加载时按"无境界数据"兜底，属性回落到定义里的 default，
            // 而不是让整个属性面板挂掉
            this._warnConfigOnce(error.message);
            return null;
        }
        if (!config?.realms) {
            // 走到这里属性会整体落到定义里的 default —— 表现为"真仙也算成凡人"，
            // 而面板照样打得开、也不抛错，所以必须喊一声（ConfigLoader 没注入是最常见成因）
            this._warnConfigOnce('realm_breakthrough 配置不可用（ConfigLoader 未初始化或数据集缺失）');
            return null;
        }
        const realm = config.realms.find(r => r.name === realmName) || null;
        if (!realm && realmName) this._warnUnknownRealmOnce(realmName);
        return realm;
    }

    /** 同一个境界名只报一次，避免每个请求刷一条日志；不同名字分别报（要能看出到底哪些名字坏了） */
    _warnUnknownRealmOnce(realmName) {
        this._unknownRealms = this._unknownRealms || new Set();
        if (this._unknownRealms.has(realmName)) return;
        this._unknownRealms.add(realmName);
        console.warn(
            `[AttributeService] 境界「${realmName}」在 realm_breakthrough 里查不到，` +
            '该玩家的属性按定义里的 default 兜底（境界加成全部丢失）。' +
            '常见成因：资料片删/改了基础境界链，或 players.realm 里存了一个不存在的名号。'
        );
    }

    _warnConfigOnce(message) {
        if (this._configWarned) return;
        this._configWarned = true;
        console.warn(`[AttributeService] 配置读取失败，属性按默认兜底: ${message}`);
    }

    /**
     * 获取天赋配置
     */
    getTalentConfig(talentId) {
        const talents = this.configLoader?.getConfig('talents') || [];
        return talents.find(t => t.id === talentId) || null;
    }

    /**
     * 获取称号配置
     */
    getTitleConfig(titleId) {
        const titles = this.configLoader?.getConfig('titles') || [];
        return titles.find(t => t.id === titleId) || null;
    }

    /**
     * 获取所有称号配置
     */
    getAllTitles() {
        return this.configLoader?.getConfig('titles') || [];
    }

    /** 解析 attributes 存储列（TEXT 列的 getter 已反序列化，这里兼容裸字符串与实例） */
    _attributesOf(player) {
        const raw = player?.attributes;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw) || {};
            } catch {
                return {};
            }
        }
        return raw || {};
    }

    /** 组装求解上下文：所有 base 取值环境都在这里备齐，引擎自身不碰配置 */
    _buildContext(player, { sourceOverrides = null, realmOverride = null, realmNameOverride = null } = {}) {
        const realmName = realmNameOverride || player?.realm;
        const realm = realmOverride || this.getRealmConfig(realmName) || {};
        let spiritRealm = null;
        try {
            spiritRealm = this.configLoader?.getConfig('spirit_system')?.realm_settings?.[realmName] || null;
        } catch {
            spiritRealm = null;
        }
        return {
            player,
            realm,
            spiritRealm,
            attributes: this._attributesOf(player),
            sourceOverrides,
            baseInfo: {},
            contentVersion: player?.content_version ?? null
        };
    }

    /**
     * 计算玩家完整属性（静态快照，不查库）
     * @param {Object} player - 玩家对象
     * @param {Object} [options] - { realmOverride: 单个境界对象（如突破后的下一境界预览） }
     * @returns {Object} { final, breakdown, info }
     */
    calculateFullAttributes(player, options = {}) {
        if (!player) return { final: {}, breakdown: {}, info: {} };
        const ctx = this._buildContext(player, options);
        return this._shape(player, ctx, this.engine.resolveStatic(ctx));
    }

    /**
     * 计算玩家完整属性（完整快照：含装备/灵兽/功法/法宝深线）
     *
     * 不再往 player 对象上挂 _equipmentBonus 之类的临时字段：
     * 旧做法在同一 player 实例上并发两次求解时会互相覆盖、并在先结束的一方 delete 掉
     * 另一方正在用的值。改为把预计算加成通过 ctx.sourceOverrides 传递，纯函数式。
     *
     * @param {Object} player - 玩家对象
     * @param {Object} [options] - { sourceOverrides: { equipment, spirit_beast, technique, artifact_deep_line } }
     * @returns {Promise<Object>} { final, breakdown, info }
     */
    async calculateFullAttributesAsync(player, options = {}) {
        if (!player) return { final: {}, breakdown: {}, info: {} };
        const ctx = this._buildContext(player, options);
        return this._shape(player, ctx, await this.engine.resolve(ctx));
    }

    /** 把引擎输出整形成改造前的 { final, breakdown, info } 契约 */
    _shape(player, ctx, resolved) {
        const { final, breakdown: byStat, meta } = resolved;

        // 旧 breakdown：按来源分组，值为该来源对各属性的实际贡献绝对值
        const breakdown = { base: {} };
        for (const statKey of Object.keys(byStat)) {
            breakdown.base[statKey] = byStat[statKey].base;
        }
        for (const [providerId, legacyGroup] of LEGACY_BREAKDOWN_GROUPS) {
            const group = {};
            for (const [statKey, detail] of Object.entries(byStat)) {
                for (const contribution of detail.sources) {
                    if (contribution.from !== providerId) continue;
                    const pctBasis = detail.base + detail.flat_total;
                    const effective = contribution.flat + (detail.agg === 'flat_then_pct'
                        ? Math.floor(pctBasis * contribution.pct)
                        : 0);
                    if (effective !== 0) group[statKey] = (group[statKey] || 0) + effective;
                }
            }
            if (providerId === 'artifact_deep_line') {
                const artifact = ctx.artifactDeepLine;
                breakdown[legacyGroup] = {
                    is_active: !!(artifact && artifact.is_active),
                    absolute: artifact?.absolute || {},
                    percent: artifact?.percent || {},
                    effects: artifact?.effects || {},
                    sources: artifact?.breakdown || {}
                };
            } else {
                breakdown[legacyGroup] = group;
            }
        }

        const info = {
            talent: ctx.talentConfig || null,
            title: ctx.titleConfig || null,
            spirit_root: player.spirit_root || '无',
            spirit_beast: ctx.beastInfo || null,
            artifact_deep_line: ctx.artifactDeepLine?.is_active ? (ctx.artifactDeepLine.effects || null) : null,
            technique_skills: ctx.techniqueSkills || []
        };

        return { final, breakdown, info, by_stat: byStat, meta };
    }

    /**
     * 获取灵根属性加成
     * @param {Object} player - 玩家对象（灵根存储形状由 SpiritRoot 统一归一）
     * @returns {Object} 加成信息，未登记灵根时为空对象
     */
    getSpiritRootBonus(player) {
        return spiritRootBonus(player, this.getRoleInitConfig());
    }

    /** 可加点白名单：客户端属性名 → attributes 存储键，全部由属性注册表推导 */
    get allocatableBonusKeys() {
        return this.registry.allocatableMap();
    }

    /**
     * 加点结算（纯策略，不碰数据库）
     *
     * 拆出来的原因：入参是"当前 attributes 快照"，返回值是"应该写回的那份 attributes"，
     * 于是调用方可以在行锁内拿最新一份再算，而不是拿请求开始时的旧快照算完就整块写回。
     *
     * @param {Object} attributes - 当前 attributes（锁内新鲜读出的那份）
     * @param {Object} points - 加点分配 { hp: 2, atk: 1 }
     * @param {number} availablePoints - 可用属性点
     * @returns {{ok: boolean, message?: string, attributes?: Object, totalPointsNeeded?: number}}
     */
    buildAllocationPlan(attributes, points, availablePoints) {
        const whitelist = this.allocatableBonusKeys;

        if (!points || typeof points !== 'object' || Array.isArray(points)) {
            return { ok: false, message: '加点参数格式错误' };
        }

        const entries = Object.entries(points);
        if (entries.length === 0) {
            return { ok: false, message: '加点参数不能为空' };
        }

        for (const [attr, value] of entries) {
            // hasOwnProperty 判定：防止 '__proto__' 等键取到原型对象而绕过白名单
            if (!Object.prototype.hasOwnProperty.call(whitelist, attr)) {
                return { ok: false, message: `未知的属性项: ${attr}` };
            }
            if (!Number.isInteger(value) || value < 1) {
                return { ok: false, message: `${attr} 的加点数必须为正整数` };
            }
            if (value > MAX_POINTS_PER_ATTRIBUTE) {
                return { ok: false, message: `${attr} 单次加点不能超过 ${MAX_POINTS_PER_ATTRIBUTE} 点` };
            }
        }

        const totalPointsNeeded = entries.reduce((sum, [, value]) => sum + value, 0);
        if (totalPointsNeeded > (availablePoints || 0)) {
            return {
                ok: false,
                message: `可用属性点不足，需要 ${totalPointsNeeded} 点，仅有 ${availablePoints || 0} 点`
            };
        }

        const nextAttributes = { ...attributes };
        const ledger = { ...(attributes[ALLOCATION_LEDGER_KEY] || {}) };
        for (const [attr, value] of entries) {
            const bonusAttr = whitelist[attr];
            const before = Number(nextAttributes[bonusAttr]) || 0;
            nextAttributes[bonusAttr] = Math.min(before + value, MAX_TOTAL_BONUS_PER_ATTRIBUTE);
            // 账本只记实际入账的点数（受总量上限截断），否则重置时会多退属性点
            const credited = nextAttributes[bonusAttr] - before;
            if (credited > 0) {
                ledger[bonusAttr] = (Number(ledger[bonusAttr]) || 0) + credited;
            }
        }
        nextAttributes[ALLOCATION_LEDGER_KEY] = ledger;

        return { ok: true, attributes: nextAttributes, totalPointsNeeded };
    }

    /**
     * 属性加点（落库）
     *
     * 读-算-写全程在同一事务的行锁内完成，写回走 PlayerStateStore 的补丁接口：
     * 连点两次"确认加点"时，第二次不会把第一次的 *_bonus 与加点账本一起抹掉
     * （旧实现是 req.player 的旧快照整块回写，账本被回退后属性点还能再花一遍）。
     *
     * @param {Object} player - 玩家对象
     * @param {Object} points - 加点分配 { hp: 2, atk: 1 }
     * @returns {Object} 加点结果
     */
    async allocatePoints(player, points) {
        const outcome = await PlayerStateStore.withTransaction(async (t) => {
            const fresh = await PlayerStateStore.readForUpdate(player.id, { transaction: t });
            const plan = this.buildAllocationPlan(
                this._attributesOf(fresh),
                points,
                fresh.attribute_points || 0
            );
            if (!plan.ok) return { failure: plan.message };

            const remaining = (fresh.attribute_points || 0) - plan.totalPointsNeeded;
            const updated = await PlayerStateStore.patchPlayerState(
                fresh.id,
                { attributes: plan.attributes, columns: { attribute_points: remaining } },
                { transaction: t }
            );
            return { player: updated, remainingPoints: remaining };
        });

        if (outcome.failure) return { success: false, message: outcome.failure };

        const updated = outcome.player;
        // 让调用方手上的实例反映最新状态，但写库只发生过一次（来自锁内那份）：
        // attributes 只镜像、不标脏，否则这个实例之后任何一次 save() 都会拿它覆盖
        // 这期间别的流程写进 attributes 的键。
        PlayerStateStore.mirrorPatchedBlob(player, updated);
        player.attribute_points = updated.attribute_points;

        const fullStats = this.calculateFullAttributes(updated);

        return {
            success: true,
            message: '属性点分配成功',
            newAttributes: fullStats.final,
            remainingPoints: outcome.remainingPoints
        };
    }

    /**
     * 读取属性点重置规则（attribute_system.json: attribute_reset）
     * @returns {Object} { cost_spirit_stones, cooldown_minutes }
     */
    getAttributeResetConfig() {
        const configured = this.configLoader?.getConfig('attribute_system')?.attribute_reset || {};
        const cost = Number(configured.cost_spirit_stones);
        const cooldown = Number(configured.cooldown_minutes);

        return {
            cost_spirit_stones: Number.isFinite(cost) && cost >= 0 ? cost : DEFAULT_RESET_CONFIG.cost_spirit_stones,
            cooldown_minutes: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_RESET_CONFIG.cooldown_minutes
        };
    }

    /**
     * 计算可回收的属性加点
     *
     * 只回收"加点账本"里记录的数值，丹药/装备等其他来源的 *_bonus 不受影响也不退点，
     * 否则吃一颗属性丹再来重置就能凭空换回可分配点数。
     *
     * @param {Object} player - 玩家对象
     * @returns {Object} { refundablePoints, refunded: {hp_bonus: n}, attributes }
     */
    buildAllocatedPointsReset(player) {
        const attributes = { ...this._attributesOf(player) };
        const ledger = attributes[ALLOCATION_LEDGER_KEY];
        const nextAttributes = { ...attributes };
        const refunded = {};
        let refundablePoints = 0;

        // 可回收的存储键同样由注册表推导，且只限"可加点"的属性
        const pointable = new Set(Object.values(this.registry.allocatableMap()));

        if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
            for (const [bonusKey, amountRaw] of Object.entries(ledger)) {
                if (!pointable.has(bonusKey)) continue;

                const amount = Math.floor(Number(amountRaw));
                if (!Number.isFinite(amount) || amount <= 0) continue;

                const current = Number(nextAttributes[bonusKey]) || 0;
                // 账本值可能大于实际加成（例如历史脏数据），按较小值回收，避免把属性扣成负数
                const reclaimed = Math.min(current, amount);
                if (reclaimed <= 0) continue;

                nextAttributes[bonusKey] = current - reclaimed;
                refundablePoints += reclaimed;
                refunded[bonusKey] = reclaimed;
            }
        }

        delete nextAttributes[ALLOCATION_LEDGER_KEY];

        return { refundablePoints, refunded, attributes: nextAttributes };
    }

    /**
     * 在回收结果上记录重置时点（供冷却判定），调用方负责落库
     * @param {Object} resetPlan - buildAllocatedPointsReset 的返回值
     * @returns {Object} 带 last_attribute_reset_time 的 attributes
     */
    buildAttributesAfterReset(resetPlan) {
        return {
            ...(resetPlan?.attributes || {}),
            last_attribute_reset_time: new Date().toISOString()
        };
    }

    /**
     * 获取属性介绍（文案与图标全部取自注册表定义）
     * @param {string} attributeName - 属性名称
     * @returns {Object} 属性介绍
     */
    getAttributeDescription(attributeName) {
        const def = this.registry.get(attributeName);
        return {
            name: attributeName,
            description: def?.description || '未知属性',
            icon: def?.icon || '📊'
        };
    }

    /**
     * 获取属性图标
     * @param {string} attributeName - 属性名称
     * @returns {string} 图标标识
     */
    getAttributeIcon(attributeName) {
        return this.registry.get(attributeName)?.icon || '📊';
    }

    /** 属性面板字段定义（前端按此渲染，不再各自硬编码标签） */
    getPanelSchema() {
        return this.registry.panelStats();
    }
}

module.exports = new AttributeService();
