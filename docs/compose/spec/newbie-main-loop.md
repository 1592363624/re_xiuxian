---
feature: newbie-main-loop
status: delivered
updated: 2026-09-24
branch: main
commits: df43f449..working-tree
---

# 主循环新手线 · 流程审计与回正

## Report

**What was built** — 对新手主循环（建号→面板→静思结算→用物品→PVE→移动→突破→指归）做了设计文档优先的逐步审计，并修掉会卡死主链的逻辑缺陷：`/api/breakthrough/try` 成功后修为清零（与 `RealmService.breakthrough` 及界面「本境界进度」模型对齐）、静思按 `base_exp_per_minute=2` 给基础修为（0 修为新号不再白坐）、`getNextRealmExpCap` 改读配置表、凡人 rank=0 可进凡人图、移动灵力不足可用灵石补足且数值走 `PlayerStateStore` 原子增减、突破 HP/MP 用 `AttributeMaxService` 且 `mp_max=0` 合法。数值争议（初始年龄、失败惩罚、回血量等）记入 S2.4 只拍板不擅改。

**Verification** — `cd server && npm test -- NewbieMainLoop RealmRankConsistency SystemQuestZhigui SpiritRoot PlayerMetricsVocabulary PlayerStateMachine --runInBand`：PASS 107/107（复审后 NewbieMainLoop 9/9，含 50% 中断线性收益）。`node tests/e2e/test_newbie_main_loop.js`（re_xiuxian_test）：PASS 20/20。独立评审两轮：第一轮 1 critical + 2 major 已修；复审 5 项全 FIXED、无新 critical、APPROVE。

**Journey log** — ① 双突破入口必须同语义，尤其 exp 清零，否则连破。② 设计「2 点/分钟」是线性实际时长，不要再乘 completion_ratio。③ 凡人 rank=0 是合法境界，`<=0` 不能当未配置。④ BIGINT 资源禁止 Number 整值写回，走 `patchPlayerState.amounts`，否则撞 `numericWriteGuard`。⑤ 沙箱禁 `git worktree add`，经确认直接在 main 实现。

## [S1] Problem

新手主循环缺少「每一步返回是否符合设计」的闭环审计。走查 + 实库 e2e 确认的阻塞：

1. **双突破入口行为不一致**：前端 `POST /api/breakthrough/try` 成功后不清空修为；`RealmService.breakthrough` 会归零。界面按本境界进度展示，不清零会连破。
2. **静思修为在 0 修为时恒为 0**：只按 `currentExp * exp_rate`，新号打坐无收益。
3. **`getNextRealmExpCap` 用 `1000*rank³`**，与配置/设计表脱节。
4. **凡人进不了凡人图**：`meetsRealmRequirement` 把 rank=0 当「未配置」。
5. **移动只扣灵力**：凡人 `mp_current=0` 永远走不动。
6. **突破 `/try` 成功** HP/MP 写 `base_*` 列值、不清一次性突破加成；移动整值写回触发数值写保护。

## [S2] Design

### [S2.1] 主循环步骤与期望返回（设计文档优先）

依据 `docs/详细数据设计文档（含数值平衡与界面布局）.md` §2.1–2.2 与 `config/role_init.json` / `config/realm_breakthrough.json`（冲突记入 S2.4）。

| 步 | 入口 | 期望结果契约 | e2e 实测 |
|---|---|---|---|
| 建号 | `POST /api/auth/register` | 凡人、exp=0、基础灵根五选一、realm_rank=0、灵石≥10 | PASS |
| 面板 | `GET /api/player/me` | exp/exp_next/exp_cap 同为本境界口径；灵根归一 | PASS（exp_cap=100） |
| 静思结算 | start → interrupt/cleanExpired | 基础 2 点/分钟 + 比例加速；0 修为也涨；`settle_cultivate` | PASS（exp_gain=2） |
| 用物品 | `POST /api/inventory/use` | 扣物品、应用 effect、`use_item` | PASS（回春丹 hp+10） |
| PVE | `POST /api/combat/*` | 胜加修为并 `pve_win` | PASS（野兔胜） |
| 移动 | `POST /api/map/start-move` `{targetMapId}` | 灵力优先、灵石补足、原子扣减；`map_move` | PASS |
| 突破 | `POST /api/breakthrough/try` | 成功同步境界/rank/寿命/HP/MP 且 **exp=0** | PASS |
| 指归 | `GET /api/system-quest/board` | 自动发环/续环 | PASS |

### [S2.2] 修为进度模型（定案）

- `player.exp` = 当前境界已积累修为；`exp_cap` = 离开本境界所需（配置表）。
- 突破成功 **exp 清 0**。
- 设计表「0→100 / 100→250」按阶梯累计曲线解读；运行时阈值取各行上界。

### [S2.3] 静思/修炼修为收益（定案）

```
exp_gain = floor(base_exp_per_minute * actual_seconds / 60)
         + floor(current_exp * exp_rate * completion_ratio)
```

- 基础项按**实际已坐时长**线性，**不**再乘 `completion_ratio`。
- `base_exp_per_minute` 默认 **2**；`exp_rate` 为高修为加速；受 `max_exp_reward_per_session` 封顶。
- 结算入口：`interruptMeditation` / 状态 `cleanExpired`（`getStatus` 只读）。

### [S2.4] 设计 vs 实现 · 数值争议（本轮只记录不改）

| 项 | 设计 | 实现 | 处理 |
|---|---|---|---|
| 初始年龄 | 0 岁 | `role_init.initialAge = 16` | 待拍板 |
| 突破失败扣修为 | 炼气 10%，随境界加重 | `failure_exp_loss_rate = 0.2` 一刀切 | 待拍板 |
| 突破失败加年龄 | 分境界 3/5/10/… | `rank * failure_age_multiplier(2)` | 待拍板 |
| 低阶回血丹 | 恢复 100 气血 | `hp_restore: 10`（名「回春丹」） | 待拍板 |
| 移动消耗 | 偏时间/快传 | 灵力（灵石可补足） | 已做新手回退；纯灵石制待拍板 |
| 炼气属性加成表 | 每层递增明细 | `realm_breakthrough.json` base_* 近似 | 记录 |
| 双时间/红尘年龄 | 设计 2.1.1 内部亦有矛盾 | `LifespanService` 简化模型 | 不在新手线重写 |
| 初始灵石 | 新手任务/采集 | 建号 10 | 可接受 |

### [S2.5] 修复契约（已落地）

1. `/api/breakthrough/try` 成功：`exp=0`；HP/MP 走 `AttributeMaxService`（`mp_max=0` 合法）；`clearPendingBreakthroughBonus`。
2. 静思 `base_exp_per_minute` 线性实际时长。
3. `getNextRealmExpCap` 读下一境界 `exp_cap`。
4. `meetsRealmRequirement`：rank 0 合法。
5. `map/start-move`：灵力/灵石混合支付，`patchPlayerState.amounts` 原子扣减。
6. 新号 `realm_rank = 0`。
7. 回归 `tests/NewbieMainLoop.test.js`；e2e `tests/e2e/test_newbie_main_loop.js`。

## [S3] Out of Scope

- 资料片/宗门/PVP/世界事件深挖；双时间体系完整落地；战斗公式 2.2.2 重写；线上数据/密钥；前端 UI 重设计。

## Tasks
- [x] T1: 落地 S2.2/S2.3/S2.5 修为与突破回正 — acceptance: 单测覆盖突破成功 exp=0、静思 0 修为得基础修为、getNextRealmExpCap 读配置 (covers: S2.2; S2.3; S2.5)
- [x] T2: 主循环逐步走查（静态）建号/面板/修炼/物品/PVE/移动/突破/指归 — acceptance: 每步对照 S2.1 有结论 (covers: S2.1)
- [x] T3: e2e 实库演练新手链 — acceptance: re_xiuxian_test 跑通全链 (covers: S2.1)
- [x] T4: 数值争议表定稿并写入 S2.4 — acceptance: 无 TBD (covers: S2.4)
- [x] T5: Verify + Review + Finalize — acceptance: 相关 Jest 通过；评审 APPROVE (covers: S2.1; S2.2; S2.3; S2.5)
