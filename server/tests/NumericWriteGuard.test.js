/**
 * players 数值列写入守卫的单元测试（不连库）。
 *
 * 防的是这一族形状（全仓实测 176 处）：
 *   const p = await Player.findByPk(id);            // 读到 spirit_stones = 1000
 *   await 别的await(...);                            // 期间别的流程扣掉 300（库里 700）
 *   p.spirit_stones = BigInt(p.spirit_stones) + 50; // 手上算出 1050
 *   await p.save();                                 // 整值写回 1050 → 那 300 无声消失
 * 守卫在 save 前比一次"我这行读出来时是多少 / 库里现在是多少 / 我要写回多少"，
 * 只有"我读到的已经不作数了 **且** 我要写的也不是库里那份"才判冲突 —— 前一条抓丢数据，
 * 后一条免掉"从权威那份镜像回手上实例"这类正确写法的假警报。
 *
 * 真库上的"确实会少钱 / 加了守卫就不少了"由 scripts/smoke_numeric_write_cas.js 压差分，
 * jest 这一层不连库，只钉判定本身。
 */
'use strict';

const {
    assertNumericWriteAllowed,
    dirtyNumericColumns,
    isDatabaseSideExpression,
    StaleNumericWriteError,
    WALLET_COLUMNS,
    VITAL_COLUMNS,
    CAS_COLUMNS,
    modes,
    numOf,
    sameNumber
} = require('../game/persistence/numericWriteGuard');
const { literal } = require('sequelize');
const { resetLogOnce } = require('../utils/logOnce');

const ALL_OFF = { wallet: 'off', vital: 'off' };

/**
 * 假实例：守卫只用到 changed()/getDataValue()/previous()/isNewRecord。
 * @param {Object} cfg loaded=这行读出来时的原值；next=要写回的值；dirty=脏列
 */
function fakeInstance({ loaded = {}, next = {}, dirty, id = 7, isNewRecord = false } = {}) {
    const values = { id, ...loaded, ...next };
    const changedColumns = dirty || Object.keys(next);
    return {
        isNewRecord,
        changed(column) {
            if (column === undefined) return changedColumns.length ? changedColumns.slice() : false;
            return changedColumns.includes(column);
        },
        getDataValue(key) {
            return values[key];
        },
        previous(key) {
            return loaded[key];
        }
    };
}

/** 假模型：findByPk 返回"库里的当前值"，并记下守卫传进来的查询参数 */
function fakeModel(dbValues = {}, seen = []) {
    return {
        async findByPk(id, options) {
            seen.push({ id, options });
            if (dbValues === null) return null;
            return { getDataValue: key => dbValues[key] };
        }
    };
}

function fakeTransaction(withLock = true) {
    return withLock ? { id: 'fake-tx', LOCK: { UPDATE: 'UPDATE' } } : { id: 'fake-tx' };
}

const call = (instance, options = {}, model = null) =>
    assertNumericWriteAllowed(instance, { numericGuardModes: { wallet: 'throw', vital: 'throw' }, ...options }, model);

describe('守卫盯哪些列', () => {
    test('钱与积分 12 档、气血灵力 2 档，合并后就是原子增减的白名单', () => {
        expect(WALLET_COLUMNS).toEqual(expect.arrayContaining(
            ['spirit_stones', 'exp', 'honor', 'karma', 'pvp_score', 'attribute_points',
                'divine_sense_balance', 'law_points', 'incense_balance',
                'border_military_merit_available', 'toxicity', 'lifespan_current']
        ));
        expect(VITAL_COLUMNS).toEqual(['hp_current', 'mp_current']);
        expect(CAS_COLUMNS).toEqual([...WALLET_COLUMNS, ...VITAL_COLUMNS]);
    });

    test('名单只有一份：PlayerStateStore 的原子增减白名单与守卫完全同步（新增列不会只漏一层）', () => {
        const PlayerStateStore = require('../game/persistence/PlayerStateStore');
        expect([...PlayerStateStore.AMOUNT_COLUMNS].sort())
            .toEqual([...CAS_COLUMNS].sort());
    });

    test('这些列在模型上真实存在（拼错的列名会静默不守卫，必须当场发现）', () => {
        const Player = require('../models/player');
        for (const column of CAS_COLUMNS) {
            expect(Player.rawAttributes[column]).toBeTruthy();
        }
    });
});

describe('脏列枚举', () => {
    test('没脏数值列时一个都不报：普通标量保存照常，零额外查询', () => {
        const seen = [];
        const instance = fakeInstance({ loaded: { nickname: 'a' }, next: { nickname: 'b' } });
        expect(dirtyNumericColumns(instance, { modes: ALL_OFF })).toEqual([]);
        expect(dirtyNumericColumns(instance)).toEqual([]);
    });

    test('新建记录不盯（没有并发对手可被覆盖）', () => {
        const instance = fakeInstance({
            next: { spirit_stones: 500n }, isNewRecord: true
        });
        expect(dirtyNumericColumns(instance)).toEqual([]);
    });

    test('列上原子写（literal）不盯：那本来就是数据库端算的，没有读旧值', () => {
        const instance = fakeInstance({
            loaded: { spirit_stones: '1000' }, next: { spirit_stones: literal('`spirit_stones` - 300') }
        });
        expect(dirtyNumericColumns(instance)).toEqual([]);
        expect(isDatabaseSideExpression(literal('a'))).toBe(true);
        expect(isDatabaseSideExpression('1000')).toBe(false);
        expect(isDatabaseSideExpression(1000n)).toBe(false);
    });

    test('调用方点名了 fields 时只看真要写的那几列', () => {
        const instance = fakeInstance({
            loaded: { spirit_stones: '1', exp: '1' },
            next: { spirit_stones: 2n, exp: 2n },
            dirty: ['spirit_stones', 'exp']
        });
        expect(dirtyNumericColumns(instance, { fields: ['exp', 'nickname'] })).toEqual(['exp']);
    });

    test('档位 off 的列直接不参与判定（探针要能只开一档做对照）', () => {
        const instance = fakeInstance({ loaded: { spirit_stones: '1', hp_current: '1' }, next: { spirit_stones: 2n, hp_current: 2n } });
        expect(dirtyNumericColumns(instance, { modes: { wallet: 'off', vital: 'warn' } })).toEqual(['hp_current']);
        expect(dirtyNumericColumns(instance, { modes: ALL_OFF })).toEqual([]);
    });
});

describe('新鲜度判定', () => {
    test('库里这一列仍等于我读到的那份 → 放行', async () => {
        const seen = [];
        const instance = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050n } });
        await expect(call(instance, {}, fakeModel({ spirit_stones: '1000' }, seen)))
            .resolves.toEqual(['spirit_stones']);
        expect(seen).toHaveLength(1);
        expect(seen[0].options.attributes).toEqual(['spirit_stones', 'state_version']);
    });

    test('BigInt / 字符串 / Number 三种回值形态互不冒充冲突（BIGINT 列经 mysql2 回来是字符串或 BigInt）', async () => {
        const shapes = [['1000', 1000n], [1000n, '1000'], [1000, 1000n], [' 1000 ', 1000]];
        for (const [db, loaded] of shapes) {
            const instance = fakeInstance({ loaded: { spirit_stones: loaded }, next: { spirit_stones: 1050n } });
            await expect(call(instance, {}, fakeModel({ spirit_stones: db })))
                .resolves.toBeDefined();
        }
    });

    test('FLOAT 列（lifespan_current=当前年龄）按数值比，不按字符串比', async () => {
        const instance = fakeInstance({ loaded: { lifespan_current: 16.5 }, next: { lifespan_current: 17.5 } });
        await expect(call(instance, {}, fakeModel({ lifespan_current: 16.5 }))).resolves.toBeDefined();
        const stale = fakeInstance({ loaded: { lifespan_current: 16.5 }, next: { lifespan_current: 17.5 } });
        await expect(call(stale, {}, fakeModel({ lifespan_current: 16.8 })))
            .rejects.toMatchObject({ detail: expect.stringMatching(/lifespan_current/) });
    });

    test('控制跑：真实站点形状（读 → 别人提交 → 整值写回）必须抛，三个数字都写进报错', async () => {
        // 抄的是 game/services/AchievementService.js:269 那一条的形状：
        //   player.spirit_stones = Number(player.spirit_stones) + ss;
        // 读到 1000，期间有别的流程扣到 700，这里仍按 1000+50=1050 写回 —— 那 300 就永久没了。
        const instance = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050 } });
        const error = await call(instance, {}, fakeModel({ spirit_stones: '700' }))
            .then(() => null, e => e);
        expect(error).toBeInstanceOf(StaleNumericWriteError);
        expect(error.code).toBe('STALE_NUMERIC_WRITE');
        // 开发看的那一份（detail）要三个数字齐全、点名表与列、给出改法与调用点；
        // 玩家看的那一份（message）反过来：一个内部名字都不许有。
        expect(error.detail).toMatch(/数值列快照已过期/);
        expect(error.detail).toMatch(/读出来时是 1000/);
        expect(error.detail).toMatch(/库里现在却是 700/);
        // 指引要对着"这一档该怎么写"：事务外的出路是列上原子写，事务内的出路是锁内重读
        expect(error.detail).toMatch(/grantAmount|spendAmount/);
        expect(error.detail).toMatch(/调用点=/);
        expect(error.statusCode).toBe(409);
        expect(error.errorCode).toBe('CONCURRENT_UPDATE');
        expect(error.isOperational).toBe(true);
        expect(error.message).not.toMatch(/spirit_stones|players#|调用点=|grantAmount|快照已过期/);
        expect(error.message.length).toBeGreaterThan(8);

        const inTransaction = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050 } });
        const txError = await call(inTransaction, { transaction: fakeTransaction() }, fakeModel({ spirit_stones: '700' }))
            .then(() => null, e => e);
        expect(txError.detail).toMatch(/readForUpdate/);
        expect(txError.detail).not.toMatch(/grantAmount/);
        expect(txError.message).not.toMatch(/readForUpdate|players#/);
    });

    test('同一条链换成正确写法就不该响：锁内读出的那份参与写库', async () => {
        // readForUpdate / patchPlayerState 的形状：previous 就是锁内最新值，库里不会另有其人。
        const instance = fakeInstance({ loaded: { spirit_stones: '700' }, next: { spirit_stones: 750n } });
        await expect(call(instance, { transaction: fakeTransaction() }, fakeModel({ spirit_stones: '700' })))
            .resolves.toEqual(['spirit_stones']);
    });

    test('要写回的值本来就等于库里那份 → 幂等，放行（镜像回手上实例的正确写法）', async () => {
        // AttributeService.allocatePoints:386 `player.attribute_points = updated.attribute_points`
        // 是"从锁内那份镜像回调用方实例"，写回等于库里值，覆盖不掉任何东西。
        const instance = fakeInstance({ loaded: { attribute_points: 9 }, next: { attribute_points: 4 } });
        await expect(call(instance, {}, fakeModel({ attribute_points: 4 }))).resolves.toEqual(['attribute_points']);
    });

    test('事务内判定用的是加锁读（判定与随后的 UPDATE 之间不能有窗口）', async () => {
        const seen = [];
        const instance = fakeInstance({ loaded: { exp: '10' }, next: { exp: 20n } });
        await call(instance, { transaction: fakeTransaction() }, fakeModel({ exp: '10' }, seen));
        expect(seen[0].options.lock).toBe('UPDATE');
        expect(seen[0].options.transaction).toBeTruthy();
    });

    test('事务没有 LOCK 时降级为不加锁读，不炸', async () => {
        const seen = [];
        const instance = fakeInstance({ loaded: { exp: '10' }, next: { exp: 20n } });
        await call(instance, { transaction: fakeTransaction(false) }, fakeModel({ exp: '10' }, seen));
        expect(seen[0].options.lock).toBeUndefined();
    });

    test('读不到行时放行（交给随后的 UPDATE 去响，不在这里编故事）', async () => {
        const instance = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050n } });
        await expect(call(instance, {}, fakeModel(null))).resolves.toEqual(['spirit_stones']);
    });

    test('库里没传模型时只报脏列、不查库（单测与不连库的复用路径）', async () => {
        const instance = fakeInstance({ loaded: { spirit_stones: '1' }, next: { spirit_stones: 2n } });
        await expect(call(instance, {}, null)).resolves.toEqual(['spirit_stones']);
    });

    test('多列一起脏时两列都判、报错里两列都点名', async () => {
        const instance = fakeInstance({
            loaded: { spirit_stones: '1000', exp: '500' },
            next: { spirit_stones: 1100n, exp: 600n },
            dirty: ['spirit_stones', 'exp']
        });
        await expect(call(instance, {}, fakeModel({ spirit_stones: '900', exp: '500' })))
            .rejects.toMatchObject({ detail: expect.stringMatching(/spirit_stones：.*库里现在却是 900/) });
        // exp 没被动过：不该出现在冲突清单里（否则报错会把人往错的方向带）
        await expect(call(instance, {}, fakeModel({ spirit_stones: '900', exp: '500' })))
            .rejects.not.toThrow(/exp：/);
    });
});

describe('两档强度', () => {
    test('默认档：钱与积分硬拦，气血灵力只观察', () => {
        const saved = { ...process.env };
        try {
            delete process.env.PLAYER_NUMERIC_GUARD;
            delete process.env.PLAYER_VITAL_GUARD;
            expect(modes()).toEqual({ wallet: 'throw', vital: 'warn' });
            process.env.PLAYER_NUMERIC_GUARD = 'warn';
            process.env.PLAYER_VITAL_GUARD = 'throw';
            expect(modes()).toEqual({ wallet: 'warn', vital: 'throw' });
            process.env.PLAYER_NUMERIC_GUARD = ' nonsense ';
            expect(modes().wallet).toBe('throw');
        } finally {
            process.env = saved;
        }
    });

    test('warn 档：放行但必须响一次，同一个调用点不刷屏；off 档：一次库都不查', async () => {
        resetLogOnce();
        const errors = [];
        const spy = jest.spyOn(console, 'error').mockImplementation(msg => errors.push(String(msg)));
        try {
            const seen = [];
            const instance = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050n } });
            for (let i = 0; i < 3; i++) {
                await assertNumericWriteAllowed(instance,
                    { numericGuardModes: { wallet: 'warn', vital: 'warn' } }, fakeModel({ spirit_stones: '700' }, seen));
            }
            expect(seen).toHaveLength(3);
            const offSeen = [];
            await assertNumericWriteAllowed(instance, { numericGuardModes: ALL_OFF }, fakeModel({ spirit_stones: '700' }, offSeen));
            expect(offSeen).toEqual([]);
        } finally {
            spy.mockRestore();
        }
        const hits = errors.filter(msg => msg.includes('.numericGuard.conflict'));
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('数值列快照已过期');
    });

    test('vital 档的冲突不借 wallet 档的强度：只有气血灵力脏时按 vital 判', async () => {
        const instance = fakeInstance({ loaded: { hp_current: '100' }, next: { hp_current: 1200 } });
        await expect(assertNumericWriteAllowed(instance,
            { numericGuardModes: { wallet: 'throw', vital: 'warn' } }, fakeModel({ hp_current: '50' })))
            .resolves.toEqual(['hp_current']);
    });

    test('掺了钱就按 wallet 判：不能靠一并脏上的 hp_current 逃掉硬拦', async () => {
        const instance = fakeInstance({
            loaded: { hp_current: '100', spirit_stones: '1000' },
            next: { hp_current: 1200, spirit_stones: 1050n },
            dirty: ['hp_current', 'spirit_stones']
        });
        await expect(assertNumericWriteAllowed(instance,
            { numericGuardModes: { wallet: 'throw', vital: 'warn' } },
            fakeModel({ hp_current: '50', spirit_stones: '700' })))
            .rejects.toBeInstanceOf(StaleNumericWriteError);
    });
});

describe('数值归一', () => {
    test('numOf 认 BigInt/整数字符串/整数/小数/带空格，其余一律 null', () => {
        expect(numOf(5n)).toBe(5n);
        expect(numOf('5')).toBe(5n);
        expect(numOf(5)).toBe(5n);
        expect(numOf(' 5 ')).toBe(5n);
        expect(numOf(16.5)).toBe(16.5);
        for (const bad of [null, undefined, '', 'abc', NaN, Infinity, {}]) {
            expect(numOf(bad)).toBeNull();
        }
    });

    test('sameNumber 跨 BigInt/Number/数字字符串比，且认不出 null', () => {
        expect(sameNumber(1000n, 1000)).toBe(true);
        expect(sameNumber(1000n, '1000')).toBe(true);
        expect(sameNumber(16.5, 16.5)).toBe(true);
        expect(sameNumber(16.5, 16.6)).toBe(false);
        expect(sameNumber(null, 5n)).toBe(false);
    });
});

describe('bulk 路径（Player.update）的已知边界：不许有人用绝对值写钱', () => {
    const fs = require('fs');
    const p = require('path');
    const SERVER = p.join(__dirname, '..');
    const DIRS = ['game', 'routes', 'models', 'utils', 'middleware'];

    function jsFiles(dir, out = []) {
        for (const name of fs.readdirSync(dir)) {
            const full = p.join(dir, name);
            if (fs.statSync(full).isDirectory()) jsFiles(full, out);
            else if (name.endsWith('.js')) out.push(full);
        }
        return out;
    }

    /** 取 `Player.update(` 后面那个对象字面量：按括号计数配平（不能一见 `}` 就停 —— 嵌套对象会截断），
     *  顺序是"先去注释、再抹字符串"：注释里常有中文引号与撇号，先抹字符串会把整片代码当成字符串吃掉。
     *  已知近似：字符串里出现 `//`（URL）会让那一行被截一半，代价是"漏判一处新违规"，不是误报。 */
    function bulkUpdateObjects(source) {
        const noComments = source.replace(/\r\n/g, '\n')
            .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
            .replace(/^[ \t]*\/\/.*$/gm, '');
        const flat = noComments.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, m => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);
        const found = [];
        const re = /\bPlayer\.(?:update|bulkUpdate)\s*\(\s*\{/g;
        let m;
        while ((m = re.exec(flat))) {
            const start = flat.indexOf('{', m.index);
            let depth = 0;
            for (let i = start; i < flat.length; i++) {
                if (flat[i] === '{') depth++;
                else if (flat[i] === '}') {
                    depth--;
                    if (depth === 0) { found.push(flat.slice(start, i + 1)); break; }
                }
            }
        }
        return found;
    }

    const COLS = new Set(WALLET_COLUMNS.concat(VITAL_COLUMNS));

    test('检测器认得嵌套与字符串里的花括号（控制跑：漏判形状必须先能判出来）', () => {
        const samples = bulkUpdateObjects(`
            await Player.update({ spirit_stones: 5 }, { where: { id } });
            await Player.update({ exp: 1, nested: { deeper: { x: 1 } }, other: "{" }, { where: { id } });
            await Player.update({ spirit_stones: sequelize.literal('\`spirit_stones\` + 5') }, { where: { id } });
        `);
        expect(samples).toHaveLength(3);
        const absolute = samples.filter(obj => Object.entries(JSONishKeys(obj))
            .filter(([key]) => COLS.has(key))
            .some(([, value]) => !/literal|fn\(|col\(/.test(value)));
        expect(absolute).toHaveLength(2);   // 前两条是绝对值，第三条是列上原子写
    });

    test('生产代码里"绝对值写 players 数值列"的 bulk 写法必须为 0（这条闸现在是满的）', () => {
        const offenders = [];
        for (const dir of DIRS) {
            for (const file of jsFiles(p.join(SERVER, dir))) {
                const rel = p.relative(SERVER, file).replace(/\\/g, '/');
                for (const obj of bulkUpdateObjects(fs.readFileSync(file, 'utf8'))) {
                    for (const [key, value] of Object.entries(JSONishKeys(obj))) {
                        if (COLS.has(key) && !/literal|sequelize\.fn|col\(/.test(value)) {
                            offenders.push(`${rel}: Player.update({${key}: ${value}})`);
                        }
                    }
                }
            }
        }
        // 为什么硬判 0：beforeSave 那道数值守卫管不到 bulk 路径（不触发实例钩子），
        // 绝对值写钱在这里就是无人看管的整值覆盖。要写钱只有两条路：列上 literal 原子写，
        // 或 PlayerStateStore.grantAmount / spendAmount / patchPlayerState({amounts})。
        expect(offenders).toEqual([]);
    });
});

/** 把 `{ a: 1, b: { c: 2 } }` 拆成 {顶层键: 值文本}：只看顶层，值原样留字符串（判"是不是原子写"够用） */
function JSONishKeys(objectLiteral) {
    const inner = objectLiteral.replace(/^\{/, '').replace(/\}$/, '');
    const entries = {};
    let depth = 0, current = '', inString = null;
    const push = () => {
        const match = /^\s*([A-Za-z0-9_$]+)\s*:([\s\S]*)$/.exec(current);
        if (match) entries[match[1]] = match[2].trim();
        current = '';
    };
    for (const ch of inner) {
        if (inString) {
            current += ch;
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; current += ch; continue; }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        if (ch === '}' || ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { push(); continue; }
        current += ch;
    }
    push();
    return entries;
}

describe('锚点：同一列被写两次时盯哪一份', () => {
    const { snapshotNumeric, previousValue: prevOf, LOADED } = require('../game/persistence/numericWriteGuard');
    const Player = require('../models/player');

    /** 现网真实形状（CaveSocialService.treasureHunt）：先扣寻宝手续费、再把借取量加到同一列上。
     *  Sequelize 的 set() 每次赋值都把 _previousDataValues[key] 改成"赋值前内存里那份"
     *  （node_modules/sequelize/lib/model.js:2288），所以第二次赋值之后 previous() 已经不是读出来那份了 ——
     *  拿它当锚点会把一笔正确的写回判成"快照过期"。这条测试同时钉住这个坑与守卫的解法。 */
    function beastOfATx() {
        const instance = Player.build({ id: 9, spirit_stones: '49000', exp: '0' }, { isNewRecord: false });
        snapshotNumeric(instance);
        instance.spirit_stones = 48900n;          // 扣 100 手续费
        instance.spirit_stones = 51350n;          // 再加 2450 借取量
        return instance;
    }

    test('控制跑：Sequelize 自己的 previous() 确实会被第二次赋值改写（不钉住就会重新踩）', () => {
        expect(beastOfATx().previous('spirit_stones')).toBe(48900n);
    });

    test('守卫盯的是"读出来那一份"：两次赋值之后仍然放行（假警报回归）', async () => {
        const instance = beastOfATx();
        expect(prevOf(instance, 'spirit_stones')).toBe('49000');
        // 只盯 spirit_stones 这一笔的判定结果；exp 因为 '0' ≠ 默认值 0 也一并脏了，与本题无关
        await expect(call(instance, {}, fakeModel({ spirit_stones: '49000', exp: '0' })))
            .resolves.toEqual(expect.arrayContaining(['spirit_stones']));
    });

    test('真冲突照样拦得住：锚点没变但库里被别的流程写过', async () => {
        const instance = beastOfATx();
        await expect(call(instance, {}, fakeModel({ spirit_stones: '49100' })))
            .rejects.toMatchObject({ detail: expect.stringMatching(/spirit_stones：.*49000.*库里现在却是 49100/) });
    });

    test('保存成功后锚点跟着刷新：同一实例再写一次不该拿旧值误判', async () => {
        const instance = beastOfATx();
        await call(instance, { fields: ['spirit_stones'], numericGuardModes: { wallet: 'throw', vital: 'throw' } },
            fakeModel({ spirit_stones: '49000' }));
        require('../game/persistence/numericWriteGuard').refreshLoaded(
            instance, { fields: ['spirit_stones'] });
        instance.spirit_stones = 51350n + 100n;
        await expect(call(instance, {}, fakeModel({ spirit_stones: 51350n }))).resolves.toBeDefined();
    });

    test('没记锚点的实例（build 出来没经 afterFind）退回 previous()，不假装知道', async () => {
        const Player2 = require('../models/player');
        const bare = Player2.build({ id: 9, spirit_stones: '49000' }, { isNewRecord: false });
        bare.spirit_stones = 48900n;
        bare.spirit_stones = 51350n;
        expect(bare[LOADED]).toBeUndefined();
        // 退回 previous() 时这一笔会被判过期 —— 这正是"必须挂 afterFind"的理由，钩子漏挂要能被发现
        await expect(call(bare, {}, fakeModel({ spirit_stones: '49000' })))
            .rejects.toBeInstanceOf(StaleNumericWriteError);
    });

    test('afterFind / afterSave / afterCreate 三个钩子都挂在模型上（少一个就有实例没有锚点）', () => {
        const hooks = Player.options.hooks || {};
        for (const name of ['afterFind', 'afterSave', 'afterCreate']) {
            expect([].concat(hooks[name] || []).length).toBeGreaterThan(0);
        }
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '../models/player.js'), 'utf-8');
        expect(source).toMatch(/rememberLoaded\(rows\)/);
        expect(source).toMatch(/refreshLoaded\(instance, options\)/);
    });
});

describe('第二张表吃同一套机制：spirit_beasts 的 exp/loyalty/stamina', () => {
    const { createNumericWriteGuard, guardFor, allGuards } = require('../game/persistence/numericWriteGuard');
    // 灵兽那一套的登记点在模型文件里（列名跟着表走），require 它才会有这个守卫 —— 先钉住这个事实
    require('../models/spiritBeast');
    const BEAST_MODES = { wallet: 'throw', vital: 'off' };

    test('灵兽守卫已登记，列名分档正确', () => {
        const g = guardFor('spirit_beasts');
        expect(g).toBeTruthy();
        expect(g.wallet).toEqual(['exp', 'loyalty', 'stamina']);
        expect(g.vital).toEqual(['star_level', 'level', 'hp_max', 'atk', 'def', 'speed']);
        expect(allGuards().map(x => x.label)).toEqual(expect.arrayContaining(['players', 'spirit_beasts']));
    });

    test('灵兽默认档：wallet=throw（10 条吃灵兽的探针实测 0 冲突后抬上来的）、vital=off（按公式整值重设那一类不参与）', () => {
        const saved = { ...process.env };
        try {
            delete process.env.BEAST_NUMERIC_GUARD;
            delete process.env.BEAST_VITAL_GUARD;
            expect(guardFor('spirit_beasts').modes()).toEqual({ wallet: 'throw', vital: 'off' });
        } finally {
            process.env = saved;
        }
    });

    test('读库时不许顺手要 state_version —— 那是 players 的版本列，灵兽表上没有（写了就是 SQL 报错）', async () => {
        const seen = [];
        const model = {
            async findByPk(id, options) {
                seen.push(options);
                return { getDataValue: key => (key === 'exp' ? '500' : undefined) };
            }
        };
        await guardFor('spirit_beasts').assertWriteAllowed(
            fakeInstance({ loaded: { exp: '500' }, next: { exp: 600n } }),
            { numericGuardModes: BEAST_MODES }, model);
        expect(seen[0].attributes).toEqual(['exp']);
    });

    test('同一套判定搬到灵兽行上：被人写过就拒，没动过就放行', async () => {
        const g = guardFor('spirit_beasts');
        const modelWith = exp => ({ async findByPk() { return { getDataValue: key => (key === 'exp' ? exp : undefined) }; } });
        await expect(g.assertWriteAllowed(
            fakeInstance({ loaded: { exp: '500' }, next: { exp: 600n } }), { numericGuardModes: BEAST_MODES }, modelWith('540')))
            .rejects.toMatchObject({
                detail: expect.stringMatching(/spirit_beasts#7 的数值列快照已过期/),
                message: expect.not.stringMatching(/spirit_beasts|exp/)
            });
        await expect(g.assertWriteAllowed(
            fakeInstance({ loaded: { exp: '540' }, next: { exp: 640n } }), { numericGuardModes: BEAST_MODES }, modelWith('540')))
            .resolves.toEqual(['exp']);
    });

    test('钩子挂在灵兽模型上，且 players 的钩子里不许混挂（一次保存判两遍、还会拿错列名）', () => {
        const SpiritBeast = require('../models/spiritBeast');
        const hooks = SpiritBeast.options.hooks || {};
        for (const name of ['beforeSave', 'afterFind', 'afterSave', 'afterCreate']) {
            expect([].concat(hooks[name] || []).length).toBeGreaterThan(0);
        }
        const fs = require('fs');
        const path = require('path');
        const playerSource = fs.readFileSync(path.join(__dirname, '../models/player.js'), 'utf-8');
        expect(playerSource).not.toMatch(/spirit_beasts|BEAST_GUARD/);
    });

    test('工厂的默认强度属于工厂：新接一张表默认就是 wallet=throw / vital=warn', () => {
        const saved = { ...process.env };
        try {
            delete process.env.WALLET_PROBE_TABLE_GUARD;
            delete process.env.VITAL_PROBE_TABLE_GUARD;
            expect(createNumericWriteGuard({ label: 'probe_table', wallet: ['count'], vital: ['hp'] }).modes())
                .toEqual({ wallet: 'throw', vital: 'warn' });
        } finally {
            process.env = saved;
        }
    });
});

describe('守卫确实挂在 players 的保存路径上', () => {
    test('beforeSave 里 await 了它，并且把 Player 自己传进去（漏一个参数=判定静默失效）', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '../models/player.js'), 'utf-8');
        expect(source).toMatch(/assertNumericWriteAllowed\(\s*instance,\s*options,\s*Player\s*\)/);
        expect(source).toMatch(/await\s+assertNumericWriteAllowed/);
    });

    test('钩子跑的是真守卫：把 Player.findByPk 换成"库里已经变了"，保存就该被拒', async () => {
        const Player = require('../models/player');
        const hook = [].concat(Player.options.hooks.beforeSave).pop();
        const original = Player.findByPk;
        const db = { spirit_stones: '700', state_version: '1' };
        Player.findByPk = async () => ({ getDataValue: key => db[key] });
        try {
            const instance = fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050n } });
            await expect(hook(instance, {})).rejects.toBeInstanceOf(StaleNumericWriteError);
            // 同一份假库，换成"库里没动"的写回就必须放行（钩子写成无条件抛也要能被发现）
            const fresh = fakeInstance({ loaded: { spirit_stones: '700' }, next: { spirit_stones: 750n } });
            await expect(hook(fresh, {})).resolves.toBeUndefined();
        } finally {
            Player.findByPk = original;
        }
    });
});

describe('判定计数：一句"没红"必须能换算成"判过几次、判的是哪一列"', () => {
    const { statsSummary, resetAllStats, guardFor } = require('../game/persistence/numericWriteGuard');
    const players = () => statsSummary().find(s => s.label === 'players');

    test('合法写回计数 checks 与列名，冲突写回额外计 conflicts/rejected', async () => {
        resetAllStats();
        expect(players().checks).toBe(0);

        // 两笔干净的写回，各脏两列（钱 + 气血）：判定次数 = 2 次调用 × 2 列
        for (let i = 0; i < 2; i++) {
            await call(fakeInstance({
                loaded: { spirit_stones: '1000', hp_current: '500' },
                next: { spirit_stones: 1050, hp_current: 520 }
            }), {}, fakeModel({ spirit_stones: '1000', hp_current: '500' }));
        }
        expect(players()).toMatchObject({ checks: 4, dbReads: 2, conflicts: 0, rejected: 0 });
        expect(players().byColumn).toEqual({ spirit_stones: 2, hp_current: 2 });

        await expect(call(
            fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050 } }),
            {}, fakeModel({ spirit_stones: '700' })
        )).rejects.toBeInstanceOf(StaleNumericWriteError);
        expect(players()).toMatchObject({ checks: 5, conflicts: 1, rejected: 1, warned: 0 });
        expect(players().conflictByColumn).toEqual({ spirit_stones: 1 });

        resetAllStats();
        expect(players().checks).toBe(0);
        expect(players().conflictByColumn).toEqual({});
    });

    test('控制跑：档位调成 off 时一次都不判（否则上一条计数只是在无条件 ++，证明不了任何事）', async () => {
        resetAllStats();
        await call(fakeInstance({ loaded: { spirit_stones: '1000' }, next: { spirit_stones: 1050 } }),
            { numericGuardModes: ALL_OFF }, fakeModel({ spirit_stones: '700' }));
        expect(players()).toMatchObject({ checks: 0, dbReads: 0, conflicts: 0 });
        // 每张登记的表都要出现在汇总里（灵兽表漏了统计 = 以后压它的档时看不见覆盖）
        expect(statsSummary().map(s => s.label).sort()).toEqual(['players', 'spirit_beasts']);
        expect(guardFor('spirit_beasts').stats().modes.vital).toBe('off');   // 灵兽属性档今天还是观察态，别以为已经硬拦了
    });
});

describe('并发冲突的错误出口：409 + 一句人话，细节进日志', () => {
    const { errorHandler, ErrorCodes } = require('../middleware/errorHandler');
    const { StaleNumericWriteError } = require('../game/persistence/numericWriteGuard');

    function fakeRes() {
        const res = { body: null, status: 200 };
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.body = payload; return res; };
        return res;
    }

    test('守卫的错误码与 ErrorCodes 同源，且全局处理器回 409 + 玩家可读那句', () => {
        const err = new StaleNumericWriteError('这一步没有赶上：请后再试一次。', 'players#7 的数值列快照已过期（spirit_stones…）');
        expect(ErrorCodes.CONCURRENT_UPDATE).toBe(err.errorCode);    // 两边名字漂移过就红
        const res = fakeRes();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        let logged = '';
        try {
            errorHandler(err, {}, res, () => {});
            // 要先取走 calls：spyOn 的 mockRestore() 会连记录一起清掉（先 restore 再断言=恒空，看着像"日志没打"）
            logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
        } finally { warn.mockRestore(); }
        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({ code: 409, error_code: 'CONCURRENT_UPDATE', message: err.message });
        expect(JSON.stringify(res.body)).not.toMatch(/spirit_stones|players#/);   // 响应体里不许有内部名字
        expect(logged).toMatch(/spirit_stones/);                                    // 但日志里必须查得到细节
    });

    test('控制跑：同一条处理器对普通错误仍然回 500 + 通用文案（别把 409 做成万能通道）', () => {
        const res = fakeRes();
        const err = new Error('connect ECONNREFUSED 内部细节');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            errorHandler(err, {}, res, () => {});
        } finally { errorSpy.mockRestore(); }
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('服务器错误');
        expect(res.body.message).not.toMatch(/ECONNREFUSED/);
    });
});
