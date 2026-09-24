/**
 * 系统任务「尘缘指归」
 *
 * 钉住：
 *   · 内容自检（动作/状态词表、卷内 order）
 *   · 自动发放第一环
 *   · 完成当前环 → 自动发奖 → 自动续环
 *   · AND / OR / or_group 判定
 *   · 老号 state 追认快进
 *   · 发奖失败不推进
 */
'use strict';

const path = require('path');

const mockGrant = {
    granted: [],
    failed: []
};
const mockPlayers = new Map();
const mockRows = new Map();

jest.mock('../game/items/itemGrant', () => ({
    grantItems: jest.fn(async () => ({
        granted: [...mockGrant.granted],
        failed: [...mockGrant.failed]
    })),
    describeGrant: jest.fn((granted) => ({
        text: (granted || []).map(g => `${g.item_key}x${g.quantity}`).join('、'),
        allFailed: false
    }))
}));

jest.mock('../game/items/itemNaming', () => ({
    itemName: (k) => (k === 'low_healing_pill' ? '低阶回血丹' : k)
}));

jest.mock('../game/persistence/PlayerStateStore', () => ({
    addTitleToInstance: jest.fn(() => true)
}));

jest.mock('../game/services/WebSocketNotificationService', () => ({
    notifyPlayerUpdate: jest.fn(),
    sendToPlayer: jest.fn()
}));

jest.mock('../models/player', () => ({
    findByPk: jest.fn(async (id) => mockPlayers.get(Number(id)) || null)
}));

jest.mock('../models/playerSystemQuest', () => ({
    findOne: jest.fn(async ({ where }) => {
        const key = `${where.player_id}:${where.chain_id}`;
        return mockRows.get(key) || null;
    }),
    create: jest.fn(async (data) => {
        const key = `${data.player_id}:${data.chain_id}`;
        const row = {
            ...data,
            id: mockRows.size + 1,
            save: async function () { mockRows.set(key, this); return this; }
        };
        mockRows.set(key, row);
        return row;
    })
}));

jest.mock('../models/playerCave', () => ({ findOne: jest.fn(async () => null), count: jest.fn(async () => 0) }));
jest.mock('../models/spiritBeast', () => ({ count: jest.fn(async () => 0) }));
jest.mock('../models/playerSect', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../models/playerTaoismGate', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../models/playerLaw', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../models/playerEquipment', () => ({ count: jest.fn(async () => 0) }));
jest.mock('../models/playerArtifactSpirit', () => ({ count: jest.fn(async () => 0) }));
jest.mock('../models/playerAchievement', () => ({ count: jest.fn(async () => 0) }));

jest.mock('../config/database', () => ({
    transaction: async (cb) => {
        const t = { LOCK: { UPDATE: 'UPDATE' }, finished: false };
        return cb(t);
    }
}));

const SystemQuestService = require('../game/services/SystemQuestService');
const { grantItems } = require('../game/items/itemGrant');

function makePlayer(id, extra = {}) {
    const p = {
        id,
        spirit_stones: 0,
        exp: 0,
        realm: '凡人',
        attributes: '{}',
        stats: '{}',
        save: async () => p,
        get() { return this; },
        ...extra
    };
    mockPlayers.set(id, p);
    return p;
}

beforeEach(() => {
    mockPlayers.clear();
    mockRows.clear();
    mockGrant.granted = [{ item_key: 'low_healing_pill', quantity: 2 }];
    mockGrant.failed = [];
    grantItems.mockClear();
    const path = require('path');
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'system_quest_data.json'), 'utf8'));
    const titles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'titles.json'), 'utf8'));
    const loader = {
        getConfig(name) {
            if (name === 'system_quest_data') return raw;
            if (name === 'titles') return titles;
            return {};
        }
    };
    SystemQuestService.initialize(loader);
    SystemQuestService.assertContent();
});

describe('尘缘指归 · 内容与链路', () => {
    test('内容自检通过，19 环、三卷', () => {
        const cfg = SystemQuestService.getConfig();
        expect(cfg.nodes.length).toBe(19);
        expect(cfg.acts.length).toBe(3);
        expect(cfg.chain.id).toBe('zhigui');
    });

    test('首次 ensure 自动发放第一环', async () => {
        const p = makePlayer(1);
        const { row, advanced } = await SystemQuestService.ensureChain(1);
        expect(row.current_node_id).toBe('zhigui_s1_open_eyes');
        expect(row.status).toBe('active');
        expect(advanced.length).toBe(0);
    });

    test('onAction 达成后自动发奖并续环', async () => {
        const p = makePlayer(2);
        await SystemQuestService.ensureChain(2);
        const result = await SystemQuestService.onAction(2, 'view_player_status');
        expect(result.advanced.length).toBe(1);
        expect(result.advanced[0].node_id).toBe('zhigui_s1_open_eyes');
        expect(result.advanced[0].reward.next_node_id).toBe('zhigui_s1_first_breath');
        expect(Number(p.spirit_stones)).toBe(50);
        expect(grantItems).toHaveBeenCalled();
    });

    test('OR 目标：采集或炼丹任一即可', async () => {
        makePlayer(3);
        await SystemQuestService.ensureChain(3);
        // 一路推到 s2_herb_or_fire
        const seq = [
            'view_player_status', 'settle_cultivate', 'use_item', 'pve_win', 'map_move',
            'choose_taoism_gate', 'join_sect', 'sect_check_in', 'sect_transfer'
        ];
        for (const a of seq) await SystemQuestService.onAction(3, a);
        const mid = await SystemQuestService.getCurrent(3);
        expect(mid.current_node_id).toBe('zhigui_s2_herb_or_fire');
        const r = await SystemQuestService.onAction(3, 'gather_complete');
        expect(r.advanced.length).toBe(1);
        expect(r.advanced[0].name).toBe('百草入药');
    });

    test('老号 has_cave 状态追认快进', async () => {
        makePlayer(4);
        const cave = require('../models/playerCave');
        const seq = [
            'view_player_status', 'settle_cultivate', 'use_item', 'pve_win', 'map_move',
            'choose_taoism_gate', 'join_sect', 'sect_check_in', 'sect_transfer', 'alchemy_success'
        ];
        await SystemQuestService.ensureChain(4);
        for (const a of seq) await SystemQuestService.onAction(4, a);
        const before = await SystemQuestService.getCurrent(4);
        expect(before.current_node_id).toBe('zhigui_s2_open_cave');
        // 此刻再满足 has_cave：打开面板触发 ensure → 追认快进
        cave.findOne.mockResolvedValue({ is_opened: true, spirit_vein_level: 1 });
        const board = await SystemQuestService.getBoard(4);
        expect(board.nodes.find(n => n.id === 'zhigui_s2_open_cave').state).toBe('done');
    });

    test('发奖失败（背包满）不半发、不推进，面板仍可打开', async () => {
        makePlayer(5);
        await SystemQuestService.ensureChain(5);
        mockGrant.granted = [];
        mockGrant.failed = [{ item_key: 'low_healing_pill', quantity: 2, reason: '背包满' }];
        const r = await SystemQuestService.onAction(5, 'view_player_status');
        // 推进事务整笔回滚 → onAction 吞错返回 null；动作计数已独立落库
        expect(r).toBeNull();
        const cur = await SystemQuestService.getCurrent(5);
        expect(cur.current_node_id).toBe('zhigui_s1_open_eyes');
        // 面板仍能打开，且带上 grant_error
        const board = await SystemQuestService.getBoard(5);
        expect(board.current_node_id).toBe('zhigui_s1_open_eyes');
        expect(String(board.grant_error || '')).toMatch(/背包放不下/);
    });

    test('卷三含 state 追认回退，不会只靠动作卡死', () => {
        const cfg = SystemQuestService.getConfig();
        const s3 = cfg.nodes.filter(n => n.act === 3);
        for (const n of s3.slice(0, 6)) {
            const hasState = JSON.stringify(n.objectives).includes('"type":"state"');
            const hasOr = n.logic === 'or' || JSON.stringify(n.objectives).includes('or_group');
            expect(hasState || hasOr).toBe(true);
        }
    });

    test('未登记动作忽略', async () => {
        makePlayer(6);
        await SystemQuestService.ensureChain(6);
        const r = await SystemQuestService.onAction(6, 'not_a_real_action');
        expect(r).toBeNull();
    });
});
