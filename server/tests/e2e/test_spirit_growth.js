/**
 * 手工探针脚本（不属于 jest 用例）：打印各境界的灵力/气血上限阶梯。
 *
 * 走统一管线：上限值 = AttributeService 的静态解析结果，
 * 与玩家面板、恢复结算看到的是同一个数（改造前这里是独立的第二条算法）。
 *
 * 运行：cd server && node tests/e2e/test_spirit_growth.js
 */
const path = require('path');

const AttributeService = require('../../game/core/AttributeService');
const AttributeMaxService = require('../../game/core/AttributeMaxService');

const configPath = name => require(path.join('../../config', `${name}.json`));

AttributeService.initialize({
    getConfig: (name) => configPath(name),
    hasConfig: () => true
});

const realms = configPath('realm_breakthrough').realms;

console.log('境界\t\t\t气血上限\t灵力上限\t寿元上限');
for (const realm of realms) {
    const player = { id: 0, realm: realm.name, spirit_root: '无', attributes: {} };
    const maxValues = AttributeMaxService.calculateAttributeMaxValues(player, realm);
    console.log(
        `${realm.name}\t${maxValues.hp_max}\t${maxValues.mp_max}\t${maxValues.lifespan_max}`
    );
}
