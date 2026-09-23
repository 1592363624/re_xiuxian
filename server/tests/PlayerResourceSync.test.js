/**
 * 玩家 store 资源局部更新 / 合并刷新 的纯逻辑测试（不连库、不起 Vue）
 *
 * 背景：点修炼会同时触发 HTTP 回包 + Socket player:updated，
 * 旧实现两边都全量 fetchPlayer（/player/me 重算全属性），界面闪、查询翻倍。
 * 现在：绝对余额 patch 幂等；scheduleFetchPlayer 合并去抖。
 */
'use strict';

describe('resource change 归一（绝对值优先，增量兜底）', () => {
    /** 与 stores/player.js applyResourceChanges 同语义的纯函数副本 */
    function applyResourceChanges(player, changes) {
        if (!changes || typeof changes !== 'object' || !player) return { player, touched: false }
        const absKeys = ['spirit_stones', 'mp_current', 'hp_current', 'exp', 'exp_next', 'exp_cap', 'toxicity']
        const patch = {}
        let touched = false
        for (const key of absKeys) {
            if (changes[key] !== undefined && changes[key] !== null) {
                patch[key] = changes[key]
                touched = true
            }
        }
        const bi = (v) => {
            try { return BigInt(v || 0) } catch { return 0n }
        }
        if (patch.spirit_stones === undefined && (changes.spirit_stone_cost !== undefined || changes.spirit_stones_gain !== undefined)) {
            const cur = bi(player.spirit_stones)
            patch.spirit_stones = (cur - bi(changes.spirit_stone_cost) + bi(changes.spirit_stones_gain)).toString()
            touched = true
        }
        if (patch.mp_current === undefined && changes.mp_cost !== undefined) {
            const cur = Number(player.mp_current) || 0
            patch.mp_current = String(Math.max(0, cur - (Number(changes.mp_cost) || 0)))
            touched = true
        }
        if (patch.exp === undefined && changes.exp_gain !== undefined) {
            patch.exp = (bi(player.exp) + bi(changes.exp_gain)).toString()
            touched = true
        }
        return { player: { ...player, ...patch }, touched }
    }

    test('绝对余额直接覆盖，且可幂等重复 patch', () => {
        const p = { spirit_stones: '100', mp_current: '50', exp: '10' }
        const first = applyResourceChanges(p, { spirit_stones: '80', mp_current: '30', exp: '15' })
        expect(first.touched).toBe(true)
        expect(first.player.spirit_stones).toBe('80')
        const second = applyResourceChanges(first.player, { spirit_stones: '80', mp_current: '30', exp: '15' })
        expect(second.player.spirit_stones).toBe('80')
    })

    test('HTTP 回包绝对值 + Socket 增量并存时不双算（绝对值优先）', () => {
        const p = { spirit_stones: '100', exp: '10' }
        // HTTP 先写绝对余额
        const afterHttp = applyResourceChanges(p, { spirit_stones: '70', exp: '20' })
        // Socket 又带增量 —— 因绝对值也在 changes 里，仍以绝对值为准
        const afterSocket = applyResourceChanges(afterHttp.player, {
            spirit_stones: '70', exp: '20',
            spirit_stone_cost: 30, exp_gain: 10
        })
        expect(afterSocket.player.spirit_stones).toBe('70')
        expect(afterSocket.player.exp).toBe('20')
    })

    test('仅有增量键时按增减计算', () => {
        const p = { spirit_stones: '100', mp_current: '50', exp: '1000' }
        const r = applyResourceChanges(p, { spirit_stone_cost: 162, mp_cost: 45001, exp_gain: 5 })
        // 100-162 = -62 → 字符串负值由后端保证不会出现；这里只验算式
        expect(BigInt(r.player.spirit_stones)).toBe(-62n)
        expect(r.player.mp_current).toBe('0') // 灵力钳到 0
        expect(r.player.exp).toBe('1005')
    })

    test('空 changes 不碰玩家对象', () => {
        const p = { exp: '1' }
        expect(applyResourceChanges(p, {}).touched).toBe(false)
        expect(applyResourceChanges(p, null).touched).toBe(false)
    })
})

describe('scheduleFetchPlayer 合并语义', () => {
    test('文档约定：60ms 窗口内多次调用只应触发一次 fetchPlayer（实现在 stores/player.js）', () => {
        // 这里钉住契约，防止后人改回「每事件一次全量」
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', '..', 'client', 'src', 'stores', 'player.js'),
            'utf8'
        )
        expect(src).toMatch(/scheduleFetchPlayer\s*\(/)
        expect(src).toMatch(/_fetchPlayerInflight/)
        expect(src).toMatch(/_fetchPlayerDirty/)
        // 默认路径必须走合并刷新，而不是每个 Socket 事件 await fetchPlayer
        expect(src).toMatch(/if \(needFull\)[\s\S]{0,80}scheduleFetchPlayer/)
        // 资源事件优先本地 patch
        expect(src).toMatch(/applyResourceChanges/)
    })
})
