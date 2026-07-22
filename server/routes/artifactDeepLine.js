/**
 * 法宝深线路由（玩法文档第19节）
 *
 * 提供法宝深线系统的 HTTP 接口，当前实现血魔剑残契线 + 虚天鼎/乾蓝冰焰线 + 掌天瓶线：
 *   血魔剑残契线（6 接口）：
 *   - GET  /api/artifact-deep-line/blood-sword/status   获取血魔剑残契状态
 *   - POST /api/artifact-deep-line/blood-sword/sacrifice 祭血推进血契阶数
 *   - POST /api/artifact-deep-line/blood-sword/suppress  镇契（降魔染提镇契）
 *   - POST /api/artifact-deep-line/blood-sword/thunder-wash 雷洗（天雷竹/金雷竹）
 *   - POST /api/artifact-deep-line/blood-sword/imprint    铭印（血契/镇契）
 *   - POST /api/artifact-deep-line/blood-sword/sheath     封鞘（24h）
 *
 *   虚天鼎/乾蓝冰焰线（4 接口）：
 *   - GET  /api/artifact-deep-line/xutian-cauldron/status     获取鼎焰状态
 *   - POST /api/artifact-deep-line/xutian-cauldron/advance    通宝推进本体（消耗神识+灵石+寒晶/火精）
 *   - POST /api/artifact-deep-line/xutian-cauldron/refine-flame 炼焰抽离/推进乾蓝冰焰
 *   - POST /api/artifact-deep-line/xutian-cauldron/polarize    化极进阶（紫罗极火/乾蓝冰焰强化，不可逆）
 *
 *   掌天瓶线（9 接口）：
 *   - GET  /api/artifact-deep-line/sky-bottle/status          获取掌天瓶状态（绿液/冷却/材料线成长度）
 *   - POST /api/artifact-deep-line/sky-bottle/condense        凝液聚集绿液（6h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/alchemy         炼丹（稳/变两种模式，2h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/garden          药园施术（需黄枫谷，12h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/star-platform   星台施术（需星宫，12h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/nurture-bamboo  养竹（4h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/transform-bamboo 化竹（需成长度≥100，4h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/nurture-wood    养木（24h冷却）
 *   - POST /api/artifact-deep-line/sky-bottle/nurture-tree    养树（48h冷却）
 *
 * 设计原则：
 *   - 路由层仅做参数校验和响应封装，业务逻辑全部下沉到 ArtifactDeepLineService
 *   - 所有写操作必须经过 auth 中间件鉴权
 *   - 响应统一格式：{ code: 200, ...result } 或 { code: 4xx/5xx, error_code, message }
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 * @updated 2026-07-22 新增虚天鼎/乾蓝冰焰线 4 接口 + 掌天瓶线 9 接口
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 合法铭印类型白名单（防止注入）
const VALID_IMPRINT_TYPES = ['blood', 'suppress'];

// 合法雷洗材料类型白名单
const VALID_THUNDER_WASH_TYPES = ['tianlei', 'jinlei'];

/**
 * 获取血魔剑残契状态
 * GET /api/artifact-deep-line/blood-sword/status
 *
 * 响应：
 *   - 已装备血魔剑：返回完整状态快照（血契阶数/魔染/镇契/铭印/封鞘/冷却/战力加成）
 *   - 未装备血魔剑：返回 has_blood_sword=false + 获取途径提示
 */
router.get('/blood-sword/status', auth, async (req, res, next) => {
    try {
        const data = await ArtifactDeepLineService.getBloodSwordStatus(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 祭血推进血契阶数
 * POST /api/artifact-deep-line/blood-sword/sacrifice
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗当前阶数→下一阶数所需材料
 *   - 推进血契阶数 +1
 *   - 随机增加魔染（按阶段配置 8~14 等）
 *   - 累加本周血契进度（每周上限 36）
 *   - 18h 冷却
 */
router.post('/blood-sword/sacrifice', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.bloodSacrifice(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 镇契降低魔染、提高镇契值
 * POST /api/artifact-deep-line/blood-sword/suppress
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗素女禁纹×1 + 掩月镜砂×1
 *   - 降低魔染 5~10，提高镇契 5~10
 *   - 无冷却，但魔染为 0 时不可镇契
 */
router.post('/blood-sword/suppress', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.suppressBloodSword(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 雷洗强力降魔染
 * POST /api/artifact-deep-line/blood-sword/thunder-wash
 * body: { material_type: 'tianlei' | 'jinlei' }
 *
 * 业务效果：
 *   - tianlei 用天雷竹：降魔染 20~30
 *   - jinlei 用金雷竹：降魔染 35~50
 *   - 同时小幅提升镇契 2~5
 *   - 24h 冷却
 */
router.post('/blood-sword/thunder-wash', auth, async (req, res, next) => {
    try {
        const { material_type: materialType } = req.body || {};
        // 参数校验：material_type 必填且必须在白名单内
        if (!materialType) {
            throw new AppError('材料类型 material_type 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!VALID_THUNDER_WASH_TYPES.includes(materialType)) {
            throw new AppError('材料类型无效，应为 tianlei 或 jinlei', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await ArtifactDeepLineService.thunderWashBloodSword(req.user.id, materialType);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 铭印选择血契或镇契路线
 * POST /api/artifact-deep-line/blood-sword/imprint
 * body: { imprint_type: 'blood' | 'suppress' }
 *
 * 业务效果：
 *   - blood 血契铭印：高输出+反噬（额外暴击/暴伤/吸血）
 *   - suppress 镇契铭印：稳定无反噬（额外防御/暴击/暴伤）
 *   - 血契阶数 ≥ 1 才能铭印
 *   - 7 天冷却
 */
router.post('/blood-sword/imprint', auth, async (req, res, next) => {
    try {
        const { imprint_type: imprintType } = req.body || {};
        // 参数校验：imprint_type 必填且必须在白名单内
        if (!imprintType) {
            throw new AppError('铭印类型 imprint_type 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!VALID_IMPRINT_TYPES.includes(imprintType)) {
            throw new AppError('铭印类型无效，应为 blood 或 suppress', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await ArtifactDeepLineService.imprintBloodSword(req.user.id, imprintType);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 封鞘 24 小时
 * POST /api/artifact-deep-line/blood-sword/sheath
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 24h 内不提供战力且不可祭出
 *   - 期间不可祭血/镇契/雷洗/铭印
 *   - 到期后自动结算：魔染 -25~35，镇契 +15~25
 *   - 血契阶数 ≥ 1 才能封鞘
 */
router.post('/blood-sword/sheath', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.sheathBloodSword(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

// ==================== 虚天鼎/乾蓝冰焰线路由（玩法文档第19节） ====================

// 合法化极方向白名单（防止注入）
const VALID_POLARITY_TYPES = ['ziluo_jihuo', 'qianlan_bingyan'];

// 合法炼丹模式白名单（防止注入）
const VALID_ALCHEMY_MODES = ['stable', 'variable'];

/**
 * 获取虚天鼎/乾蓝冰焰状态
 * GET /api/artifact-deep-line/xutian-cauldron/status
 *
 * 响应：
 *   - 已装备虚天鼎：返回完整状态快照（本体阶数/灵焰阶数/化极方向/冷却/战力加成/神识）
 *   - 未装备虚天鼎：返回 has_xutian_cauldron=false + 获取途径提示
 */
router.get('/xutian-cauldron/status', auth, async (req, res, next) => {
    try {
        const data = await ArtifactDeepLineService.getXutianCauldronStatus(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 通宝推进虚天鼎本体
 * POST /api/artifact-deep-line/xutian-cauldron/advance
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗神识(100) + 灵石(10000) + 虚天寒晶/虚天火精（交替）
 *   - 推进本体阶数 +1，防御加成递增
 *   - 1-5阶 100%成功率，6-10阶递减（90%/80%/70%/60%/50%）
 *   - 失败：材料全损，不降级
 *   - 12h 冷却
 */
router.post('/xutian-cauldron/advance', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.advanceCauldron(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 炼焰：抽离/推进乾蓝冰焰
 * POST /api/artifact-deep-line/xutian-cauldron/refine-flame
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 首次：从虚天鼎抽离乾蓝冰焰（需本体≥3阶），获得灵焰物品，攻击+80
 *   - 后续：推进灵焰阶数，消耗神识(200)+灵石(50000)+乾蓝寒髓(2)
 *   - 1-5阶 100%成功率，6-10阶递减
 *   - 24h 冷却
 */
router.post('/xutian-cauldron/refine-flame', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.refineFlame(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 化极进阶灵焰
 * POST /api/artifact-deep-line/xutian-cauldron/polarize
 * body: { polarity: 'ziluo_jihuo' | 'qianlan_bingyan' }
 *
 * 业务效果：
 *   - ziluo_jihuo（紫罗极火）：攻击+50%，但每回合反噬自身气血5%（高风险高收益，不可逆）
 *   - qianlan_bingyan（乾蓝冰焰强化）：攻击+20%，无反噬（低风险低收益，不可逆）
 *   - 需乾蓝冰焰≥7阶，消耗神识(500)+灵石(200000)+乾蓝寒髓(10)
 *   - 48h 冷却
 */
router.post('/xutian-cauldron/polarize', auth, async (req, res, next) => {
    try {
        const { polarity } = req.body || {};
        // 参数校验：polarity 必填且必须在白名单内
        if (!polarity) {
            throw new AppError('化极方向 polarity 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!VALID_POLARITY_TYPES.includes(polarity)) {
            throw new AppError('化极方向无效，应为 ziluo_jihuo 或 qianlan_bingyan', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await ArtifactDeepLineService.polarizeFlame(req.user.id, polarity);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

// ==================== 掌天瓶线路由（玩法文档第19节） ====================

/**
 * 获取掌天瓶状态
 * GET /api/artifact-deep-line/sky-bottle/status
 *
 * 响应：
 *   - 已装备掌天瓶：返回完整状态快照（绿液/8个冷却/3个材料线成长度/配置摘要）
 *   - 未装备掌天瓶：返回 has_sky_bottle=false + 获取途径提示
 */
router.get('/sky-bottle/status', auth, async (req, res, next) => {
    try {
        const data = await ArtifactDeepLineService.getSkyBottleStatus(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 凝液聚集绿液
 * POST /api/artifact-deep-line/sky-bottle/condense
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 6h 冷却
 *   - 绿液 = 基础10 + 每境界等级额外2点
 *   - 绿液上限 1000
 */
router.post('/sky-bottle/condense', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.condenseLiquid(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 炼丹（稳/变两种模式）
 * POST /api/artifact-deep-line/sky-bottle/alchemy
 * body: { mode: 'stable' | 'variable', pill_key: '<丹药item_key>' }
 *
 * 业务效果：
 *   - stable 稳定炼丹：消耗50绿液，100%成功率，无品质加成
 *   - variable 变丹机缘：消耗30绿液，60%成功率，20%概率品质+1
 *   - 2h 冷却
 *   - 支持丹药白名单见配置 supported_pills
 */
router.post('/sky-bottle/alchemy', auth, async (req, res, next) => {
    try {
        const { mode, pill_key: pillKey } = req.body || {};
        // 参数校验：mode 必填且必须在白名单内
        if (!mode) {
            throw new AppError('炼丹模式 mode 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!VALID_ALCHEMY_MODES.includes(mode)) {
            throw new AppError('炼丹模式无效，应为 stable 或 variable', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 参数校验：pill_key 必填（丹药物品 key）
        if (!pillKey) {
            throw new AppError('丹药 pill_key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await ArtifactDeepLineService.alchemy(req.user.id, mode, pillKey);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 药园施术（需黄枫谷宗门）
 * POST /api/artifact-deep-line/sky-bottle/garden
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 需玩家宗门为黄枫谷（huangfeng）
 *   - 消耗80绿液，灵田产量+20%
 *   - 12h 冷却
 */
router.post('/sky-bottle/garden', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.gardenBoost(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 星台施术（需星宫宗门）
 * POST /api/artifact-deep-line/sky-bottle/star-platform
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 需玩家宗门为星宫（xinggong）
 *   - 消耗100绿液，星宫任务奖励+15%
 *   - 12h 冷却
 */
router.post('/sky-bottle/star-platform', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.starPlatformBoost(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 养竹（推进天雷竹材料线成长度）
 * POST /api/artifact-deep-line/sky-bottle/nurture-bamboo
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗40绿液，天雷竹成长度+10（满100可化竹）
 *   - 4h 冷却
 */
router.post('/sky-bottle/nurture-bamboo', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.nurtureBamboo(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 化竹（天雷竹成长度满后产出天雷竹物品）
 * POST /api/artifact-deep-line/sky-bottle/transform-bamboo
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 需天雷竹成长度≥100
 *   - 消耗60绿液，产出天雷竹×1，成长度归零
 *   - 4h 冷却
 */
router.post('/sky-bottle/transform-bamboo', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.transformBamboo(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 养木（逆养万年养魂木）
 * POST /api/artifact-deep-line/sky-bottle/nurture-wood
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗200绿液，养魂木成长度+5（满100产出万年养魂木×1）
 *   - 24h 冷却
 */
router.post('/sky-bottle/nurture-wood', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.nurtureSoulWood(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 养树（将灵眼树胚培养成灵眼之树）
 * POST /api/artifact-deep-line/sky-bottle/nurture-tree
 * body: {} (无需参数)
 *
 * 业务效果：
 *   - 消耗500绿液，灵眼树成长度+3（满100产出灵眼之树×1）
 *   - 48h 冷却
 */
router.post('/sky-bottle/nurture-tree', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.nurtureSpiritTree(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

// ========== 大五行幻世轮线路由（玩法文档第19节·法宝深线第四条） ==========
// 被动战斗驱动成长 + 五行定相系统 + 五行相生相克 + 轮转技能（5阶解锁）

// 定相白名单校验常量（与配置 phases 键对应，避免硬编码到路由逻辑中）
const VALID_WHEEL_PHASES = ['rotation', 'metal', 'water', 'wood', 'fire', 'earth'];

/**
 * GET /api/artifact-deep-line/five-element-wheel/status
 * 查看大五行幻世轮状态（悟印阶数/当前相位/进度/战力加成/五行相克提示）
 */
router.get('/five-element-wheel/status', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.getFiveElementWheelStatus(req.user.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/artifact-deep-line/five-element-wheel/set-phase
 * 定相（决定成长倾向），7 天冷却
 * body: { phase: 'rotation'|'metal'|'water'|'wood'|'fire'|'earth' }
 */
router.post('/five-element-wheel/set-phase', auth, async (req, res, next) => {
    try {
        const { phase } = req.body || {};
        if (!phase) {
            throw new AppError('定相 phase 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!VALID_WHEEL_PHASES.includes(phase)) {
            throw new AppError(`定相无效，应为：${VALID_WHEEL_PHASES.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await ArtifactDeepLineService.setPhase(req.user.id, phase);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/artifact-deep-line/five-element-wheel/insight
 * 查看悟印提示（成长进度/每日剩余/战斗预期收益/五行相克加成）
 */
router.post('/five-element-wheel/insight', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.getInsightHint(req.user.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/artifact-deep-line/five-element-wheel/wheel-spin
 * 轮转技能开关（5 阶解锁，战斗中每 3 回合自动切换相位）
 */
router.post('/five-element-wheel/wheel-spin', auth, async (req, res, next) => {
    try {
        const result = await ArtifactDeepLineService.toggleWheelSpin(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
