# 玩家状态自愈体系

## 目录说明

本目录实现"玩家状态自愈体系"，解决玩家非正常退出（关浏览器/断网/服务重启/双开 tab）导致状态卡死的问题。

| 文件/目录 | 作用 |
|---|---|
| `StateRegistry.js` | 状态注册中心（单例），存储所有玩法的状态处理器 |
| `PlayerStateMachine.js` | 玩家状态机，统一执行状态互斥校验 |
| `index.js` | 入口文件，调用 `registerAllStates()` 注册所有玩法状态 |
| `registrations/` | 各玩法状态注册文件（闭关/战斗/历练/移动/封禁） |

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server/index.js                          │
│  启动时调用 registerAllStates() + StateCleanerService.start() │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              game/state/index.js                             │
│  registerAllStates() 统一注册所有玩法状态处理器                │
└────────────────┬────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌──────────────┐  ┌──────────────────┐
│ StateRegistry│  │ registrations/   │
│  (注册中心)   │◄─┤ seclusion.js     │
│              │  │ combat.js        │
│  register()  │  │ adventure.js     │
│  list()      │  │ moving.js        │
│  mapAll()    │  │ ban.js           │
└──────┬───────┘  └──────────────────┘
       │
       │ 遍历调度
       ├──────────────────────┐
       ▼                      ▼
┌──────────────┐      ┌──────────────────┐
│StateCleaner  │      │PlayerStateService│
│Service       │      │                  │
│              │      │ getStateSnapshot │
│ cleanExpired │      │ getActiveStates  │
│ getMetrics   │      │                  │
│ start        │      └────────┬─────────┘
└──────┬───────┘               │
       │                       ▼
       │              ┌──────────────────┐
       │              │PlayerStateMachine│
       │              │                  │
       │              │ canStart         │
       │              │ getActiveStates  │
       │              │ getStateSummary  │
       │              └────────┬─────────┘
       │                       │
       ▼                       ▼
┌──────────────────────────────────────────┐
│  各 route 在"开始 X"前调用 canStart 校验   │
│  - routes/seclusion.js (开始闭关)         │
│  - routes/combat.js (遭遇怪物)            │
│  - routes/map.js (开始移动/历练)          │
└──────────────────────────────────────────┘
```

## 新增玩法如何接入

新增一个玩法（如"炼丹"）需要自愈能力时，只需 3 步：

### 第 1 步：创建注册文件

新建 `server/game/state/registrations/alchemy.js`：

```javascript
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const PlayerAlchemy = require('../../../models/playerAlchemy');  // 假设的炼丹记录表
const { Op } = require('sequelize');

function registerAlchemyState() {
    StateRegistry.register('alchemy', {
        metadata: {
            displayName: '炼丹',
            stateEnum: 'ALCHEMING',  // 新状态枚举（需在 PlayerStateMachine.PlayerState 中扩展）
            exclusive: true
        },

        // 1. 获取状态快照（供 /player/state 接口和 Socket 重连推送）
        async getSnapshot(playerId) {
            const snapshot = { is_alcheming: false };
            const alchemy = await PlayerAlchemy.findOne({
                where: { player_id: playerId, status: 'in_progress' }
            });
            if (!alchemy) return snapshot;
            return {
                is_alcheming: true,
                alchemy_id: alchemy.id,
                recipe: alchemy.recipe,
                start_time: alchemy.start_time,
                end_time: alchemy.end_time,
                remaining_seconds: Math.max(0, Math.floor((new Date(alchemy.end_time) - Date.now()) / 1000))
            };
        },

        // 2. 获取激活状态枚举（供状态机互斥校验）
        async getActiveState(playerId) {
            const alchemy = await PlayerAlchemy.findOne({
                where: { player_id: playerId, status: 'in_progress' },
                attributes: ['id']
            });
            return alchemy ? 'ALCHEMING' : null;
        },

        // 3. 清理过期状态（供 StateCleanerService 定时调度）
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            const expired = await PlayerAlchemy.findAll({
                where: { status: 'in_progress', end_time: { [Op.lt]: now } },
                limit: batchSize
            });
            stats.scanned = expired.length;

            for (const alchemy of expired) {
                try {
                    // 结算炼丹结果...
                    alchemy.status = 'completed';
                    await alchemy.save();
                    stats.settled += 1;

                    // 推送通知给在线玩家
                    if (ctx.notify) {
                        ctx.notify(alchemy.player_id, 'alchemy_completed', { alchemy_id: alchemy.id });
                    }
                } catch (err) {
                    stats.failed += 1;
                }
            }
            return stats;
        },

        // 4. 状态转移校验（可选，默认走 exclusive 互斥规则）
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '炼丹中，无法开始此操作' };
        }
    });
}

module.exports = registerAlchemyState;
```

### 第 2 步：在入口注册

编辑 `server/game/state/index.js`，添加一行：

```javascript
function registerAllStates() {
    // ...existing registrations...
    require('./registrations/alchemy')();  // 新增这一行
}
```

### 第 3 步：在 route 中调用状态机校验

在 `server/routes/alchemy.js`（开始炼丹的接口）中：

```javascript
const PlayerStateMachine = require('../game/state/PlayerStateMachine');

router.post('/start', auth, async (req, res) => {
    // 状态机互斥校验：炼丹与其他 exclusive 状态互斥
    const stateCheck = await PlayerStateMachine.canStart(req.user.id, 'ALCHEMING');
    if (!stateCheck.allowed) {
        return res.status(400).json({ code: 400, message: stateCheck.reason });
    }
    // ...开始炼丁的业务逻辑...
});
```

### 完成！自动获得的能力

接入后，新玩法自动获得：

| 能力 | 实现方 | 说明 |
|---|---|---|
| 过期自动结算 | StateCleanerService | 每 60 秒扫描，过期自动调用 cleanExpired |
| Socket 重连恢复 | PlayerStateService + WebSocketNotificationService | 重连时推送 state:snapshot，包含炼丹状态 |
| 状态互斥校验 | PlayerStateMachine | 炼丹中无法开始战斗/闭关/移动，反之亦然 |
| 聚合状态查询 | GET /api/player/state | 一次性返回所有进行中状态，包含炼丹 |
| 监控指标 | GET /api/admin/state-cleaner/metrics | 监控数据中自动包含炼丹清理统计 |

**无需修改 StateCleanerService / PlayerStateService / PlayerStateMachine 任何代码！**

## 状态枚举约定

| 枚举值 | 含义 | 互斥 |
|---|---|---|
| `IDLE` | 空闲（无任何进行中状态） | - |
| `SECLUDED` | 闭关中 | 是 |
| `IN_BATTLE` | 战斗中 | 是 |
| `ADVENTURING` | 历练中 | 是 |
| `MOVING` | 移动中 | 是 |
| `BANNED` | 封禁中（特殊，禁止一切新状态） | 否（可与其它共存） |
| `ALCHEMING` | 炼丹中（示例新增） | 是 |

新增玩法的状态枚举在 `PlayerStateMachine.PlayerState` 中扩展，或在注册文件中直接使用字符串。

## 配置项

`server/config/game_balance.json` 中的 `state_cleaner` 配置：

```json
{
  "state_cleaner": {
    "enable": true,
    "batch_size": 100,
    "seclusion": { "enable": true, "auto_settle": true, "log_each": false },
    "combat": { "enable": true, "auto_settle": false },
    "adventure": { "enable": true, "auto_complete": false },
    "ban": { "enable": true },
    "alchemy": { "enable": true }  // 新增玩法的配置项
  }
}
```

每个玩法可通过 `enable: false` 单独禁用清理，不影响其他玩法。
