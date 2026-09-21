/**
 * 护道反击这条链：静态闸（不连库）
 *
 * 为什么要钉：`DaoCompanionService` 的护道结算里写着"反击概率 counter_attack_rate（默认 30%）、
 * 反击伤害 = 护道方 ATK × counter_attack_multiplier"，但 `protectorAtk > 0` 才有资格触发，
 * 而**全仓三个调用点传进来的都是 0**（CombatService / PvpService / WorldBossService，注释还说
 * "反击伤害计算时取配置默认"—— 配置里根本没有 ATK 这一项，只有概率与倍率）。
 * 于是这条内容今天永远不可能发生：玩家在配置里看见反击、在服务注释里看见反击，实战里永远没有。
 *
 * 接线要改的是战斗数值（给 PVE/PVP/世界 BOSS 各加一路来自第三个角色的伤害），属于要业主拍板的事，
 * 本闸不替它决定；本闸只保证两件事：
 *   1) 静默的死链不许继续变多（新增第四个 `protectorAtk: 0` 调用点直接红）；
 *   2) 不许"以为配了就生效"（在 dao_companion_data.json 里加 counter_attack_* 而 ATK 仍未接线时红）。
 * 真要接线那天：把每个点换成护道方的实测攻击力，然后**删掉本文件里对应的豁免行** —— 删不掉就是没真接。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVICES = path.join(__dirname, '..', 'game', 'services');
const CONFIG = path.join(__dirname, '..', 'config', 'dao_companion_data.json');

/** 今天已知的"传 0"调用点：新增要红，删掉也要红（删掉=已经接上，该把这条豁免一起收走） */
const ZERO_ATK_SITES = [
    'CombatService.js',
    'PvpService.js',
    'WorldBossService.js'
];

/**
 * 已冻结的"配了但不生效"记录（`dao_companion_data.json` 的这两个键，今天没有任何路径能让它触发）。
 * 业主拍板接线（战斗数值改动）或把键撤掉之后，这份记录连同上面那条清单要一起收走。
 */
const PROTECTED_COUNTER_DEAD_KEYS = ['counter_attack_rate', 'counter_attack_multiplier'];

function scanSites() {
    const hits = [];
    let totalMentions = 0;
    for (const f of fs.readdirSync(SERVICES)) {
        if (!f.endsWith('.js')) continue;
        const body = fs.readFileSync(path.join(SERVICES, f), 'utf8');
        const mentions = body.match(/protectorAtk/g);
        if (mentions) totalMentions += mentions.length;
        // 只看"传值"的地方：`protectorAtk: 0`（0 是硬编码零，不是变量）
        if (/protectorAtk\s*:\s*0\s*[,}]/.test(body)) hits.push(f);
    }
    return { hits: hits.sort(), totalMentions };
}

function protectBlock() {
    const body = fs.readFileSync(path.join(SERVICES, 'DaoCompanionService.js'), 'utf8');
    const start = body.indexOf('counterAttackRate');
    return start < 0 ? '' : body.slice(start - 3000, start + 3000);
}

describe('护道反击链（protectorAtk）：死链不许变多，也不许"配了以为生效"', () => {
    const { hits, totalMentions } = scanSites();

    test('扫描器确实在看真代码：protectorAtk 的提及数与触发条件都还在（防空跑）', () => {
        if (totalMentions < 5) {
            throw new Error(`全仓只认出 ${totalMentions} 处 protectorAtk（定义 + 三个调用点 + 注释应该远多于这个数），正则或扫描范围失效`);
        }
        const block = protectBlock();
        if (!/protectorAtk\s*>\s*0/.test(block)) {
            throw new Error('找不到 `protectorAtk > 0` 这个触发条件 —— 判定被改了就要重新评估这条链是否已经接通，别把闸静默留着');
        }
    });

    test('传硬编码 0 的调用点必须与存量清单一致：多一处=又埋一条静默死链，少一处=已经接上该收走豁免', () => {
        const extra = hits.filter(f => !ZERO_ATK_SITES.includes(f));
        const gone = ZERO_ATK_SITES.filter(f => !hits.includes(f));
        const problems = [];
        if (extra.length) {
            problems.push(`新增"护道反击传 0"的调用点：${extra.join(', ')}。反击这一路对这类玩家永远不会发生 —— `
                + `要么把护道方的真实攻击力传进来，要么就别再对外宣称有反击（见 #24）`);
        }
        if (gone.length) {
            problems.push(`${gone.join(', ')} 已经不再传硬编码 0（接线了？）：把本文件 ZERO_ATK_SITES 里那行删掉，`
                + `并顺手把"配了也不生效"的那条闸一起复核`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    test('配置声明了反击键而 ATK 未接线：这是**已冻结的死链存量**，只许变小不许变大（见 #24）', () => {
        const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
        const text = JSON.stringify(cfg);
        const declares = ['counter_attack_rate', 'counter_attack_multiplier'].filter(k => new RegExp(k).test(text));
        const dead = declares.length > 0 && hits.length === ZERO_ATK_SITES.length;
        if (dead && declares.length !== PROTECTED_COUNTER_DEAD_KEYS.length) {
            throw new Error('内容里出现了没记进冻结清单的反击键（' + declares.join('/')
                + ' 对不上 ' + PROTECTED_COUNTER_DEAD_KEYS.join('/') + '）：要么登记这条新的死链，要么撤掉配置');
        }
        // 状态一变（接线或撤键）就必须把这份冻结记录一起处理掉，不许留过期的"已知死链"声明
        if (!dead && PROTECTED_COUNTER_DEAD_KEYS.length) {
            throw new Error('反击链状态变了（已接线或键已撤），把本文件 PROTECTED_COUNTER_DEAD_KEYS 一起删掉/改写');
        }
        expect(dead).toBe(true);   // 今天的事实：配了、但接不上
    });

    test('服务注释/日志不许再写"取配置默认"这种做不到的话', () => {
        const offenders = [];
        for (const f of ZERO_ATK_SITES) {
            const body = fs.readFileSync(path.join(SERVICES, f), 'utf8');
            const m = body.match(/protectorAtk\s*:\s*0[^\n]*\n?/);
            if (m && /取配置默认/.test(m[0])) offenders.push(f);
        }
        if (offenders.length) {
            throw new Error(`${offenders.join(', ')} 的注释写着"反击伤害计算时取配置默认"，但配置里没有 ATK 这一项、`
                + `代码也只接受调用方传进来的攻击力 —— 这句话是假的，会误导下一个改这里的人`);
        }
    });
});
