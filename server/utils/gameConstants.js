const ATTRIBUTES = {
    METAL: 'metal', // 金
    WOOD: 'wood',   // 木
    WATER: 'water', // 水
    FIRE: 'fire',   // 火
    EARTH: 'earth', // 土
    THUNDER: 'thunder', // 雷
    ICE: 'ice',     // 冰
    WIND: 'wind'    // 风
};

const ATTRIBUTE_NAMES = {
    [ATTRIBUTES.METAL]: '金',
    [ATTRIBUTES.WOOD]: '木',
    [ATTRIBUTES.WATER]: '水',
    [ATTRIBUTES.FIRE]: '火',
    [ATTRIBUTES.EARTH]: '土',
    [ATTRIBUTES.THUNDER]: '雷',
    [ATTRIBUTES.ICE]: '冰',
    [ATTRIBUTES.WIND]: '风'
};

// 境界顺序（用于等级计算）
const REALM_ORDER = [
    '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
    '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
    '炼气11层', '炼气12层', '炼气13层', '炼气圆满',
    '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
    '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
    '元婴期', '元婴初期', '元婴中期', '元婴后期', '元婴圆满',
    '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '真仙'
];

module.exports = {
    ATTRIBUTES,
    ATTRIBUTE_NAMES,
    REALM_ORDER
};
