/**
 * 法宝深度玩法（血魔剑 / 虚天鼎 / 五气轮…）的装备行必须**带着行锁读**再整块写 deep_line_state。
 *
 * 为什么单独一条闸而不是塞进户口册：`ArtifactDeepLineService` 里 25 处
 * `equipment.deep_line_state = { ...equipment.deep_line_state, <法宝>: state }` 是"读-改-写整块列"，
 * 户口册按"方法体里有没有对该模型 LOCK.UPDATE"判，看不见本文件的取锁约定 ——
 * 锁收在 `static async _findXxxEquipment(playerId, t = null, lock = false)` 里，
 * 调用点写 `(playerId, t, true)` 才是带锁读。上一轮我把这 25 处记成
 * "承认定性没做完"，就是没确认这一点；这条用例把它变成可查的不变量。
 *
 * 要求：凡是要写 `deep_line_state` 的方法，必须先通过 `_find…Equipment(playerId, t, true)`
 * 或直接的 `PlayerEquipment.findOne/findByPk(… lock: t.LOCK.UPDATE …)` 拿到行。
 * 少了这一步，两个并发操作（同一个玩家的两次祭血 / 一次祭血 + 一次 toggling）
 * 就会各自读一份状态机、后写的把先写的整块盖掉 —— 法宝阶段、魔染、悟印都会无声回退。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const FILE = 'game/services/ArtifactDeepLineService.js';
const src = fs.readFileSync(path.join(SERVER, FILE), 'utf8');
const lines = src.split(/\r?\n/);

// 方法头（排除控制语句；本文件全是 `static async name(...) {`）
const HEAD = /^\s{0,8}(?!\b(?:if|for|while|switch|catch|return|else|do|try)\b)(?:static\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/;

function methodRanges() {
    const out = [];
    lines.forEach((line, i) => {
        if (!HEAD.test(line)) return;
        let depth = 0;
        for (let k = i; k < lines.length; k++) {
            depth += (lines[k].match(/\{/g) || []).length - (lines[k].match(/\}/g) || []).length;
            if (depth <= 0 && k > i) { out.push({ name: line.trim(), start: i, end: k }); break; }
        }
    });
    return out;
}

const METHODS = methodRanges();

/** 去掉注释：注释里写的 `(playerId, t, true)` 不算真的带锁读 */
function codeOnly(body) {
    return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function lockedReadIn(body) {
    const code = codeOnly(body);
    // a) 本文件的取锁助手，第三个实参必须是字面量 true
    const viaHelper = /this\._find\w*Equipment\(\s*[^)]*,\s*t\s*,\s*true\s*\)/.test(code);
    // b) 直接带锁取行
    const direct = /PlayerEquipment\s*\.\s*(?:findOne|findByPk)\s*\(([\s\S]{0,300}?)\)\s*;/.test(code)
        && /PlayerEquipment\s*\.\s*(?:findOne|findByPk)\s*\([\s\S]{0,300}?LOCK\s*\.\s*UPDATE/.test(code);
    return viaHelper || direct;
}

describe('法宝深度玩法：整块写 deep_line_state 之前必须带行锁读装备行', () => {
    test('检测器不是空跑：认得三种形状（带锁助手 / 不带锁助手 / 直接 FOR UPDATE）', () => {
        expect(lockedReadIn('const e = await this._findBloodSwordEquipment(playerId, t, true);')).toBe(true);
        expect(lockedReadIn('const e = await this._findBloodSwordEquipment(playerId, t);')).toBe(false);
        expect(lockedReadIn('const e = await this._findBloodSwordEquipment(playerId);')).toBe(false);
        // 注释里写一句带锁的调用，不能把无锁读洗白
        expect(lockedReadIn('// const e = await this._findBloodSwordEquipment(playerId, t, true);\nconst e = await this._findBloodSwordEquipment(playerId);')).toBe(false);
        expect(lockedReadIn([
            'const e = await PlayerEquipment.findOne({',
            '  where: { player_id: 1 }, transaction: t, lock: t.LOCK.UPDATE',
            '});'
        ].join('\n'))).toBe(true);
    });

    test('取锁助手真的会取锁（把 lock 参数改成摆设，这条就红）', () => {
        const helpers = [...src.matchAll(/static async (_find\w*Equipment)\(playerId, t = null, lock = false\) \{([\s\S]*?)\n    \}/g)]
            .map(m => ({ name: m[1], body: m[2] }));
        expect(helpers.length).toBeGreaterThanOrEqual(3);       // 血魔剑 / 虚天鼎 / 五气轮（少一个 = 形状变了，先修这条）
        for (const h of helpers) {
            if (!/query\.lock\s*=\s*t\.LOCK\.UPDATE/.test(h.body)) {
                throw new Error(`${h.name}(…, lock) 收到 lock=true 却没真的加锁 —— 所有调用点的"带锁读"都是假的`);
            }
        }
    });

    test('每个写 deep_line_state 的方法都先带锁读到了那一行', () => {
        const offenders = [];
        const initializers = [];
        let writers = 0;
        for (const m of METHODS) {
            const body = lines.slice(m.start, m.end + 1).join('\n');
            if (!/\.deep_line_state\s*=[^=]/.test(codeOnly(body))) continue;
            writers++;
            if (lockedReadIn(body)) continue;
            /**
             * 唯一的例外：`_init…State(equipment)` 这类"给传进来的行补默认值"的初始化器 ——
             * 它自己不落库，持久化与锁都是调用方的事。但例外不能变成洞：
             * 初始化器里一旦出现 save/update，就是"拿着别人传进来的（可能无锁的）行自己写库"，
             * 那时必须回到带锁读的规则里来，这条就红。
             */
            if (/^\s*(?:static\s+)?(?:async\s+)?_init\w*State\s*\(/.test(m.name)) {
                if (/\.\s*(?:save|update)\s*\(/.test(codeOnly(body))) {
                    offenders.push(`${m.name}（第 ${m.start + 1} 行起）—— 初始化器里出现了 save/update`);
                    continue;
                }
                initializers.push(m.name);
                continue;
            }
            offenders.push(`${m.name}（第 ${m.start + 1} 行起）`);
        }
        if (offenders.length) {
            throw new Error(`这些方法要整块写 deep_line_state，却没带行锁读装备行：\n  ${offenders.join('\n  ')}`
                + '\n  改法：`const equipment = await this._find…Equipment(playerId, t, true)`（第三个参数别漏），'
                + '并在锁之后再做读-改-写。');
        }
        // 名单不能空转（2026-09-21 实测：19 个方法写这一列 = 15 个业务方法 + 4 个"补默认值"初始化器）。
        // 这是"只准多不准少"的底线：写点变少要回来看是不是有人把状态写没了。
        expect(writers).toBeGreaterThanOrEqual(19);
        expect(initializers.length).toBeLessThanOrEqual(6);
    });
});
