/**
 * 灵兽放养/偷菜的锁顺序契约（2026-09-20）
 *
 * BeastPastureService 用 save() 整行写回放养记录与灵兽行，这类写只有在"本事务已经拿到该行锁"时
 * 才安全。之前的形状是：stealCrops 先锁灵兽、**无锁**读放养记录然后整行写回；recallBeast 先锁放养
 * 记录再锁灵兽 —— 两把锁顺序相反。真库并发实测（scripts/smoke_pasture_race.js）10 轮里 10 轮
 * 报 "Deadlock found when trying to get lock"，玩家侧表现是召回 500、灵兽 is_pasturing 卡死。
 *
 * 本套件全程 mock，钉的是**代码顺序**：每条写路径的加锁读序列必须是
 *   SpiritBeast → SpiritBeastPasture → PlayerGarden
 * 且每一次整行 save() 的宿主行都必须来自它前面那次带 lock 的读取。
 * 行锁本身是否生效由 smoke_pasture_race.js 在真库上验，两者缺一。
 */
'use strict';

const LOCK = 'UPDATE';

/** 顺序轨迹：reads 记录每一次读取（含是否带锁），writes 记录每一次整行 save() */
let reads;
let writes;

function resetTrace() {
    reads = [];
    writes = [];
}
resetTrace();

/**
 * 造一个"表行"。key 用来把写回和它对应的那次读取对上（同模型不同行不能混为一谈）。
 */
function makeRow(key, fields = {}) {
    return {
        ...fields,
        __key: key,
        save: jest.fn(async (opts = {}) => {
            writes.push({ key, locked: !!opts.transaction?.__lockedReads?.includes(key) });
        })
    };
}

/** 带锁读：记一笔 lock=true 的读取，并把该 key 登记进事务的"已持锁"集合 */
function lockedRead(model, op, key, row, transaction) {
    reads.push({ model, op, locked: true });
    if (transaction && Array.isArray(transaction.__lockedReads) && !transaction.__lockedReads.includes(key)) {
        transaction.__lockedReads.push(key);
    }
    return row;
}

function plainRead(model, op, key, row) {
    reads.push({ model, op, locked: false });
    return row;
}

jest.mock('../config/database', () => {
    const db = {
        transaction: jest.fn(async () => {
            const t = {
                LOCK: { UPDATE: 'UPDATE' },
                __lockedReads: [],
                finished: false,
                commit: jest.fn(async () => { t.finished = true; }),
                rollback: jest.fn(async () => { t.finished = true; })
            };
            db.__lastTransaction = t;
            return t;
        }),
        __lastTransaction: null,
        query: jest.fn(async () => [])
    };
    return db;
});

jest.mock('../modules', () => {
    const config = require('../config/spirit_beast_pasture_data.json');
    return { infrastructure: { ConfigLoader: { getConfig: name => (name === 'spirit_beast_pasture_data' ? config : null) } } };
});

jest.mock('../models/player', () => ({ findByPk: jest.fn(), findOne: jest.fn() }));

jest.mock('../models/spiritBeast', () => ({
    findByPk: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn()
}));

jest.mock('../models/spiritBeastPasture', () => ({
    findByPk: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
}));

jest.mock('../models/gardenStealLog', () => ({
    findOne: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    findAndCountAll: jest.fn()
}));

jest.mock('../models/playerGarden', () => ({ findOne: jest.fn(), findAll: jest.fn() }));

jest.mock('../game/services/GardenService', () => ({ _refreshMatureStatus: jest.fn(async () => {}) }));

jest.mock('../game/services/WebSocketNotificationService', () => ({
    notifyPlayerUpdate: jest.fn(),
    broadcastToRoom: jest.fn()
}));

jest.mock('../game/services/InventoryService', () => ({ addItem: jest.fn(async () => ({})) }));

const sequelize = require('../config/database');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const SpiritBeastPasture = require('../models/spiritBeastPasture');
const GardenStealLog = require('../models/gardenStealLog');
const PlayerGarden = require('../models/playerGarden');
const pastureService = require('../game/services/BeastPastureService');
const { infrastructure } = require('../modules');

pastureService.initialize(infrastructure.ConfigLoader);

const THIEF = { id: 11, realm_rank: 40, nickname: '偷菜的' };
const VICTIM = { id: 22, realm_rank: 40, nickname: '种药的' };
const BEAST_ID = 101;
const PASTURE_ID = 201;

function thiefBeast() {
    return makeRow('SpiritBeast.findByPk', {
        id: BEAST_ID,
        player_id: THIEF.id,
        beast_key: 'qingyun_wolf',
        element: 'metal',
        rarity: 'rare',
        star_level: 10,
        level: 10,
        exp: '0',
        hp_max: '5000',
        atk: 100,
        def: 100,
        speed: 300,
        loyalty: 100,
        is_active: false,
        is_pasturing: true
    });
}

function pastureRow() {
    return makeRow('SpiritBeastPasture.findOne', {
        id: PASTURE_ID,
        beast_id: BEAST_ID,
        player_id: THIEF.id,
        location_key: 'qingyun_mountain',
        location_name: '青云山',
        beast_snapshot: { beast_name: '青狼' },
        status: 'active',
        recall_type: null,
        steal_count: 0,
        stolen_count: 0,
        steal_yields: [],
        yield_snapshot: null,
        yield_discount: 1,
        start_time: new Date(Date.now() - 3600 * 1000),
        end_time: new Date(Date.now() + 3600 * 1000),
        actual_end_time: null
    });
}

function maturePlot() {
    return makeRow('PlayerGarden.findOne', {
        id: 301,
        player_id: VICTIM.id,
        plot_index: 1,
        seed_id: 'spirit_seed',
        produce_item_id: 'wild_herb',
        status: 'mature',
        base_yield: 9
    });
}

/** 装配合谋：一次"能被锁读出来的"灵兽/放养记录/地块，以及无锁的辅助读取 */
function wireHappyPath() {
    const beast = thiefBeast();
    const pasture = pastureRow();
    const plot = maturePlot();

    SpiritBeast.findByPk.mockImplementation(async (id, opts = {}) => {
        if (!opts.lock) return plainRead('SpiritBeast', 'findByPk', 'SpiritBeast.findByPk', beast);
        return lockedRead('SpiritBeast', 'findByPk', 'SpiritBeast.findByPk', beast, opts.transaction);
    });
    // 护院灵兽：被偷方没有出战灵兽，偷菜必然成功（成功率 >1），结果可复现
    SpiritBeast.findOne.mockResolvedValue(null);
    SpiritBeastPasture.findOne.mockImplementation(async (opts = {}) => {
        if (!opts.lock) return plainRead('SpiritBeastPasture', 'findOne', 'SpiritBeastPasture.findOne', pasture);
        return lockedRead('SpiritBeastPasture', 'findOne', 'SpiritBeastPasture.findOne', pasture, opts.transaction);
    });
    PlayerGarden.findOne.mockImplementation(async (opts = {}) => {
        if (!opts.lock) return plainRead('PlayerGarden', 'findOne', 'PlayerGarden.findOne', plot);
        return lockedRead('PlayerGarden', 'findOne', 'PlayerGarden.findOne', plot, opts.transaction);
    });
    GardenStealLog.findOne.mockResolvedValue(null);
    GardenStealLog.count.mockResolvedValue(0);
    GardenStealLog.create.mockResolvedValue(makeRow('GardenStealLog.create', { id: 401 }));
    Player.findByPk.mockResolvedValue(VICTIM);
    return { beast, pasture, plot };
}

/** 每次整行 save() 都必须由"该行的最近一次读取是带锁读"支撑（makeRow 在 save 时核对事务的持锁集合） */
function unguardedWrites() {
    return writes.filter(write => !write.locked);
}

function lockedSequence() {
    return reads.filter(read => read.locked).map(read => read.model);
}

beforeEach(() => {
    jest.clearAllMocks();
    resetTrace();
    sequelize.__lastTransaction = null;
    // jest.clearAllMocks 会抹掉 mockImplementation，重新装配
    wireHappyPath();
});

describe('BeastPastureService 锁顺序契约', () => {
    test('Math.random 归零时偷菜必然成功（探针前提，不是被测行为）', async () => {
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
        wireHappyPath();
        const result = await pastureService.stealCrops(THIEF, BEAST_ID, VICTIM.id, 1);
        spy.mockRestore();
        expect(result.code).toBe(200);
        expect(result.data.result).toBe('success');
    });

    test('stealCrops：先锁灵兽、再锁放养记录、最后锁地块', async () => {
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
        const result = await pastureService.stealCrops(THIEF, BEAST_ID, VICTIM.id, 1);
        spy.mockRestore();

        expect(result.code).toBe(200);
        expect(lockedSequence()).toEqual(['SpiritBeast', 'SpiritBeastPasture', 'PlayerGarden']);
        expect(unguardedWrites()).toEqual([]);
        expect(writes.map(w => w.key)).toEqual([
            'PlayerGarden.findOne',
            'SpiritBeastPasture.findOne',
            'SpiritBeast.findByPk'
        ]);
    });

    test('recallBeast：与偷菜同序（先灵兽后放养记录），不再反序取锁', async () => {
        const result = await pastureService.recallBeast(THIEF, BEAST_ID);

        expect(result.code).toBe(200);
        expect(lockedSequence()).toEqual(['SpiritBeast', 'SpiritBeastPasture']);
        expect(unguardedWrites()).toEqual([]);
        expect(writes.map(w => w.key)).toEqual(['SpiritBeastPasture.findOne', 'SpiritBeast.findByPk']);
    });

    test('checkExpirations：调度器也走同一条锁顺序', async () => {
        const pasture = pastureRow();
        // 调度器先无锁捞候选，再按 id 加锁重读 —— 候选列表本身不能被直接写回
        SpiritBeastPasture.findAll.mockResolvedValue([pasture]);
        SpiritBeastPasture.findByPk.mockImplementation(async (id, opts = {}) =>
            lockedRead('SpiritBeastPasture', 'findByPk', 'SpiritBeastPasture.findOne', pasture, opts.transaction));

        await pastureService.checkExpirations();

        expect(lockedSequence()).toEqual(['SpiritBeast', 'SpiritBeastPasture']);
        expect(unguardedWrites()).toEqual([]);
    });

    test('三条写路径的取锁顺序两两一致（ABBA 的前提）', async () => {
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
        await pastureService.stealCrops(THIEF, BEAST_ID, VICTIM.id, 1);
        const afterSteal = lockedSequence();
        spy.mockRestore();

        resetTrace();
        wireHappyPath();
        await pastureService.recallBeast(THIEF, BEAST_ID);
        const afterRecall = lockedSequence();

        resetTrace();
        wireHappyPath();
        const pasture = pastureRow();
        SpiritBeastPasture.findAll.mockResolvedValue([pasture]);
        SpiritBeastPasture.findByPk.mockImplementation(async (id, opts = {}) =>
            lockedRead('SpiritBeastPasture', 'findByPk', 'SpiritBeastPasture.findOne', pasture, opts.transaction));
        await pastureService.checkExpirations();
        const afterScheduler = lockedSequence();

        expect(afterRecall).toEqual(afterScheduler);
        expect(afterSteal.slice(0, 2)).toEqual(afterRecall);
    });
});
