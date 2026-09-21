/**
 * 整块 JSON 列"读-改-写"必须串行 —— 静态门禁
 *
 * 背景：players 那几个 blob 列有 blobWriteGuard + state_version 兜底，但守卫射程之外的表
 * （player_second_soul / player_fishing / player_equipment）没有版本列，只能靠"取行时加锁"。
 * 本轮实测到的三处形状：并发两次 gmAdjustAttributes 会互相抹键（S6 活体复现）、
 * 封鞘到期扫描会拿整表快照覆盖玩家期间的提交（F3 活体复现，4/4 稳定红）、
 * 钓鱼轮询/试探与提竿并发（F1 那一支实测压不出来，只能静态钉）。
 *
 * 活体探针只能证明"这一版在这一台机器上没丢"，压不出窗口只有 1~2ms 的交错，
 * 也管不住以后有人新加一条写路径又随手整块写回。所以这里把契约钉在源码结构上：
 *   读整块 JSON 列 → 在同一笔事务里对该行 FOR UPDATE → 改 → 带事务写回。
 *   只读接口一律不落库。
 *
 * 和方法名绑定的扫描都必须自检（第一条 test），否则改名会让门禁悄悄变成空跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readSource(rel) {
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');
}

const FISHING = readSource('game/services/FishingService.js');
const DEEP_LINE = readSource('game/services/ArtifactDeepLineService.js');
const SECOND_SOUL = readSource('game/services/SecondSoulService.js');

/** 按 "    static [async] name(" 切方法体；块尾取到下一个同级方法声明为止 */
function methodBody(src, name) {
    const startRe = new RegExp(`\\n    static (?:async )?${name}\\(`);
    const m = startRe.exec(src);
    if (!m) return null;
    const rest = src.slice(m.index + 1);
    const next = rest.slice(1).search(/\n    (?:static )?(?:async )?[A-Za-z_$][\w$]*\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('只读接口不得写整块 JSON 列', () => {
    test('扫描器看到的是真文件，方法切块没有静默失效', () => {
        expect(FISHING).toContain('static async getStatus(');
        expect(DEEP_LINE).toContain('static async settleExpiredSheaths(');
        expect(SECOND_SOUL).toContain('static async gmAdjustAttributes(');
        // 每个被测方法都要真能切出块，切不出来直接红（而不是 undefined 上跑正则跑成假绿）
        for (const [src, name] of [
            [FISHING, 'getStatus'], [FISHING, '_clearExpiredSession'], [FISHING, 'nibble'], [FISHING, 'giveUp'],
            [DEEP_LINE, 'settleExpiredSheaths'],
            [SECOND_SOUL, 'gmAdjustAttributes']
        ]) {
            expect(methodBody(src, name)).toBeTruthy();
        }
    });

    test('钓鱼状态轮询不写 active_session，也不 save 整行', () => {
        const body = methodBody(FISHING, 'getStatus');
        expect(body).not.toMatch(/active_session\s*=/);
        expect(body).not.toMatch(/fishing\.save\(/);
        expect(body).toContain('this._clearExpiredSession(');
    });

    test('法宝四条状态线与悟印提示都不落库', () => {
        const readOnly = [
            'getBloodSwordStatus', 'getXutianCauldronStatus', 'getSkyBottleStatus',
            'getFiveElementWheelStatus', 'getInsightHint'
        ];
        for (const name of readOnly) {
            const body = methodBody(DEEP_LINE, name);
            expect(body).toBeTruthy();
            expect(body).not.toMatch(/equipment\.save\(/);
            expect(body).not.toMatch(/equipment\.deep_line_state\s*=/);
        }
    });

    test('归一化 helper 自己只改内存，写回留给调用方', () => {
        for (const name of ['_initBloodSwordState', '_initXutianCauldronState', '_initSkyBottleState', '_initWheelState']) {
            const body = methodBody(DEEP_LINE, name);
            expect(body).toBeTruthy();
            expect(body).not.toMatch(/\.save\(/);
        }
    });
});

describe('整块 JSON 列的读-改-写必须先拿行锁', () => {
    test('过期会话清理：加锁重读，并且拿"还是同一竿 + 确实过期"当写入前提', () => {
        const body = methodBody(FISHING, '_clearExpiredSession');
        expect(body).toMatch(/lock: t\.LOCK\.UPDATE/);
        expect(body).toMatch(/fresh\.cast_at === castAt/);
        expect(body).toMatch(/reel_deadline/);
        expect(body).toMatch(/save\(\{ transaction: t \}\)/);
    });

    test('试探与收竿在碰 player_fishing 之前先锁 players 行（与 cast/reel 同一把锁）', () => {
        for (const name of ['nibble', 'giveUp']) {
            const body = methodBody(FISHING, name);
            const lockAt = body.search(/Player\.findByPk\(playerId,\s*\{[^}]*lock: t\.LOCK\.UPDATE/);
            const touchAt = body.indexOf('_getOrCreateFishing(');
            expect(lockAt).toBeGreaterThanOrEqual(0);
            expect(touchAt).toBeGreaterThanOrEqual(0);
            expect(lockAt).toBeLessThan(touchAt);
        }
    });

    test('封鞘到期扫描逐行加锁重读，不在锁外 save，也不在加锁前就下结论', () => {
        const body = methodBody(DEEP_LINE, 'settleExpiredSheaths');
        expect(body).toMatch(/lock: t\.LOCK\.UPDATE/);
        expect(body).not.toMatch(/equipment\.save\(\s*\)/);
        expect(body).toMatch(/save\(\{ transaction: t \}\)/);
        // 加锁之后还要重新判过期：锁外那次粗筛的结论随时会过期
        const lockAt = body.indexOf('lock: t.LOCK.UPDATE');
        const recheckAt = body.indexOf('sheath_until).getTime()');
        expect(recheckAt).toBeGreaterThan(lockAt);
        // 回滚分支必须在，否则出错时事务悬挂
        expect(body).toMatch(/t\.rollback\(\)/);
    });

    test('第二元神调整属性：先锁住那一行，再合并写回', () => {
        const body = methodBody(SECOND_SOUL, 'gmAdjustAttributes');
        const lockAt = body.search(/lock: t\.LOCK\.UPDATE/);
        const mergeAt = body.indexOf('soul.attributes =');
        expect(lockAt).toBeGreaterThanOrEqual(0);
        expect(mergeAt).toBeGreaterThan(lockAt);
        expect(body).toMatch(/save\(\{ transaction: t \}\)/);
    });
});

/**
 * 太一门引道（player_taoism_gate）。
 * 这张表的整块列存着技能冷却、日常任务、修炼次数 —— 探针 smoke_taoism_gate_race 实测过：
 * 不锁就是"同一条任务奖励领两次"（控制跑：法则碎片 +6 应为 +3）。
 * 而"互相丢球"那种窗口（火眼写别人的那一行）实测压不出来（亚毫秒），所以那条契约钉在源码上：
 * 涉及别人行时只能一次按 player_id 升序把锁取齐（分两次"先自己后对方"就是 ABBA 死锁）。
 */
const TAOISM = readSource('game/services/TaoismGateService.js');

/** 实例方法切块（这个服务不是 static），块尾取到下一个同级方法声明 */
function gateMethod(name) {
    const startRe = new RegExp(`\\n    async ${name}\\(`);
    const m = startRe.exec(TAOISM);
    if (!m) return null;
    const rest = TAOISM.slice(m.index + 1);
    const next = rest.slice(1).search(/\n    (?:static )?(?:async )?[A-Za-z_$][\w$]*\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * 判"不许出现某种写法"之前先把注释抹掉：
 * ① gateMethod 是按"下一个方法头"切块的，下一个方法的 JSDoc 会被算进上一个方法体里；
 * ② 注释里引用旧写法不等于代码在用它（ContentIntegrity 那条 require 扫描就踩过这个误报）。
 */
function codeOnly(body) {
    return (body || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('太一门引道：道途整块列的读写必须锁', () => {
    const WRITE_PATHS = ['choosePath', 'switchPath', 'cultivate', 'useSkill', 'claimTaskReward'];

    test('扫描器看到的是真方法与真文件（防空跑）', () => {
        expect(TAOISM).toContain('async _lockGate(playerId, t)');
        for (const name of WRITE_PATHS) {
            if (!gateMethod(name)) throw new Error(`切不出方法 ${name} —— 改名会让这道闸静默空跑`);
            expect(gateMethod(name)).toBeTruthy();
            expect(gateMethod(name)).toContain('sequelize.transaction()');
        }
    });

    test('五条写路径都在事务内取过道途行的锁', () => {
        for (const name of WRITE_PATHS) {
            const body = gateMethod(name);
            const lockAt = body.search(/this\._lockGates?ByPlayerIdAsc\(|this\._lockGate\(/);
            const txAt = body.indexOf('sequelize.transaction()');
            expect(txAt).toBeGreaterThanOrEqual(0);
            expect(lockAt).toBeGreaterThanOrEqual(0);
            expect(lockAt).toBeGreaterThan(txAt);
        }
    });

    test('判定用锁住之后读到的那一份（不锁就是双领奖励）', () => {
        const claim = gateMethod('claimTaskReward');
        const lockAt = claim.search(/this\._lockGates?ByPlayerIdAsc\(|this\._lockGate\(/);
        expect(claim.slice(lockAt)).toMatch(/task\.rewards_claimed/);
        expect(claim.slice(lockAt)).toMatch(/_checkDailyReset\(gate, *t\)/);
    });

    /**
     * 跨日重置的写回必须带着调用方的事务。少了它会这样：claimTaskReward 刚在 t 里
     * `FOR UPDATE` 锁住这一行，紧接着不带事务的 `gate.save()` 走**另一条连接**去 UPDATE 同一行，
     * 只能等 innodb_lock_wait_timeout（默认 50 秒）再抛 ER_LOCK_WAIT_TIMEOUT —— 请求挂死在锁上。
     * 另外面板路径（getProfile/getDailyTasks）以前是"无锁读 → save()"，与领取交错会把
     * 刚写进去的 rewards_claimed 抹掉 → 同一条任务当天再领一次，所以统一走带锁的预检助手。
     */
    test('跨日重置：写回带事务，面板路径不再无锁整列写回', () => {
        const reset = gateMethod('_checkDailyReset');
        const resetCode = codeOnly(reset);
        expect(reset).toMatch(/async _checkDailyReset\(gate, *t\)/);
        expect(resetCode).toMatch(/if \(!t\) throw new Error/);
        expect(resetCode).toMatch(/gate\.save\(\{ *transaction: *t *}\)/);
        if (/gate\.save\(\s*\)/.test(resetCode)) throw new Error('_checkDailyReset 里还有不带事务的 save()');

        const readHelper = gateMethod('_resetDailyTasksForRead');
        expect(codeOnly(readHelper)).toMatch(/this\._lockGate\(playerId, *t\)/);
        for (const name of ['getProfile', 'getDailyTasks', 'cultivate', 'claimTaskReward']) {
            const body = codeOnly(gateMethod(name));
            if (!/_resetDailyTasksForRead\(/.test(body)) {
                throw new Error(`${name} 不再走 _resetDailyTasksForRead() —— 跨日清零退回无锁写回了？`);
            }
        }
    });

    test('涉及别人的行：一次按 player_id 升序取锁，执行器不再自己无锁读', () => {
        const use = gateMethod('useSkill');
        expect(use).toMatch(/_lockGatesByPlayerIdAsc\(\[player\.id, *targetPlayerId\]/);
        expect(TAOISM).toMatch(/_lockGatesByPlayerIdAsc\(playerIds, t\)[\s\S]{0,600}\['player_id', 'ASC'\]/);
        for (const name of ['_executeMetalBlade', '_executeFireEye', '_executeEarthPrison']) {
            const body = gateMethod(name);
            if (!body) throw new Error(`切不出执行器 ${name}`);
            expect(body).toContain('targetGate');
            // findOne 的参数里还嵌套着一层 {}，所以匹配要允许中间有 }（早期写成 [^}]* 时控制跑直接假绿）
            const unlockedRead = /PlayerTaoismGate\s*\.\s*findOne\(\s*\{[\s\S]{0,220}?\}\s*\)/.test(body.replace(/lock: t\.LOCK\.UPDATE/g, ''));
            if (unlockedRead) throw new Error(`${name} 里还有不带锁的 targetGate 取行 —— 整块写回会抹掉对方期间的提交`);
            expect(unlockedRead).toBe(false);
        }
    });

    /**
     * 灵兽PVP：赛季结算与对局共用 players 行。
     * 「先读到、后执行」的重放由 scripts/smoke_beast_pvp_season.js 在真库上钉（控制跑摘掉守卫
     * → 前 100 名赛季奖励再发一遍，P2/P3 红）。锁次序（结算按名次锁 vs 对局按主客锁）压不出来，
     * 所以这里钉静态：两条路径都必须只通过 _lockPlayersByIdAsc 取 players 锁。
     */
    test('灵兽PVP：结算锁赛季行并重判 status，两条路径的 players 取锁都按 id 升序', () => {
        const src = readSource('game/services/SpiritBeastPvpService.js');
        const body = name => {
            const lines = src.split(/\r?\n/);
            const head = lines.findIndex(l => new RegExp(`^\\s+async ${name}\\(`).test(l));
            if (head < 0) throw new Error(`切不出方法 ${name} —— 改名会让这条闸静默空跑`);
            let depth = 0;
            for (let i = head; i < lines.length; i++) {
                depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
                if (depth <= 0 && i > head) return lines.slice(head, i + 1).join('\n');
            }
            throw new Error(`${name} 的方法体没闭合`);
        };

        const helper = body('_lockPlayersByIdAsc');
        if (!/\.sort\(\(a, b\) => a - b\)/.test(helper) || !/\['id', 'ASC'\]/.test(helper)) {
            throw new Error('_lockPlayersByIdAsc 不再保证 id 升序 —— 整个契约就没了');
        }

        const settle = body('_settleSeason');
        if (!/SpiritBeastPvpSeason\.findByPk\([\s\S]{0,140}lock: transaction\.LOCK\.UPDATE/.test(settle)) {
            throw new Error('_settleSeason 没把赛季行锁进来：调用方那次 findAll 粗筛不带锁，重放就把奖励发两遍');
        }
        if (!/status !== 'active'/.test(settle)) throw new Error('_settleSeason 锁内没重判 status（读了旧快照照发）');
        if (!/season\.save\(\{[^}]*transaction/.test(settle)) throw new Error('赛季写回没带事务');
        if (!/SpiritBeastPvpSeason\.create\([\s\S]{0,400}transaction[\s\S]{0,80}\)\s*;[\s\S]{0,120}await transaction\.commit\(\)/.test(settle)) {
            throw new Error('新赛季不在同一个事务里建 —— 建失败会留下「已 settled、没有下一季」的空档，排位停摆');
        }
        if (!/this\._lockPlayersByIdAsc\(transaction/.test(settle)) {
            throw new Error('发奖又回到按名次逐个锁 players —— 与并发对局的次序相反就是 ABBA');
        }
        if (/Player\.findByPk\([^)]*lock: transaction\.LOCK\.UPDATE/.test(settle)) {
            throw new Error('_settleSeason 里还留着逐个 findByPk 加锁（次序由名次决定）');
        }

        const challenge = body('challenge');
        if (!/this\._lockPlayersByIdAsc\(transaction, \[player\.id, targetPlayerId\]\)/.test(challenge)) {
            throw new Error('对局没有一次按 id 升序把双方 players 锁齐 —— 「先挑战者后防守者」与结算/别的对局交错就是 ABBA 死锁');
        }
        if (/Player\.findByPk\([^)]*lock: transaction\.LOCK\.UPDATE/.test(challenge)) {
            throw new Error('challenge 里还留着分两次按调用方顺序加锁的写法');
        }
    });

    /**
     * 灵兽PVP 对局的钱与次数：判定必须看锁到的那一份，押注必须两边都下注。
     * 这三条都是 scripts/smoke_beast_pvp_battle.js 在真库上先跑出红来才修的：
     *   余额校验用无锁预读 → 同一份灵石对两个不同对手各押一次，A 被扣成 -100；
     *   挑战方输时只扣挑战方一注、却给防守方发两注 → 每输一局凭空印 betStones 灵石；
     *   排名行不锁 → daily_challenge_count 按旧快照写回，10 次/天的上限失效。
     */
    test('灵兽PVP 对局：锁内重判余额与次数，押注两边都扣一注', () => {
        const src = readSource('game/services/SpiritBeastPvpService.js');
        const lines = src.split(/\r?\n/);
        const body = name => {
            const head = lines.findIndex(l => new RegExp(`^\\s+async ${name}\\(`).test(l));
            if (head < 0) throw new Error(`切不出方法 ${name} —— 改名会让这条闸静默空跑`);
            let depth = 0;
            for (let i = head; i < lines.length; i++) {
                depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
                if (depth <= 0 && i > head) return lines.slice(head, i + 1).join('\n');
            }
            throw new Error(`${name} 的方法体没闭合`);
        };
        const problems = [];
        const ch = body('challenge');
        if (!/_lockRankingsByIdAsc\(transaction/.test(ch)) problems.push('challenge 没把双方排名行按 player_id 升序锁齐');
        if (!/BigInt\(challengerLocked\.spirit_stones[^)]*\)\s*<\s*BigInt\(betStones\)/.test(ch)) {
            problems.push('challenge 没有在锁内重判挑战方余额（双花：100 灵石押两次，扣成 -100）');
        }
        if (!/BigInt\(defenderLocked\.spirit_stones[^)]*\)\s*<\s*BigInt\(betStones\)/.test(ch)) {
            problems.push('challenge 没有在锁内重判防守方余额');
        }
        if (!/challengerRanking\s*=\s*challengerRankingLocked/.test(ch)) {
            problems.push('challenge 的结算还在用事务外那份无锁排名行（daily_challenge_count/total_matches 会被盖回旧值）');
        }
        if (!/defenderLocked\.spirit_stones = BigInt\(defenderLocked\.spirit_stones \|\| 0\) - BigInt\(betStones\) \+ BigInt\(betStones\) \* 2n/.test(ch)) {
            problems.push('挑战方输的那条路径没扣防守方那一注 —— 赢家拿 2 注、只收 1 注 = 凭空印钱');
        }
        if (/defenderRanking = await this\._getOrCreateRanking/.test(ch)) {
            problems.push('防守方排行又是无锁读 —— 并发对局会把胜负场次互相盖掉');
        }
        const reset = body('_checkDailyReset');
        if (/ranking\.save\(\{ *silent: *true *\}\)/.test(reset)) {
            problems.push('_checkDailyReset 里有不带事务的 save()（被锁内调用时会自己等自己的行锁）');
        }
        if (!/async _checkDailyReset\(ranking, transaction = null\)/.test(reset)) {
            problems.push('_checkDailyReset 的 transaction 参数被拿掉了');
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });
});
