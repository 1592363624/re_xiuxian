/**
 * 功法服务模块
 *
 * 处理功法系统的全部业务逻辑：习得、修炼、层数突破、神通领悟、装备切换、属性加成聚合。
 *
 * 设计说明：
 *   - 所有数值（品阶系数、突破概率、消耗、冷却、五行相克表等）均从 technique_data.json 读取，
 *     禁止在本文件中硬编码魔法数字，便于策划调参与热更新。
 *   - 玩家侧动态数据存于 player_techniques 表（PlayerTechnique 模型），静态数据全部走配置。
 *   - 所有涉及灵石/熟练度/层数变更的写操作均使用事务 + 行级锁（FOR UPDATE），保证并发安全。
 *   - getTechniqueBonus() 供 AttributeService 调用，替换原先的硬编码占位实现。
 *   - 悟性说明：player 表无独立"悟性"字段，本系统采用 sense（神识）作为悟性代理属性，
 *     语义上神识强弱确实对应领悟能力，避免为此新增字段破坏既有属性体系。
 */
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const CombatResolver = require('../combat/CombatResolver');
const { resolveSpiritRoot, spiritRootTypes } = require('../stats/SpiritRoot');
const { contentList } = require('../content/ContentRegistry');
const { foldSkillStats } = require('../combat/skillEffects');
const Realm = require('../../models/realm');
const PlayerSect = require('../../models/playerSect');
const PlayerTechnique = require('../../models/playerTechnique');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { logOnce } = require('../../utils/logOnce');

// 装备槽位常量（与配置中 max_equipped_main / max_equipped_auxiliary 对应）
const SLOT_MAIN = 'main';
const SLOT_AUXILIARY = 'auxiliary';

class TechniqueService {
    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 全局配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    // ==================== 配置读取层 ====================

    /**
     * 获取功法系统完整配置
     * 说明：ConfigLoader 在配置缺失时会抛异常，此处 try/catch 兜底返回空对象，
     *       避免功法配置未加载导致整个属性计算链路崩溃（属性计算是高频核心路径）。
     * @returns {Object} 功法配置对象，加载失败时返回 {}
     */
    getConfig() {
        try {
            return this.configLoader?.getConfig('technique_data') || {};
        } catch (e) {
            logOnce('TechniqueService.getConfig', 'technique_data 配置读取失败，功法加成按"未配置"兜底（属性面板会少一整块）: ' + e.message);
            return {};
        }
    }

    /**
     * 功法系统是否启用
     * @returns {boolean}
     */
    isEnabled() {
        return this.getConfig()?.settings?.enabled === true;
    }

    /**
     * 获取全局设置节点
     */
    getSettings() {
        return this.getConfig().settings || {};
    }

    /**
     * 获取指定功法的静态配置
     * @param {string} techniqueId - 功法ID
     * @returns {Object|null} 功法配置，不存在时返回 null
     */
    getTechniqueConfig(techniqueId) {
        return this.getConfig().techniques?.[techniqueId] || null;
    }

    /**
     * 获取指定品阶的配置
     * @param {string} grade - 品阶key（huang/xuan/di/tian/shen）
     * @returns {Object|null}
     */
    getGradeConfig(grade) {
        return this.getConfig().grades?.[grade] || null;
    }

    /**
     * 获取指定神通的配置
     * @param {string} skillId - 神通ID
     * @returns {Object|null}
     */
    getSkillConfig(skillId) {
        return this.getConfig().skills?.[skillId] || null;
    }

    // ==================== 通用工具层 ====================

    /**
     * 校验功法系统是否可用，不可用时抛出业务异常
     * 说明：所有对外写接口入口统一调用，避免配置缺失时产生脏数据。
     */
    assertEnabled() {
        if (!this.isEnabled()) {
            throw new AppError('功法系统当前未开放', 403, ErrorCodes.FEATURE_DISABLED);
        }
    }

    /**
     * 获取玩家的悟性值（以神识 sense 作为代理属性）
     * 说明：attributes 是 TEXT 存储的 JSON，模型 getter 已自动反序列化。
     *       做空值兜底是因为老玩家数据可能缺失该字段。
     * @param {Object} player - 玩家实例
     * @returns {number} 悟性值，最低 0
     */
    getWisdom(player) {
        const attrs = player?.attributes || {};
        const sense = Number(attrs.sense);
        return Number.isFinite(sense) && sense > 0 ? sense : 0;
    }

    /**
     * 比较玩家境界是否达到功法要求
     * 说明：realms 表以境界名为主键、rank 为排序值。需要把"要求境界名"换算成 rank 再比较，
     *       不能直接比字符串。查不到时保守放行，避免因配置写错境界名把玩家永久卡死。
     * @param {string} playerRealm - 玩家当前境界名
     * @param {string} requiredRealm - 功法要求的境界名
     * @returns {Promise<boolean>} 是否满足要求
     */
    async isRealmSatisfied(playerRealm, requiredRealm) {
        if (!requiredRealm) return true;

        const [playerRow, requiredRow] = await Promise.all([
            Realm.findOne({ where: { name: playerRealm }, attributes: ['rank'] }),
            Realm.findOne({ where: { name: requiredRealm }, attributes: ['rank'] })
        ]);

        // 任一境界查不到则保守放行，防止配置错误导致玩家无法习得任何功法
        if (!playerRow || !requiredRow) return true;
        return playerRow.rank >= requiredRow.rank;
    }

    /**
     * 计算玩家灵根与功法五行的匹配修正系数
     *
     * 规则（数值来自 element_match 配置）：
     *   - 功法无属性（none）或玩家无灵根数据：返回 1.0（无修正）
     *   - 玩家拥有与功法同属性的灵根：加成 +match_bonus_pct%
     *   - 玩家灵根克制功法属性：衰减 -conflict_penalty_pct%
     * 这是功法选择的策略深度来源——玩家需要根据自身灵根挑功法，而非无脑选最高阶。
     *
     * 灵根一律经 SpiritRoot 归一成 role_init.spirit_roots 的 type（metal/wood/...）。
     * 旧实现直接 Object.keys(player.spirit_roots) 并要求值是正数，而真实数据是
     * { type: 'thunder' } 或 { '金灵根': {level, affinity} } 两种形状，
     * 两种都过不了 Number(...) > 0，于是 rootKeys 恒为空、这条机制恒返回 1.0——
     * 五行契合/相克从来没有生效过。
     *
     * @param {Object} player - 玩家实例
     * @param {string} element - 功法五行属性
     * @returns {number} 修正系数（如 1.2 / 1.0 / 0.85）
     */
    getElementMultiplier(player, element) {
        if (!element || element === 'none') return 1.0;

        const cfg = this.getConfig().element_match || {};
        const roots = spiritRootTypes(player, this.configLoader?.getConfig('role_init'));
        if (roots.length === 0) return 1.0;

        // 灵根属性与功法属性一致 → 契合加成（多灵根时契合优先于相冲）
        if (roots.includes(element)) {
            return 1 + (Number(cfg.match_bonus_pct) || 0) / 100;
        }

        // 玩家灵根克制功法属性 → 相冲衰减。值过 contentList：基础配置是裸数组，
        // 资料片经 map 集合加的条目是 `{id,counters:[...]}` 对象 —— 只认 Array.isArray 的话，
        // 片里那条会被静默丢掉，新灵根于是"能契合、不能相克"，而表看起来是配齐的。
        const conflicts = cfg.conflicts || {};
        for (const root of roots) {
            if (contentList(conflicts[root]).includes(element)) {
                return 1 - (Number(cfg.conflict_penalty_pct) || 0) / 100;
            }
        }

        return 1.0;
    }

    /**
     * 计算当前层突破到下一层所需的熟练度阈值
     * 公式：品阶基础熟练度 × (1 + (当前层-1) × 0.5)
     * 说明：随层数线性递增，配合品阶间的巨大基数差（100→3600），形成阶梯式成长曲线。
     * @param {string} grade - 品阶
     * @param {number} layer - 当前层数
     * @returns {number} 所需熟练度
     */
    getRequiredProficiency(grade, layer) {
        const gradeCfg = this.getGradeConfig(grade);
        if (!gradeCfg) return Infinity;
        const base = Number(gradeCfg.proficiency_per_layer) || 100;
        return Math.floor(base * (1 + (layer - 1) * 0.5));
    }

    /**
     * 计算单次修炼的灵石消耗
     * 公式：基础消耗 × (1 + 层数 × 层数增长系数) × 品阶属性系数
     * @param {string} grade - 品阶
     * @param {number} layer - 当前层数
     * @returns {number} 灵石消耗
     */
    getPracticeCost(grade, layer) {
        const p = this.getConfig().practice || {};
        const gradeCfg = this.getGradeConfig(grade) || {};
        const base = Number(p.base_spirit_stone_cost) || 0;
        const growth = Number(p.cost_growth_per_layer) || 0;
        const coef = Number(gradeCfg.attr_coefficient) || 1;
        return Math.floor(base * (1 + layer * growth) * coef);
    }

    /**
     * 单次修炼的灵力消耗 = 玩家灵力上限 × practice.mp_cost_ratio。
     *
     * 为什么要单独一个方法：功法面板的"消耗预览"（getPlayerTechniques）与实际扣蓝（practice）
     * 必须是同一个数，以前只有 practice 里一行内联写法，而面板引用的 getMpCost 根本不存在——
     * 任何一本功法在身的人打开面板就 500（owned 为空的玩家不会走到那一行，所以从未暴露）。
     * 传进来的 mpMax 也统一是解析后的完整属性（含装备/功法/灵兽），不再读 attributes 里的陈旧镜像，
     * 否则"预览按 3500 蓝算、实际按 5000 蓝算"这类对不上又会回来。
     */
    getMpCost(playerMpMax) {
        const ratio = Number(this.getConfig().practice?.mp_cost_ratio) || 0;
        return Math.floor((Number(playerMpMax) || 0) * ratio);
    }

    /**
     * 计算功法层数突破的成功率
     *
     * 公式：基础率(品阶) - 当前层数 × 层惩罚 - 瓶颈额外惩罚 + 悟性加成
     * 最终结果被 clamp 到 [min_success_rate, max_success_rate] 区间。
     *
     * 设计意图：
     *   - 层惩罚使同一本功法越练越难，形成纵向瓶颈
     *   - 品阶基础率递减（0.85→0.28）使高阶功法横向更难，两者叠加形成中后期明显卡点
     *   - 瓶颈层（3/6/9/12）额外扣减，制造阶段性关卡感
     *   - 悟性加成给属性投入提供正反馈，是玩家可主动优化的变量
     *
     * @param {string} grade - 品阶
     * @param {number} layer - 当前层数（突破的是 layer → layer+1）
     * @param {number} wisdom - 玩家悟性
     * @returns {number} 成功率（0~1）
     */
    calcBreakthroughRate(grade, layer, wisdom) {
        const bt = this.getConfig().breakthrough || {};
        const gradeCfg = this.getGradeConfig(grade) || {};

        let rate = Number(gradeCfg.breakthrough_base_rate) || 0.5;
        rate -= layer * (Number(bt.layer_penalty_per_level) || 0);

        // 目标层（layer+1）若为瓶颈层，追加惩罚
        const bottlenecks = Array.isArray(bt.bottleneck_layers) ? bt.bottleneck_layers : [];
        if (bottlenecks.includes(layer + 1)) {
            rate -= Number(bt.bottleneck_extra_penalty) || 0;
        }

        // 悟性加成
        rate += wisdom * (Number(bt.wisdom_bonus_factor) || 0);

        const min = Number(bt.min_success_rate) ?? 0.08;
        const max = Number(bt.max_success_rate) ?? 0.95;
        return Math.min(max, Math.max(min, rate));
    }

    // ==================== 查询接口 ====================

    /**
     * 获取玩家功法总览
     * 返回已习得功法（含实时计算的突破率、所需熟练度、当前加成）与可习得功法列表。
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 功法总览数据
     */
    async getPlayerTechniques(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const owned = await PlayerTechnique.findAll({
            where: { player_id: playerId },
            order: [['equip_slot', 'ASC'], ['id', 'ASC']]
        });

        const wisdom = this.getWisdom(player);
        const settings = this.getSettings();
        // Player 模型没有 mp_max 列（旧写法 player.mp_max 恒为 undefined，
        // 灵力消耗预览因此一直按兜底值显示）；上限走统一属性解析，整张列表共用一次解析结果。
        const playerMpMax = (await CombatResolver.resolveCombatStats(player)).stats.mp_max;

        // 组装已习得功法的完整视图（静态配置 + 动态进度 + 实时计算值）
        const ownedList = owned.map(row => {
            const cfg = this.getTechniqueConfig(row.technique_id);
            if (!cfg) return null; // 配置被移除的脏数据，直接过滤

            const gradeCfg = this.getGradeConfig(cfg.grade) || {};
            const isMaxLayer = row.layer >= (Number(gradeCfg.max_layer) || 9);

            return {
                technique_id: row.technique_id,
                name: cfg.name,
                grade: cfg.grade,
                grade_name: gradeCfg.name,
                grade_color: gradeCfg.color,
                element: cfg.element,
                description: cfg.description,
                layer: row.layer,
                max_layer: gradeCfg.max_layer,
                proficiency: row.proficiency,
                required_proficiency: this.getRequiredProficiency(cfg.grade, row.layer),
                equip_slot: row.equip_slot,
                comprehended_skills: row.comprehended_skills || [],
                fail_streak: row.fail_streak,
                practice_count: row.practice_count,
                daily_practice_count: this._resolveDailyCount(row),
                daily_practice_limit: settings.daily_practice_limit,
                practice_cost: this.getPracticeCost(cfg.grade, row.layer),
                // 单次修炼的灵力消耗（依赖玩家灵力上限，前端消耗预览用）
                mp_cost: this.getMpCost(playerMpMax),
                // 突破灵石消耗 = 单次修炼消耗 × 突破倍数（前端消耗预览用，避免客户端重复计算）
                breakthrough_cost: Math.round(
                    this.getPracticeCost(cfg.grade, row.layer) *
                    (Number(this.getConfig().breakthrough?.spirit_stone_cost_multiplier) || 1)
                ),
                // 领悟神通灵石消耗（前端消耗预览用）
                comprehend_cost: Number(this.getConfig().comprehension?.spirit_stone_cost) || 0,
                // 神通槽位：已用 / 上限 / 下一槽解锁的功法层数（null 表示已到最大槽位或无解锁配置）
                skill_slots_used: (row.comprehended_skills || []).length,
                skill_slots_total: this._getSkillSlots(row.layer),
                next_skill_unlock_layer: (this.getConfig().comprehension?.unlock_layers || []).find(l => l > row.layer) ?? null,
                // 已满层时突破率无意义，返回 null 让前端隐藏
                breakthrough_rate: isMaxLayer ? null : this.calcBreakthroughRate(cfg.grade, row.layer, wisdom),
                is_max_layer: isMaxLayer,
                current_bonus: this._calcSingleBonus(player, cfg, row.layer)
            };
        }).filter(Boolean);

        // 可习得功法：排除已拥有的，标注境界是否满足
        const ownedIds = new Set(owned.map(r => r.technique_id));
        const allTechniques = this.getConfig().techniques || {};
        const availableList = [];

        /**
         * 这份代价现在凑不凑得齐，由服务端一次算清再下发。
         * 以前前端自己猜键名（读 acquire.cost_spirit_stones，配置里其实叫 cost_spirit_stone），
         * 于是余额提示永远说"够"，点下去才被服务端拒 —— 契约对不上时表现是"按钮骗人"。
         * 下面只多查两趟（背包、宗门行）+ 一份内存里的物品名，绝不在循环里逐条查库。
         */
        const Item = require('../../models/item');
        const [bagRows, sectRow] = await Promise.all([
            Item.findAll({ where: { player_id: player.id }, attributes: ['item_key', 'quantity'] }),
            PlayerSect.findOne({ where: { player_id: player.id }, attributes: ['sect_id', 'contribution'] })
        ]);
        const bag = new Map(bagRows.map(r => [String(r.item_key), Number(r.quantity) || 0]));
        const itemData = this.configLoader?.getConfig?.('item_data') || {};
        const itemNames = new Map((itemData.items || []).map(i => [String(i.id), i.name]));

        for (const [id, cfg] of Object.entries(allTechniques)) {
            if (id.startsWith('_') || ownedIds.has(id)) continue;
            const gradeCfg = this.getGradeConfig(cfg.grade) || {};
            const status = this._acquireStatus(cfg, { player, bag, sectRow, itemNames });
            availableList.push({
                technique_id: id,
                name: cfg.name,
                grade: cfg.grade,
                grade_name: gradeCfg.name,
                grade_color: gradeCfg.color,
                element: cfg.element,
                description: cfg.description,
                required_realm: cfg.required_realm,
                realm_satisfied: await this.isRealmSatisfied(player.realm, cfg.required_realm),
                acquire: cfg.acquire || {},
                // 展示用快照（真正判定仍在 learnTechnique 的事务里，这里不许当成授权依据）
                acquire_ready: status.ready,
                acquire_hint: status.hint,
                bonuses: cfg.bonuses || {}
            });
        }

        // 查找当前主修功法，用于前端预览切换代价（灵石 / 熟练度衰减 / 冷却）
        const currentMainRow = owned.find(r => r.equip_slot === SLOT_MAIN) || null;
        const currentMainCfg = currentMainRow ? this.getTechniqueConfig(currentMainRow.technique_id) : null;
        const currentMain = currentMainRow && currentMainCfg ? {
            technique_id: currentMainRow.technique_id,
            name: currentMainCfg.name,
            proficiency: currentMainRow.proficiency,
            updated_at: currentMainRow.updated_at
        } : null;

        return {
            enabled: this.isEnabled(),
            settings: {
                max_equipped_main: settings.max_equipped_main,
                max_equipped_auxiliary: settings.max_equipped_auxiliary,
                daily_practice_limit: settings.daily_practice_limit,
                practice_cooldown_seconds: settings.practice_cooldown_seconds,
                // 主修切换代价相关配置（前端预览用）
                switch_main_cost_spirit_stone: Number(settings.switch_main_cost_spirit_stone) || 0,
                proficiency_decay_on_switch_pct: Number(settings.proficiency_decay_on_switch_pct) || 0,
                switch_main_cooldown_hours: Number(settings.switch_main_cooldown_hours) || 0
            },
            // 当前主修（无则 null），供前端计算切换预览与冷却剩余时间
            current_main: currentMain,
            owned: ownedList,
            available: availableList,
            wisdom
        };
    }

    /**
     * 解析记录的今日修炼次数（跨天自动视为 0）
     * 说明：不在读接口里写库，只做展示层换算；真正的重置在修炼时落库。
     * @param {Object} row - PlayerTechnique 记录
     * @returns {number} 今日已修炼次数
     */
    _resolveDailyCount(row) {
        const today = new Date().toISOString().slice(0, 10);
        const rowDate = row.daily_practice_date
            ? new Date(row.daily_practice_date).toISOString().slice(0, 10)
            : null;
        return rowDate === today ? row.daily_practice_count : 0;
    }

    /**
     * 计算单本功法在指定层数下提供的属性加成
     * 公式：每层加成 × 层数 × 品阶系数 × 五行匹配系数
     * @param {Object} player - 玩家实例（用于五行匹配判断）
     * @param {Object} cfg - 功法静态配置
     * @param {number} layer - 功法层数
     * @returns {Object} 属性加成对象
     */
    _calcSingleBonus(player, cfg, layer) {
        const gradeCfg = this.getGradeConfig(cfg.grade) || {};
        const coef = Number(gradeCfg.attr_coefficient) || 1;
        const elementMul = this.getElementMultiplier(player, cfg.element);
        const bonuses = cfg.bonuses || {};

        const result = {};
        for (const [key, value] of Object.entries(bonuses)) {
            // 注意：负值加成（如血魔炼形诀的 hp_max: -40）必须保留符号，
            // 用 Math.round 而非 Math.floor，避免负数向下取整放大惩罚
            result[key] = Math.round(Number(value) * layer * coef * elementMul);
        }
        return result;
    }

    /**
     * 展示用的"这份代价现在凑不凑得齐"。
     *
     * 与 learnTechnique 的强制校验同源同口径，但**只是列表打开那一刻的快照**：判定仍在习得事务里做，
     * 这里绝不许被当成授权依据。它存在的全部意义是别让玩家点一个必然被拒的按钮。
     * 只读调用方查好的三份数据（灵石在 player 上、背包 bag、宗门行 sectRow），不再查库。
     */
    _acquireStatus(cfg, { player, bag, sectRow, itemNames }) {
        const acquire = cfg.acquire || {};
        const stones = Number(player?.spirit_stones) || 0;
        const scrollName = id => itemNames?.get(String(id)) || String(id);
        switch (String(acquire.source ?? 'default')) {
            case 'shop': {
                const cost = Number(acquire.cost_spirit_stone) || 0;
                return { ready: stones >= cost, hint: `${cost} 灵石` };
            }
            case 'sect': {
                const need = Number(acquire.sect_contribution) || 0;
                if (acquire.sect_id && String(sectRow?.sect_id || '') !== String(acquire.sect_id)) {
                    return { ready: false, hint: `需入指定宗门，另需 ${need} 贡献` };
                }
                return { ready: Number(sectRow?.contribution || 0) >= need, hint: `${need} 宗门贡献` };
            }
            case 'recipe_scroll': {
                const key = String(acquire.item_id || '');
                return { ready: (bag?.get(key) || 0) >= 1, hint: `消耗《${scrollName(key)}》×1` };
            }
            case 'secret_realm':
                return { ready: false, hint: '秘境奇遇所得，无法主动研习' };
            default:
                return { ready: true, hint: '新手指引' };
        }
    }

    // ==================== 习得功法 ====================

    /**
     * 习得功法
     *
     * 校验链：系统开关 → 功法存在 → 未重复习得 → 境界达标 → 获取途径与代价满足。
     * 代价按 acquire.source 分支处理：
     *   - default：新手默认功法，免费
     *   - shop：消耗灵石
     *   - sect：消耗宗门贡献（若限定宗门还需校验所属宗门）
     *   - recipe_scroll：消耗背包里那卷残卷（功法侧 acquire.item_id 是权威，
     *     物品侧 effect.learn_technique 回指这部功法，两头由内容层启动期闸强制对上）
     *   - secret_realm：不可主动习得，只能秘境掉落（由掉落逻辑调用 grantTechnique）
     *
     * 这份清单同时抄在 ContentRegistry._validateTechniqueAcquire 的 SUPPORTED 表里：
     * 以前这里只认 shop/sect，资料片写的 recipe_scroll / sect_treasury 全都落到"什么都不扣"，
     * 于是境界够就能白嫖一部功法、而那张贵价残卷又谁都消化不掉。加新分支时两处一起改。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @returns {Promise<Object>} 习得结果
     */
    async learnTechnique(playerId, techniqueId) {
        this.assertEnabled();

        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) {
            throw new AppError('功法不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const acquire = cfg.acquire || {};
        // 秘境功法不允许通过接口直接习得，必须走掉落流程，防止绕过稀有度设计
        if (acquire.source === 'secret_realm') {
            throw new AppError('该功法为秘境奇遇所得，无法直接研习', 403, ErrorCodes.CONDITION_NOT_MET);
        }

        return await sequelize.transaction(async (t) => {
            // 行级锁锁定玩家行，防止并发习得导致灵石/贡献被重复扣除
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const exists = await PlayerTechnique.findOne({
                where: { player_id: playerId, technique_id: techniqueId },
                transaction: t
            });
            if (exists) {
                throw new AppError('已习得该功法', 400, ErrorCodes.ALREADY_EXISTS);
            }

            if (!(await this.isRealmSatisfied(player.realm, cfg.required_realm))) {
                throw new AppError(`境界不足，需达到${cfg.required_realm}`, 400, ErrorCodes.REALM_NOT_ENOUGH);
            }

            let costDesc = '无';

            if (acquire.source === 'shop') {
                const cost = Number(acquire.cost_spirit_stone) || 0;
                if (Number(player.spirit_stones) < cost) {
                    throw new AppError(`灵石不足，需要 ${cost}`, 400, ErrorCodes.INSUFFICIENT_RESOURCES);
                }
                player.spirit_stones = Number(player.spirit_stones) - cost;
                await player.save({ transaction: t });
                costDesc = `${cost} 灵石`;
            } else if (acquire.source === 'sect') {
                // 宗门功法：直接操作 PlayerSect 模型扣减贡献度
                // 说明：SectService 未暴露通用的"扣贡献"方法（其兑换逻辑内联在 exchangeTreasure 中），
                //       此处复用同一模型并纳入当前事务，与 SectService 的写法保持一致。
                const need = Number(acquire.sect_contribution) || 0;
                const playerSect = await PlayerSect.findOne({
                    where: { player_id: playerId },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });

                if (!playerSect || !playerSect.sect_id) {
                    throw new AppError('尚未加入宗门，无法研习宗门功法', 400, ErrorCodes.CONDITION_NOT_MET);
                }
                // 限定宗门的功法需校验所属（如血魔炼形诀限阴罗宗）
                if (acquire.sect_id && String(playerSect.sect_id) !== String(acquire.sect_id)) {
                    throw new AppError('本门无此功法传承', 403, ErrorCodes.CONDITION_NOT_MET);
                }
                if (Number(playerSect.contribution) < need) {
                    throw new AppError(
                        `宗门贡献不足，需要 ${need}，当前 ${playerSect.contribution}`,
                        400,
                        ErrorCodes.INSUFFICIENT_RESOURCES
                    );
                }

                playerSect.contribution = Number(playerSect.contribution) - need;
                await playerSect.save({ transaction: t });
                costDesc = `${need} 宗门贡献`;
            } else if (acquire.source === 'recipe_scroll') {
                // 残卷：代价是一件物品，消耗走 CraftingService.learnRecipe 同一套写法
                // （同一事务里 hasItem → removeItem，玩家行在函数开头已经 FOR UPDATE 锁过，
                //  所以"双击同时交两卷"只会成功一次；事务回滚时残卷跟着回来，不会白吞。）
                const InventoryService = require('./InventoryService');   // 延迟 require：背包侧也引用本服务
                const itemKey = String(acquire.item_id || '');
                const items = (this.configLoader?.getConfig('item_data') || {}).items || [];
                const scroll = items.find(i => String(i.id) === itemKey);
                if (!scroll || scroll.type !== 'recipe_scroll') {
                    throw new AppError(`功法配置的残卷 ${itemKey || '(未填)'} 不是一件可研习的卷轴`, 500, ErrorCodes.INTERNAL_ERROR);
                }
                if (!(await InventoryService.hasItem(playerId, itemKey, 1, t))) {
                    throw new AppError(`缺少《${scroll.name}》，此法非卷不传`, 400, ErrorCodes.CONDITION_NOT_MET);
                }
                if (!(await InventoryService.removeItem(playerId, itemKey, 1, t))) {
                    throw new AppError('残卷消耗失败', 500, ErrorCodes.INTERNAL_ERROR);
                }
                costDesc = `${scroll.name} ×1`;
            }

            const record = await PlayerTechnique.create({
                player_id: playerId,
                technique_id: techniqueId,
                layer: 1,
                proficiency: 0,
                equip_slot: null,
                comprehended_skills: [],
                fail_streak: 0,
                acquired_at: new Date()
            }, { transaction: t });

            return {
                success: true,
                message: `成功研习《${cfg.name}》`,
                cost: costDesc,
                technique: { technique_id: techniqueId, name: cfg.name, layer: record.layer }
            };
        });
    }

    /**
     * 直接授予功法（不校验代价，供秘境掉落 / GM / 活动奖励调用）
     * 说明：已拥有时静默返回 granted=false，不抛异常——掉落逻辑不应因重复而中断整个结算。
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @param {Object} transaction - 外部事务（可选）
     * @returns {Promise<Object>} { granted, technique_id, name }
     */
    async grantTechnique(playerId, techniqueId, transaction = null) {
        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) return { granted: false, reason: 'not_found' };

        const opts = transaction ? { transaction } : {};
        const exists = await PlayerTechnique.findOne({
            where: { player_id: playerId, technique_id: techniqueId },
            ...opts
        });
        if (exists) return { granted: false, reason: 'already_owned', name: cfg.name };

        await PlayerTechnique.create({
            player_id: playerId,
            technique_id: techniqueId,
            layer: 1,
            proficiency: 0,
            comprehended_skills: [],
            acquired_at: new Date()
        }, opts);

        return { granted: true, technique_id: techniqueId, name: cfg.name };
    }

    // ==================== 修炼功法 ====================

    /**
     * 修炼功法（提升熟练度）
     *
     * 校验链：冷却 → 每日次数上限 → 灵石充足 → 灵力充足。
     * 产出：熟练度（含随机浮动与悟性加成）+ 修为。
     *
     * 并发安全：对玩家行与功法行同时加锁，防止双开刷取。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @returns {Promise<Object>} 修炼结果
     */
    async practice(playerId, techniqueId) {
        this.assertEnabled();

        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) {
            throw new AppError('功法不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const settings = this.getSettings();
        const p = this.getConfig().practice || {};

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const record = await PlayerTechnique.findOne({
                where: { player_id: playerId, technique_id: techniqueId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!record) {
                throw new AppError('尚未习得该功法', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            // —— 冷却校验 ——
            const cooldownSec = Number(settings.practice_cooldown_seconds) || 0;
            if (record.last_practice_at && cooldownSec > 0) {
                const elapsed = (Date.now() - new Date(record.last_practice_at).getTime()) / 1000;
                if (elapsed < cooldownSec) {
                    throw new AppError(
                        `功法运转未息，请等待 ${Math.ceil(cooldownSec - elapsed)} 秒`,
                        400,
                        ErrorCodes.COOLDOWN
                    );
                }
            }

            // —— 每日次数校验（跨天在此处落库重置）——
            const today = new Date().toISOString().slice(0, 10);
            const rowDate = record.daily_practice_date
                ? new Date(record.daily_practice_date).toISOString().slice(0, 10)
                : null;
            let dailyCount = rowDate === today ? record.daily_practice_count : 0;

            const dailyLimit = Number(settings.daily_practice_limit) || 0;
            if (dailyLimit > 0 && dailyCount >= dailyLimit) {
                throw new AppError('今日修炼次数已达上限，明日再来', 400, ErrorCodes.LIMIT_EXCEEDED);
            }

            // —— 灵石消耗校验 ——
            const cost = this.getPracticeCost(cfg.grade, record.layer);
            if (Number(player.spirit_stones) < cost) {
                throw new AppError(`灵石不足，需要 ${cost}`, 400, ErrorCodes.INSUFFICIENT_RESOURCES);
            }

            // —— 灵力消耗校验 ——（与面板预览同一个算法：解析后的 mp_max × practice.mp_cost_ratio，
            // 不再读 attributes.mp_max 那份陈旧镜像，否则"预览说 525、实际按 75 判定"又会出现）
            const attrs = player.attributes || {};
            const { stats: practiceStats } = await CombatResolver.resolveCombatStats(player);
            const mpCost = this.getMpCost(practiceStats.mp_max);
            const mpCurrent = Number(player.mp_current ?? attrs.mp_current) || 0;
            if (mpCost > 0 && mpCurrent < mpCost) {
                throw new AppError(`灵力不足，需要 ${mpCost}`, 400, ErrorCodes.INSUFFICIENT_RESOURCES);
            }

            // —— 计算熟练度收益 ——
            const wisdom = this.getWisdom(player);
            const baseGain = Number(p.base_proficiency_gain) || 0;
            const variance = Number(p.proficiency_gain_variance) || 0;
            // 随机浮动：期望值仍为 1.0，只增加单次体验的随机性，不影响长期收益
            const randomFactor = 1 + (Math.random() * 2 - 1) * variance;
            const wisdomFactor = 1 + wisdom * (Number(p.comprehension_bonus_per_wisdom) || 0);
            const gain = Math.max(1, Math.floor(baseGain * randomFactor * wisdomFactor));

            // —— 计算修为收益（与品阶挂钩，高阶功法修炼更快）——
            const gradeCfg = this.getGradeConfig(cfg.grade) || {};
            const expGain = Math.floor(
                gain * (Number(p.exp_reward_ratio) || 0) * (Number(gradeCfg.attr_coefficient) || 1)
            );

            // —— 落库 ——
            player.spirit_stones = Number(player.spirit_stones) - cost;
            if (mpCost > 0) {
                player.mp_current = mpCurrent - mpCost;
            }
            player.exp = Number(player.exp) + expGain;
            await player.save({ transaction: t });

            record.proficiency += gain;
            record.practice_count += 1;
            record.daily_practice_count = dailyCount + 1;
            record.daily_practice_date = today;
            record.last_practice_at = new Date();
            await record.save({ transaction: t });

            const required = this.getRequiredProficiency(cfg.grade, record.layer);

            return {
                success: true,
                message: `运转《${cfg.name}》，熟练度 +${gain}`,
                proficiency_gain: gain,
                exp_gain: expGain,
                spirit_stone_cost: cost,
                mp_cost: mpCost,
                proficiency: record.proficiency,
                required_proficiency: required,
                can_breakthrough: record.proficiency >= required,
                daily_practice_count: record.daily_practice_count,
                daily_practice_limit: dailyLimit
            };
        });
    }

    // ==================== 层数突破 ====================

    /**
     * 突破功法层数
     *
     * 校验链：已习得 → 未满层 → 熟练度达标 → 灵石充足。
     * 结算：按 calcBreakthroughRate 判定；连续失败达 failure_protection_count 时触发保底必成。
     *   - 成功：层数 +1，熟练度清零，失败计数清零
     *   - 失败：熟练度按 failure_proficiency_loss_pct 扣减，失败计数 +1
     *
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @returns {Promise<Object>} 突破结果
     */
    async breakthrough(playerId, techniqueId) {
        this.assertEnabled();

        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) {
            throw new AppError('功法不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const bt = this.getConfig().breakthrough || {};
        const gradeCfg = this.getGradeConfig(cfg.grade) || {};

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const record = await PlayerTechnique.findOne({
                where: { player_id: playerId, technique_id: techniqueId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!record) {
                throw new AppError('尚未习得该功法', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            const maxLayer = Number(gradeCfg.max_layer) || 9;
            if (record.layer >= maxLayer) {
                throw new AppError('该功法已臻圆满，无法再进', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            const required = this.getRequiredProficiency(cfg.grade, record.layer);
            if (record.proficiency < required) {
                throw new AppError(
                    `熟练度不足，需要 ${required}，当前 ${record.proficiency}`,
                    400,
                    ErrorCodes.CONDITION_NOT_MET
                );
            }

            // 突破消耗 = 单次修炼消耗 × 倍数
            const cost = this.getPracticeCost(cfg.grade, record.layer)
                * (Number(bt.spirit_stone_cost_multiplier) || 1);
            if (Number(player.spirit_stones) < cost) {
                throw new AppError(`灵石不足，需要 ${cost}`, 400, ErrorCodes.INSUFFICIENT_RESOURCES);
            }

            player.spirit_stones = Number(player.spirit_stones) - cost;
            await player.save({ transaction: t });

            // —— 成功判定 ——
            const wisdom = this.getWisdom(player);
            const rate = this.calcBreakthroughRate(cfg.grade, record.layer, wisdom);
            const protectionCount = Number(bt.failure_protection_count) || 0;
            // 保底机制：连续失败达阈值时必定成功，防止极端非酋永久卡死
            const isProtected = protectionCount > 0 && record.fail_streak >= protectionCount;
            const success = isProtected || Math.random() < rate;

            let message;
            if (success) {
                record.layer += 1;
                record.proficiency = 0;
                record.fail_streak = 0;
                message = isProtected
                    ? `水到渠成！《${cfg.name}》突破至第 ${record.layer} 层（保底触发）`
                    : `突破成功！《${cfg.name}》臻至第 ${record.layer} 层`;
            } else {
                const lossPct = Number(bt.failure_proficiency_loss_pct) || 0;
                const loss = Math.floor(record.proficiency * lossPct / 100);
                record.proficiency = Math.max(0, record.proficiency - loss);
                record.fail_streak += 1;
                message = `突破失败，气息紊乱，熟练度损失 ${loss}`;
            }
            await record.save({ transaction: t });

            const nextRequired = this.getRequiredProficiency(cfg.grade, record.layer);

            return {
                success: true,
                breakthrough_success: success,
                protected: isProtected,
                message,
                rate: Number(rate.toFixed(4)),
                layer: record.layer,
                max_layer: maxLayer,
                proficiency: record.proficiency,
                required_proficiency: nextRequired,
                fail_streak: record.fail_streak,
                spirit_stone_cost: cost,
                // 达到解锁层时提示玩家可领悟神通，缩短操作路径
                can_comprehend: success && this._isComprehendUnlockLayer(record.layer)
            };
        });
    }

    /**
     * 判断指定层数是否为神通解锁层
     * @param {number} layer - 层数
     * @returns {boolean}
     */
    _isComprehendUnlockLayer(layer) {
        const c = this.getConfig().comprehension || {};
        const layers = Array.isArray(c.unlock_layers) ? c.unlock_layers : [];
        return layers.includes(layer);
    }

    /**
     * 计算当前层数下可拥有的神通槽位数量
     * 说明：每越过一个 unlock_layer 解锁一个槽位。
     * @param {number} layer - 当前层数
     * @returns {number} 槽位数
     */
    _getSkillSlots(layer) {
        const c = this.getConfig().comprehension || {};
        const layers = Array.isArray(c.unlock_layers) ? c.unlock_layers : [];
        return layers.filter(l => layer >= l).length;
    }

    // ==================== 神通领悟 ====================

    /**
     * 领悟功法神通
     *
     * 校验链：领悟开关 → 已习得 → 有空余槽位 → 冷却结束 → 灵石充足 → 有可领悟神通。
     * 候选池：优先与功法五行一致的神通，其次为无属性（none）通用神通。
     * 判定失败仍扣灵石与冷却，体现"顿悟需机缘"的设定。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @returns {Promise<Object>} 领悟结果
     */
    async comprehend(playerId, techniqueId) {
        this.assertEnabled();

        const c = this.getConfig().comprehension || {};
        if (c.enabled !== true) {
            throw new AppError('神通领悟当前未开放', 403, ErrorCodes.FEATURE_DISABLED);
        }

        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) {
            throw new AppError('功法不存在', 404, ErrorCodes.NOT_FOUND);
        }

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const record = await PlayerTechnique.findOne({
                where: { player_id: playerId, technique_id: techniqueId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!record) {
                throw new AppError('尚未习得该功法', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            // —— 槽位校验 ——
            const owned = Array.isArray(record.comprehended_skills) ? record.comprehended_skills : [];
            const slots = this._getSkillSlots(record.layer);
            if (owned.length >= slots) {
                const nextLayer = (c.unlock_layers || []).find(l => l > record.layer);
                throw new AppError(
                    nextLayer
                        ? `神通槽位已满（${owned.length}/${slots}），需将功法修至第 ${nextLayer} 层方可再悟`
                        : `神通槽位已满（${owned.length}/${slots}）`,
                    400,
                    ErrorCodes.LIMIT_EXCEEDED
                );
            }

            // —— 冷却校验 ——
            const cdHours = Number(c.cooldown_hours) || 0;
            if (record.last_comprehend_at && cdHours > 0) {
                const elapsedH = (Date.now() - new Date(record.last_comprehend_at).getTime()) / 3600000;
                if (elapsedH < cdHours) {
                    throw new AppError(
                        `心神未复，需静养 ${Math.ceil(cdHours - elapsedH)} 小时`,
                        400,
                        ErrorCodes.COOLDOWN
                    );
                }
            }

            // —— 灵石校验 ——
            const cost = Number(c.spirit_stone_cost) || 0;
            if (Number(player.spirit_stones) < cost) {
                throw new AppError(`灵石不足，需要 ${cost}`, 400, ErrorCodes.INSUFFICIENT_RESOURCES);
            }

            // —— 候选神通池：同五行优先，其次通用 ——
            const allSkills = this.getConfig().skills || {};
            const candidates = Object.keys(allSkills).filter(id => {
                if (id.startsWith('_') || owned.includes(id)) return false;
                const s = allSkills[id];
                return s.element === cfg.element || s.element === 'none';
            });

            if (candidates.length === 0) {
                throw new AppError('此功法已无神通可悟', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            player.spirit_stones = Number(player.spirit_stones) - cost;
            await player.save({ transaction: t });

            // —— 领悟判定 ——
            const wisdom = this.getWisdom(player);
            const rate = Math.min(0.95,
                (Number(c.base_comprehend_rate) || 0) + wisdom * (Number(c.wisdom_bonus_factor) || 0)
            );
            const success = Math.random() < rate;

            record.last_comprehend_at = new Date();
            let gainedSkill = null;

            if (success) {
                // 从候选池随机选取一个神通
                const picked = candidates[Math.floor(Math.random() * candidates.length)];
                // 注意：JSON 字段必须整体重新赋值，直接 push 不会被 Sequelize 识别为变更
                record.comprehended_skills = [...owned, picked];
                gainedSkill = {
                    id: picked,
                    name: allSkills[picked].name,
                    description: allSkills[picked].description,
                    effects: allSkills[picked].effects
                };
            }
            await record.save({ transaction: t });

            return {
                success: true,
                comprehend_success: success,
                message: success
                    ? `顿悟！领悟神通【${gainedSkill.name}】`
                    : '冥思良久，未得其法',
                rate: Number(rate.toFixed(4)),
                skill: gainedSkill,
                spirit_stone_cost: cost,
                slots_used: (record.comprehended_skills || []).length,
                slots_total: slots
            };
        });
    }

    // ==================== 装备切换 ====================

    /**
     * 装备/卸下功法
     *
     * 规则：
     *   - 主修槽（main）唯一，切换需付灵石代价并使原主修熟练度衰减，且有冷却
     *   - 辅修槽（auxiliary）数量由配置决定，切换无代价
     *   - slot 传 null 表示卸下
     *
     * @param {number} playerId - 玩家ID
     * @param {string} techniqueId - 功法ID
     * @param {string|null} slot - 目标槽位（main / auxiliary / null）
     * @returns {Promise<Object>} 装备结果
     */
    async equipTechnique(playerId, techniqueId, slot) {
        this.assertEnabled();

        if (slot !== null && slot !== SLOT_MAIN && slot !== SLOT_AUXILIARY) {
            throw new AppError('无效的槽位类型', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const cfg = this.getTechniqueConfig(techniqueId);
        if (!cfg) {
            throw new AppError('功法不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const settings = this.getSettings();

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const record = await PlayerTechnique.findOne({
                where: { player_id: playerId, technique_id: techniqueId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!record) {
                throw new AppError('尚未习得该功法', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            // —— 卸下 ——
            if (slot === null) {
                record.equip_slot = null;
                await record.save({ transaction: t });
                return { success: true, message: `已收起《${cfg.name}》`, equip_slot: null };
            }

            if (record.equip_slot === slot) {
                throw new AppError('该功法已在此槽位', 400, ErrorCodes.ALREADY_EXISTS);
            }

            let costDesc = '无';

            if (slot === SLOT_MAIN) {
                // 查找当前主修
                const currentMain = await PlayerTechnique.findOne({
                    where: { player_id: playerId, equip_slot: SLOT_MAIN },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });

                // 已有主修时，切换需付代价（改修换脉的成本）
                if (currentMain && currentMain.technique_id !== techniqueId) {
                    const switchCost = Number(settings.switch_main_cost_spirit_stone) || 0;
                    if (Number(player.spirit_stones) < switchCost) {
                        throw new AppError(
                            `改修主功法需 ${switchCost} 灵石`,
                            400,
                            ErrorCodes.INSUFFICIENT_RESOURCES
                        );
                    }

                    // 冷却校验：以原主修的 updated_at 作为上次切换时间近似
                    const cdHours = Number(settings.switch_main_cooldown_hours) || 0;
                    if (cdHours > 0 && currentMain.updated_at) {
                        const elapsedH = (Date.now() - new Date(currentMain.updated_at).getTime()) / 3600000;
                        if (elapsedH < cdHours) {
                            throw new AppError(
                                `道基未稳，需 ${Math.ceil(cdHours - elapsedH)} 小时后方可改修`,
                                400,
                                ErrorCodes.COOLDOWN
                            );
                        }
                    }

                    player.spirit_stones = Number(player.spirit_stones) - switchCost;
                    await player.save({ transaction: t });

                    // 原主修熟练度衰减，防止玩家反复横跳白嫖不同功法加成
                    const decayPct = Number(settings.proficiency_decay_on_switch_pct) || 0;
                    const decay = Math.floor(currentMain.proficiency * decayPct / 100);
                    currentMain.proficiency = Math.max(0, currentMain.proficiency - decay);
                    currentMain.equip_slot = null;
                    await currentMain.save({ transaction: t });

                    costDesc = `${switchCost} 灵石，原功法熟练度 -${decay}`;
                }
            } else {
                // 辅修槽数量校验
                const auxCount = await PlayerTechnique.count({
                    where: { player_id: playerId, equip_slot: SLOT_AUXILIARY },
                    transaction: t
                });
                const maxAux = Number(settings.max_equipped_auxiliary) || 0;
                if (auxCount >= maxAux) {
                    throw new AppError(
                        `辅修功法最多装备 ${maxAux} 本，请先收起其一`,
                        400,
                        ErrorCodes.LIMIT_EXCEEDED
                    );
                }
            }

            record.equip_slot = slot;
            await record.save({ transaction: t });

            return {
                success: true,
                message: `《${cfg.name}》已设为${slot === SLOT_MAIN ? '主修' : '辅修'}功法`,
                equip_slot: slot,
                cost: costDesc
            };
        });
    }

    // ==================== 属性加成聚合（供 AttributeService 调用）====================

    /**
     * 获取玩家已装备功法提供的属性加成总和
     *
     * 这是替换 AttributeService 中硬编码占位实现的核心方法。
     * 聚合规则：遍历所有已装备（main + auxiliary）功法，累加各自的
     *   「每层加成 × 层数 × 品阶系数 × 五行匹配系数」。
     * 辅修功法按 auxiliary_ratio 打折，保证主修的核心地位。
     *
     * 容错：任何异常都返回全零加成而非抛出——属性计算是登录/战斗的高频必经路径，
     *       功法系统的问题不应导致玩家无法进入游戏。
     *
     * @param {number} playerId - 玩家ID
     * @param {Object} playerInstance - 已加载的玩家实例（可选，避免重复查库）
     * @returns {Promise<Object>} { hp_max, mp_max, atk, def, speed, cultivate_speed_pct, skills }
     */
    async getTechniqueBonus(playerId, playerInstance = null) {
        // 全零加成模板：作为未启用/异常时的安全返回值
        const empty = {
            hp_max: 0, mp_max: 0, atk: 0, def: 0, speed: 0,
            cultivate_speed_pct: 0, skills: []
        };

        if (!this.isEnabled()) return empty;

        try {
            const player = playerInstance || await Player.findByPk(playerId);
            if (!player) return empty;

            const equipped = await PlayerTechnique.findAll({
                where: { player_id: playerId, equip_slot: [SLOT_MAIN, SLOT_AUXILIARY] }
            });
            if (equipped.length === 0) return empty;

            // 辅修功法加成折扣：主修全额，辅修按此比例计入
            const auxRatio = Number(this.getSettings().auxiliary_ratio) || 0.5;
            const result = { ...empty, skills: [] };

            for (const row of equipped) {
                const cfg = this.getTechniqueConfig(row.technique_id);
                if (!cfg) continue; // 配置已删除的脏数据跳过

                const ratio = row.equip_slot === SLOT_MAIN ? 1 : auxRatio;
                const bonus = this._calcSingleBonus(player, cfg, row.layer);

                for (const [key, value] of Object.entries(bonus)) {
                    if (result[key] === undefined) result[key] = 0;
                    result[key] += Math.round(value * ratio);
                }

                // 修炼速度加成（百分比，独立于属性加成）
                const gradeCfg = this.getGradeConfig(cfg.grade) || {};
                const speedPct = (Number(cfg.cultivate_speed_pct_per_layer) || 0)
                    * row.layer * (Number(gradeCfg.attr_coefficient) || 1) * ratio;
                result.cultivate_speed_pct += speedPct;

                // 汇总已领悟神通，供战斗系统读取效果
                for (const skillId of (row.comprehended_skills || [])) {
                    const skillCfg = this.getSkillConfig(skillId);
                    if (skillCfg) {
                        const skill = {
                            id: skillId,
                            name: skillCfg.name,
                            effects: skillCfg.effects || {},
                            // 声明这条神通打的是哪一种伤害档位；战斗侧据此选 profile，
                            // 没有声明就沿用默认的 player_skill
                            damage_profile: skillCfg.damage_profile || null,
                            from: cfg.name
                        };
                        result.skills.push(skill);
                        // 属性类特效（暴击/暴伤/吸血/防%/修炼速度/突破加成）折进本来源的数值产出，
                        // 于是面板、战力、战斗、突破预览四个消费点同时看到它，不用各自再接一遍
                        foldSkillStats([skill], result);
                    }
                }
            }

            result.cultivate_speed_pct = Number(result.cultivate_speed_pct.toFixed(2));
            return result;
        } catch (e) {
            // 属性计算是核心链路，功法异常时降级为无加成而非阻断
            console.warn('[TechniqueService] 计算功法加成失败，已降级为无加成:', e.message);
            return empty;
        }
    }
}

module.exports = new TechniqueService();
