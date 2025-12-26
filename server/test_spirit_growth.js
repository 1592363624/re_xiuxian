const service = require('./modules/core/AttributeMaxService');

// 模拟配置加载器
service.initialize({
    loadConfig: (name) => {
        if (name === 'spirit_system') {
            return require(`./config/spirit_system.json`);
        }
        return {};
    }
});

console.log('测试灵力增长曲线:');
console.log('凡人:', service.calculateMPMax({}, { realm: '凡人' }));
console.log('炼气期一层:', service.calculateMPMax({}, { realm: '炼气期一层' }));
console.log('炼气期十层:', service.calculateMPMax({}, { realm: '炼气期十层' }));
console.log('炼气期十一层:', service.calculateMPMax({}, { realm: '炼气期十一层' }));
console.log('炼气期十二层:', service.calculateMPMax({}, { realm: '炼气期十二层' }));
console.log('炼气期十三层:', service.calculateMPMax({}, { realm: '炼气期十三层' }));
console.log('筑基初期:', service.calculateMPMax({}, { realm: '筑基初期' }));
console.log('筑基中期:', service.calculateMPMax({}, { realm: '筑基中期' }));
console.log('筑基后期:', service.calculateMPMax({}, { realm: '筑基后期' }));
console.log('筑基大圆满:', service.calculateMPMax({}, { realm: '筑基大圆满' }));
console.log('金丹初期:', service.calculateMPMax({}, { realm: '金丹初期' }));
console.log('金丹中期:', service.calculateMPMax({}, { realm: '金丹中期' }));
console.log('金丹后期:', service.calculateMPMax({}, { realm: '金丹后期' }));
console.log('金丹大圆满:', service.calculateMPMax({}, { realm: '金丹大圆满' }));
console.log('元婴初期:', service.calculateMPMax({}, { realm: '元婴初期' }));
console.log('元婴中期:', service.calculateMPMax({}, { realm: '元婴中期' }));
console.log('元婴后期:', service.calculateMPMax({}, { realm: '元婴后期' }));
console.log('元婴大圆满:', service.calculateMPMax({}, { realm: '元婴大圆满' }));
console.log('化神初期:', service.calculateMPMax({}, { realm: '化神初期' }));
console.log('化神中期:', service.calculateMPMax({}, { realm: '化神中期' }));
console.log('化神后期:', service.calculateMPMax({}, { realm: '化神后期' }));
console.log('化神大圆满:', service.calculateMPMax({}, { realm: '化神大圆满' }));
console.log('炼虚初期:', service.calculateMPMax({}, { realm: '炼虚初期' }));
console.log('合体初期:', service.calculateMPMax({}, { realm: '合体初期' }));
console.log('大乘初期:', service.calculateMPMax({}, { realm: '大乘初期' }));
console.log('渡劫期:', service.calculateMPMax({}, { realm: '渡劫期' }));
