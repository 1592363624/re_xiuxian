---
feature: zhigui-system-quest
status: delivered
updated: 2026-09-24
branch: main
commits: e827b849..5b51f15b
---

# 尘缘指归 · 系统任务

## Report

**What was built** — 独立系统任务类型「尘缘指归」：一条线性链、三卷 19 环（识途教程 / 立心主线 / 破障进阶）。建号或首次打开面板自动发放第一环；条件满足即在事务内发奖并自动续环，无手动领取。内容写在 `system_quest_data.json`，环名与正文按修仙语汇组织，目标覆盖角色面板、异步修炼结算、品阶消耗品、PVE、地图、道途、宗门日课、采集/炼丹双路径、洞府、突破、市井、法宝器灵、灵兽结契、神识、大衍/问道、世界事件/试炼塔、法则/香火与终章称号「已识归途」。老号按 state/metric 追认快进。全栈落地：模型+迁移、`SystemQuestService`（双事务防半发）、`/api/system-quest/*`、业务成功点 `zhiguiHooks` 上报、前端「指归」面板。

**Verification** — `npm test -- SystemQuestZhigui --runInBand`：PASS 8/8。`npm test -- AchievementRewardShape PlayerMetricsVocabulary --runInBand`：PASS 61/61。`assertContent()` 19 环通过。`node --check` 干净。独立评审两轮：第一轮 2 critical 已修，复审 3 critical 全 FIXED、无新 critical。

**Journey log** — ① `grantItems` 非原子：失败必须抛出外层事务才整笔回滚；内层 swallow 会半发。② 线性链「动作」目标必须配 state 追认回退，否则未接线动作会卡死。③ `zhiguiHooks` 用 `setImmediate` 延后，避开未 commit 事务。④ 建行放事务外（同 AchievementService）。⑤ 沙箱禁 `git worktree add`，经确认直接在 main 实现。

## [S1] Problem

玩家建号后缺少一条「系统级」的引路任务：现有宗门悬赏、道途日常、成就都是并行目标池或长线收藏，没有

1. 自动发放的**第一条**任务；
2. 线性推进、完成当前环**自动发奖并自动接到下一环**；
3. 按「学会基本操作 → 接到核心目标 → 引入新机制」三阶段组织的**有剧情与玩法深度**的内容（不是换皮的「杀 10 只怪」）。

需要一个独立任务类型，从建号起跟到玩家站稳脚跟，名字与内容都有修仙味，且每一环真正教会一个机制。

## [S2] Design

### [S2.1] 任务类型与包装

| 项 | 定案 |
|---|---|
| 类型名 | **尘缘指归**（界面简称「指归」） |
| 载体 | 识海中一枚来历不明的《指归玉简》 |
| 结构 | **一条独立线性链**，内分三卷；任一时刻只有一条「当前环」 |
| 发放 | 建号即自动发放第一环；老号首次打开面板 / 登录时补发，并做**追认快进** |
| 推进 | 当前环条件全部满足 → **立刻发奖** → 自动翻开下一环（无需手动领取） |
| 终卷 | 全链完成后玉简碎裂文案 + 称号，链进入「已归尘」只读态 |
| 与既有系统 | 与宗门任务 / 道途日常 / 成就**互不占用**进度，不共享任务表 |

包装文案（玉简口吻，贯穿始终）：

> 建号：识海微震，多了一枚无名玉简。页首只有一句——「尘缘未了，指归在此。」  
> 卷一收束：「你已不是站着挨打的凡人。」  
> 卷二收束：「修仙主循环你已见过：修为、人事、资源、破关。去争长生。」  
> 卷三收束：「指路人到此为止。玉简碎作星屑——往后的路，你自己写。」

### [S2.2] 三卷定位

| 卷 | 卷名 | 教学目标 | 环数 |
|---|---|---|---|
| 一 | **识途** | 教程任务 · 学会基本操作 | 5 |
| 二 | **立心** | 入门主线 · 接到核心目标（主循环） | 7 |
| 三 | **破障** | 进阶任务 · 引入易被忽略的高价值机制 | 7 |

设计原则（拒绝换皮）：

1. **每环教一个机制**，任务名是修仙语汇，目标是真实系统动作或状态，不是「再做 N 次」。
2. **复合目标**用 AND / OR：AND 教节奏（如点卯+传功），OR 给路径自由（炼丹或采集）。
3. **状态追认**：条件若已被历史行为满足，自动跳过并照样发奖（老号不重做教程）。
4. **文案有判断**：提示写清「去哪个面板、做什么」，收束语有态度，不是空洞夸奖。
5. **奖励即引导**：前期给立刻用得上的丹药/灵石，中后期给机制相关的钥匙型物品。

### [S2.3] 全链任务内容（19 环）

目标类型（封闭词表，内容不得写未登记类型）：

- `action`：命名动作累计次数（事件点 `SystemQuestService.onAction`）
- `state`：玩家/关联表布尔或阈值（开启、领取、成就、境界等）
- `metric`：复用 `PlayerMetrics` 词表（境界序号、修为、击杀等）

节点逻辑：`and`（默认）| `or`。`or` 只要一项目标满足即算本环达成。

#### 卷一 · 识途（教程 · 学会基本操作）

| # | id | 环名 | 教什么 | 目标 | 玩法深度 | 奖励（示意） |
|---|---|---|---|---|---|---|
| 1 | `zhigui_s1_open_eyes` | **睁眼观己** | 角色面板与三维资源 | `action.view_player_status ≥ 1` | 强制读「气血/修为/灵石」，玉简脚注教你分清「现在有什么」与「以后要什么」 | 灵石×50、低阶回血丹×2 |
| 2 | `zhigui_s1_first_breath` | **吐纳归息** | 异步结算的修炼 | `action.settle_cultivate ≥ 1`（静思或闭关**结算成功**） | 不是「点开修炼」，必须走到结算——教会本作是异步养成 | 修为×30、灵石×30 |
| 3 | `zhigui_s1_pack_discipline` | **行囊有度** | 品阶与消耗品 | `action.use_item ≥ 1` | 文案提示「先看品阶再入口」；顺带认识丹毒/回血 | 低阶回血丹×1、灵石×20 |
| 4 | `zhigui_s1_edge_of_blade` | **试锋试胆** | PVE 胜利 | `action.pve_win ≥ 1` | 不是刷怪计数，是「证明你能护住这条命」；半血以下胜利追加隐藏评语（纯文案） | 粗布衣×1、灵石×40 |
| 5 | `zhigui_s1_read_the_road` | **识途知返** | 地图与移动 | `action.map_move ≥ 1` | 认识区域/相邻/快传，为后面洞府、副本铺路 | 引路香×2、灵石×30 |

卷一收束语：你已不是站着挨打的凡人。

#### 卷二 · 立心（入门主线 · 接到核心目标）

核心目标包装：修仙主循环 = **安身（道途/宗门）→ 产出（日课/百草/炉火）→ 破关（突破）→ 流通（市井）**。

| # | id | 环名 | 教什么 | 目标 | 玩法深度 | 奖励（示意） |
|---|---|---|---|---|---|---|
| 6 | `zhigui_s2_choose_path` | **择道栖心** | 太一门道途 | `action.choose_taoism_gate ≥ 1` | 三选一有不同页脚倾向（文案向，奖励同量级）；点明道途日常是日课 | 修为×50、灵石×80 |
| 7 | `zhigui_s2_enter_sect` | **拜入山门** | 宗门 | `action.join_sect ≥ 1` | 预告「点卯/传功/悬赏是日课，不是背景板」 | 贡献类代币或灵石×100 |
| 8 | `zhigui_s2_daily_vow` | **日课不辍** | 日常节奏 | AND：`action.sect_check_in ≥ 1` **且** `action.sect_transfer ≥ 1` | 复合目标教「每天该做的两件事」，防止只会点卯 | 修为×80、灵石×60 |
| 9 | `zhigui_s2_herb_or_fire` | **百草入药** 或 **炉火初明** | 采集或炼丹 | OR：`action.gather_complete ≥ 1` **或** `action.alchemy_success ≥ 1` | 双路径：采药郎 / 丹童；环名按实际完成路径展示（完成时锁定显示名） | 对应路径小奖 + 灵石×50 |
| 10 | `zhigui_s2_open_cave` | **开辟洞天** | 洞府 | `action.open_cave ≥ 1` 或 `state.has_cave` | 点明洞府是长线经营不是一次性解锁；药园/灵脉在提示里预告 | 灵石×120、种子×1 |
| 11 | `zhigui_s2_first_breach` | **冲穴破关** | 突破 | `action.breakthrough_success ≥ 1` 或 `metric.breakthrough_count ≥ 1` | 突破前提示查虚弱/心魔；**失败不推进**但玉简说「关隘未过，再备丹药」（反馈深度） | 筑基丹或回气丹、灵石×100 |
| 12 | `zhigui_s2_market_oath` | **市井一诺** | 经济流通 | OR：`action.market_deal ≥ 1` 或 `action.sect_quest_submit ≥ 1` | 点明「灵石要转起来」；悬赏提交也算入世一诺 | 灵石×150 |

卷二收束语：修仙主循环你已见过——去争长生。

#### 卷三 · 破障（进阶 · 引入新机制）

每环点开一条**容易被忽略的高价值系统**，并在 `teach` 字段写清一句话教学。

| # | id | 环名 | 引入机制 | 目标 | 玩法深度 | 奖励（示意） |
|---|---|---|---|---|---|---|
| 13 | `zhigui_s3_spirit_in_weapon` | **器中有灵** | 法宝祭炼 / 本命 / 器灵 | OR：`action.refine_artifact ≥ 1` 或 `action.awaken_spirit ≥ 1` | 引到法宝面板与器灵；文案警告「本命需谨慎」 | 祭炼相关小料、灵石×100 |
| 14 | `zhigui_s3_beast_pact` | **兽栏结契** | 灵兽 | AND：`state.has_spirit_beast` **且**（`action.beast_interact ≥ 1` 或 `action.beast_deploy ≥ 1`） | 不是「抓一只」，是**结契**（互动或出战），教养成关系 | 兽粮/灵石 |
| 15 | `zhigui_s3_mind_sea` | **识海生波** | 神识 | OR：`action.divine_sense_use ≥ 1` 或 `action.divine_sense_duel ≥ 1` | 从「属性」跨到「识海」；对决是玩法预告 | 神识类小奖 |
| 16 | `zhigui_s3_dayan_peep` | **大衍窥天** | 大衍诀 / 问道 | OR：`action.dayan_practice ≥ 1` 或 `action.ask_dao ≥ 1` | 点明这是飞升长线的前门，不是可选装饰 | 修为×150 |
| 17 | `zhigui_s3_heaven_chance` | **天机偶现** | 世界事件 / 试炼塔 / 天道异闻 | OR：`action.world_event_touch ≥ 1` 或 `action.trial_tower ≥ 1` 或 `action.world_risk_open ≥ 1` | 引出「服务器在活着」：偶发事件与爬塔 | 灵石×200 |
| 18 | `zhigui_s3_law_ember` | **法则余烬** | 法则碎片 / 香火 | OR：`action.law_fragment_gain ≥ 1` 或 `action.incense_gain ≥ 1` 或 `state.has_law_fragment` | 后期资源第一次露脸；文案不剧透只点「余烬」 | 法则向小奖 |
| 19 | `zhigui_s3_dust_to_dust` | **指归归尘** | 终章整合 | OR：`metric.realm_index ≥ 筑基` 或 `action.claim_achievement ≥ 1` | 终环不考操作，考「你已上路」；完成时玉简碎裂 + 称号 | 称号「已识归途」、灵石×500、修为×300 |

### [S2.4] 数据与契约

**静态内容** `server/config/system_quest_data.json`（ConfigLoader 目录扫描自动加载）：

```json
{
  "chain": {
    "id": "zhigui",
    "name": "尘缘指归",
    "short_name": "指归",
    "intro": "……",
    "ending": "……",
    "final_title_id": "zhigui_returned"
  },
  "acts": [
    { "id": 1, "name": "识途", "subtitle": "学会基本操作", "epilogue": "……" },
    { "id": 2, "name": "立心", "subtitle": "接到核心目标", "epilogue": "……" },
    { "id": 3, "name": "破障", "subtitle": "引入新机制", "epilogue": "……" }
  ],
  "nodes": [
    {
      "id": "zhigui_s1_open_eyes",
      "act": 1,
      "order": 1,
      "name": "睁眼观己",
      "name_alt": null,
      "tagline": "灵根既定，先认清自己。",
      "body": "……",
      "hint": "点开「角色」，读一眼气血、修为与灵石。",
      "teach": "角色面板与三维资源",
      "panel": "character",
      "logic": "and",
      "objectives": [
        {
          "id": "view_player_status",
          "type": "action",
          "actions": ["view_player_status"],
          "count": 1,
          "label": "查看一次角色状态"
        }
      ],
      "rewards": {
        "spirit_stones": 50,
        "exp": 0,
        "items": [{ "item_key": "low_healing_pill", "quantity": 2 }]
      }
    }
  ]
}
```

目标节点字段：

| 字段 | 说明 |
|---|---|
| `type` | `action` \| `state` \| `metric` \| `or_group` |
| `actions` | action 类型：动作名数组（OR 合并计数）或单动作 |
| `count` | action 需累计次数，默认 1 |
| `state` | state 类型的状态键（见下表） |
| `metric` / `target` | metric 类型：PlayerMetrics 键与阈值 |
| `children` | or_group 类型：子目标数组，任一满足即本项达成 |
| `label` | 面板展示的客观条件文案 |

**动作词表**（`onAction` 只认这些名字；未知名字启动期不拦、运行期忽略并 warn 一次）：

`view_player_status`, `settle_cultivate`, `use_item`, `pve_win`, `map_move`, `choose_taoism_gate`, `join_sect`, `sect_check_in`, `sect_transfer`, `gather_complete`, `alchemy_success`, `open_cave`, `breakthrough_success`, `market_deal`, `sect_quest_submit`, `refine_artifact`, `awaken_spirit`, `beast_interact`, `beast_deploy`, `divine_sense_use`, `divine_sense_duel`, `dayan_practice`, `ask_dao`, `world_event_touch`, `trial_tower`, `world_risk_open`, `law_fragment_gain`, `incense_gain`, `claim_achievement`

**状态键**（`state`，由 SystemQuestService 内注册查询，禁止散落）：

| 锫 | 含义 |
|---|---|
| `has_cave` | 已有洞府 |
| `has_spirit_beast` | 拥有灵兽 |
| `has_sect` | 已加入宗门 |
| `has_taoism_gate` | 已选道途 |
| `has_law_fragment` | 持有或已获得过法则碎片 |
| `has_artifact_refined` | 存在祭炼过的法宝 |
| `has_artifact_spirit` | 存在器灵 |
| `has_achievement_claimed` | 领取过任意成就奖励 |
| `has_divine_sense` | 已开启神识（卷三追认） |
| `has_dayan_or_ask_dao` | 已接触大衍/问道（卷三追认） |
| `has_world_touch` | 已接触世界事件/试炼塔（卷三追认） |
| `has_incense` | 已有香火（卷三追认） |
| `chain_done` | 本链已完成（终环用） |

**动态进度表** `player_system_quests`：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT PK | |
| `player_id` | BIGINT UK | 每人一行（单链） |
| `chain_id` | VARCHAR(32) | 默认 `zhigui` |
| `current_node_id` | VARCHAR(64) NULL | 当前环；`NULL` 且 `status=done` 表示已归尘 |
| `status` | VARCHAR(16) | `active` \| `done` |
| `progress` | TEXT | JSON：`{ actionCounts, flags, satisfiedBy }` 仅记当前环累计 |
| `completed_nodes` | TEXT | JSON 数组，完成顺序 |
| `completed_at` | DATETIME NULL | 全链完成时间 |
| `created_at` / `updated_at` | DATETIME | |

### [S2.5] 服务行为（SystemQuestService）

**接口**

| 方法 | 行为 |
|---|---|
| `ensureChain(playerId)` | 无行则建行并发放第一环；有行则**追认快进**（见下） |
| `onAction(playerId, action, meta?)` | 记动作；若当前环依赖该动作则更新 progress；评估并可能推进 |
| `getBoard(playerId)` | ensure 后返回：链信息、三卷、各环展示态、当前环详情、进度 |
| `evaluateNode(node, player, progress, ctx)` | 纯判定：目标是否满足 |
| `advance(playerId)` | 发当前环奖励 → 记入 completed_nodes → 发下一环或标 done → WS 通知 |

**追认快进（老号 / 断线补课）**  
打开面板或登录时对**当前环**做一次全量判定（含 metric/state）；若已满足则立即 `advance`，并继续对新当前环判定，直到卡住或全链完成。单次 ensure 最多快进 N=32 环，防止异常死循环。

**发奖契约**（对齐成就领取）：

1. **两个独立事务**：先落动作进度，再发奖+推进；发奖失败只回滚后者，动作计数不丢；
2. 发奖事务内：灵石/修为/物品/称号 → 写 completed_nodes → 指针下移；物品走 `grantItems`，任一失败**抛出事务整笔回滚**（不半发）；
3. 事务失败不吞进内层：`ensureChain` 外层捕获后返回可展示 board + `grant_error`，清包后下次 ensure 自动补发；
4. 成功后 `WebSocketNotificationService` 推 `resource` + `system_quest`；
5. `zhiguiHooks` 用 `setImmediate` 延后一拍，避开调用方未 commit 的外层事务。

**onAction 接线原则**  
只在**已有业务成功路径**末尾加一行 `SystemQuestService.onAction(...).catch(() => {})`，不改变原业务返回值。首批必接：

| 动作 | 接线点（代表） |
|---|---|
| `view_player_status` | 玩家信息 GET / 打开角色 |
| `settle_cultivate` | Meditation / Seclusion 结算成功 |
| `use_item` | Inventory 使用/服用成功 |
| `pve_win` | CombatService 胜利分支 |
| `map_move` | 移动完成 / 快传完成 |
| `choose_taoism_gate` | TaoismGate 选道成功 |
| `join_sect` / `sect_check_in` / `sect_transfer` / `sect_quest_submit` | SectService 对应成功 |
| `gather_complete` | Gathering 结算 |
| `alchemy_success` / `refine_artifact` | Crafting 炼丹/炼器成功 |
| `open_cave` | 开辟洞府成功 |
| `breakthrough_success` | breakthrough 路由成功 |
| `market_deal` | Market 成交 |
| `awaken_spirit` / `beast_*` / `divine_sense_*` / `dayan_practice` / `ask_dao` / `world_*` / `law_*` / `incense_*` / `claim_achievement` | 对应服务成功点；能接尽接，接不上的靠 state 追认 |

**并发**  
推进链使用 `player_system_quests` 行锁（`FOR UPDATE`）+ 事务；重复 `onAction` 幂等（progress 取 max / 累加后 clamp）。

### [S2.6] HTTP API

鉴权：`requireAuth`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system-quest/board` | 面板全量：acts + nodes 展示 + current |
| POST | `/api/system-quest/sync` | 可选：手动触发 ensure（前端打开面板时也可只靠 GET） |
| GET | `/api/system-quest/current` | 轻量当前环（角标/悬浮提示） |

响应 `board` 形状（稳定契约）：

```json
{
  "success": true,
  "chain": { "id": "zhigui", "name": "尘缘指归", "short_name": "指归", "status": "active" },
  "acts": [{ "id": 1, "name": "识途", "subtitle": "学会基本操作", "epilogue": "..." }],
  "nodes": [{
    "id": "zhigui_s1_open_eyes",
    "act": 1,
    "order": 1,
    "name": "睁眼观己",
    "state": "active",
    "objectives": [{ "label": "查看一次角色状态", "done": false, "progress": 0, "target": 1 }],
    "hint": "...",
    "teach": "...",
    "panel": "character",
    "rewards": { "spirit_stones": 50, "items": [{ "item_key": "low_healing_pill", "item_name": "低阶回血丹", "quantity": 2 }] }
  }],
  "current_node_id": "zhigui_s1_open_eyes",
  "last_grant": null,
  "grant_error": null
}
```

`state`: `done` | `active` | `locked`（只展示名字与卷归属，不剧透 body）。

### [S2.7] 前端

| 文件 | 职责 |
|---|---|
| `client/src/api/systemQuest.ts` | board / current / sync |
| `client/src/components/panels/SystemQuestPanel.vue` | 玉简面板：三卷目录、当前环大卡、完成环折叠、奖励预览 |
| `actionCatalog.js` | 新增 `system_quest`：名称「指归」、描述「尘缘指归 任务引路」 |
| `panels/registry.js` | `system_quest: () => import('./SystemQuestPanel.vue')` |
| `DOCK_TABS` | 挂入 `self` 组（自身），与角色/成就并列 |

面板交互要点：

1. 当前环置顶大卡：环名、tagline、目标勾选、hint、「去这里」按钮（`openPanel(panel)`）；
2. 三卷时间轴：完成环灰显可回看正文，锁住环只显示卷内序号+环名；
3. 自动推进后 toast + 轻微卷轴动画；全链完成显示碎裂终章与称号；
4. 与 WS `system_quest` 事件联动静默刷新。

### [S2.8] 内容校验与错误行为

- 启动期：节点 id 唯一、order 在卷内递增、objectives 类型在词表、`panel` 在 actionCatalog、奖励走 Achievement 同款 grant 形状；不过则抛（对齐 ContentRegistry 风格，放在 SystemQuestService.assertContent）。
- 运行期：未知 action 仅 warn 一次；奖励发不出不推进；玩家不存在 no-op。

## [S3] Out of Scope

- 不改宗门悬赏 / 道途日常 / 成就的进度口径或 UI 合并
- 不做多条并行系统任务链、不做支线路线选择树
- 不做任务放弃/重置/跳过（线性引路不允许跳环）
- 不做 GM 可视化任务编辑器（JSON 热更即可）
- 不做跨角色/夺舍继承（指归跟玩家角色，不跟账号）
- 不重做新手强制引导遮罩层

## Tasks

- [x] T1: 落地 `system_quest_data.json` 全 19 环内容 + 卷文案 + 称号 `zhigui_returned` — acceptance: 配置可被 ConfigLoader 加载，节点/动作词表自检通过 (covers: S2.1, S2.2, S2.3, S2.8)
- [x] T2: 模型 `playerSystemQuest` + migration 建表 — acceptance: `Model.sync()` 幂等建出 `player_system_quests` (covers: S2.4)
- [x] T3: `SystemQuestService`：ensure / onAction / evaluate / advance / getBoard + 事务发奖 — acceptance: 单测覆盖自动发放、完成自动续环、OR/AND、追认快进、发奖失败不推进 (covers: S2.4, S2.5, S2.8)
- [x] T4: 路由 `/api/system-quest/*` 并挂载 — acceptance: 冒烟脚本可 board 并推进一环 (covers: S2.6)
- [x] T5: 关键业务点 `onAction` 接线（教程卷五环必通 + 卷二主路径 + 尽量覆盖卷三） — acceptance: 对应动作在成功路径会更新进度 (covers: S2.5)
- [x] T6: 前端 API + SystemQuestPanel + actionCatalog/registry 接入 — acceptance: 面板可打开，当前环可跳转，完成后自动刷新 (covers: S2.7)
- [x] T7: 测试与内容体检：Jest + content 自检 + 手动/脚本走通「建号→卷一完成」 — acceptance: `npm test` 相关用例绿；新用例失败可复现 (covers: S2.5, S2.8; depends: T3)
