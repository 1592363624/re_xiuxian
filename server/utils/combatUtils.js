const { ATTRIBUTES } = require('./gameConstants');

const RESTRAINT_MAP = {
    [ATTRIBUTES.METAL]: ATTRIBUTES.WOOD,
    [ATTRIBUTES.WOOD]: ATTRIBUTES.EARTH,
    [ATTRIBUTES.EARTH]: ATTRIBUTES.WATER,
    [ATTRIBUTES.WATER]: ATTRIBUTES.FIRE,
    [ATTRIBUTES.FIRE]: ATTRIBUTES.METAL,
    
    [ATTRIBUTES.THUNDER]: ATTRIBUTES.ICE,
    [ATTRIBUTES.ICE]: ATTRIBUTES.WIND,
    [ATTRIBUTES.WIND]: ATTRIBUTES.THUNDER
};

const BASE_ELEMENTS = [ATTRIBUTES.METAL, ATTRIBUTES.WOOD, ATTRIBUTES.WATER, ATTRIBUTES.FIRE, ATTRIBUTES.EARTH];
const VARIANT_ELEMENTS = [ATTRIBUTES.THUNDER, ATTRIBUTES.ICE, ATTRIBUTES.WIND];

/**
 * 计算属性克制系数
 * @param {string} attackerAttr 攻击者属性
 * @param {string} defenderAttr 防御者属性
 * @returns {number} 伤害系数
 */
function getRestraintMultiplier(attackerAttr, defenderAttr) {
    if (!attackerAttr || !defenderAttr) return 1.0;
    
    // 同属性
    if (attackerAttr === defenderAttr) return 1.0;

    const isAttackerVariant = VARIANT_ELEMENTS.includes(attackerAttr);
    const isDefenderVariant = VARIANT_ELEMENTS.includes(defenderAttr);
    const isAttackerBase = BASE_ELEMENTS.includes(attackerAttr);
    const isDefenderBase = BASE_ELEMENTS.includes(defenderAttr);

    // 1. 变异属性 vs 基础五行
    if (isAttackerVariant && isDefenderBase) {
        return 1.8; // 变异克制所有五行
    }
    if (isAttackerBase && isDefenderVariant) {
        return 0.5; // 五行被变异克制
    }

    // 2. 变异属性 vs 变异属性
    if (isAttackerVariant && isDefenderVariant) {
        if (RESTRAINT_MAP[attackerAttr] === defenderAttr) {
            return 1.8; // 克制 (雷>冰>风>雷)
        }
        if (RESTRAINT_MAP[defenderAttr] === attackerAttr) {
            return 0.5; // 被克制
        }
        return 1.0; // 无克制关系
    }

    // 3. 基础五行 vs 基础五行
    if (isAttackerBase && isDefenderBase) {
        if (RESTRAINT_MAP[attackerAttr] === defenderAttr) {
            return 1.5; // 克制
        }
        if (RESTRAINT_MAP[defenderAttr] === attackerAttr) {
            return 0.7; // 被克制
        }
        return 1.0; // 无克制
    }

    return 1.0;
}

module.exports = {
    getRestraintMultiplier
};
