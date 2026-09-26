---
feature: fix-unequip-request-error
status: delivered
updated: 2026-09-24
branch: main
commits: 9c7182b2..working-tree
---

# 卸下装备报「请求配置错误」

## Report

**What was built** — 修掉储物袋点「确认卸下」只弹「请求配置错误」的根因。写请求签名在 `crypto.subtle` 不可用（http:// 非安全上下文）时改为纯 JS SHA-256/HMAC-SHA256 回退，与服务端 `signRequest` 逐字节对拍；请求拦截器 setup 失败（缺 rk / 签名异常）改为 `rejectSetupError` 当场播报真实原因并打 `__uiNotified`，响应拦截器 else 不再一律吞成「请求配置错误」。满包按业选「维持失败并明确提示」：卸下/替换归还失败文案可操作，事务回滚保证装备不丢；前端 `handleUnequip` 满包前置拦截不发请求。

**Verification** — `cd server && npm test -- ClientRequestSignParity EquipmentService RequestGuard --runInBand`：PASS 29/29（复审前）。补回滚断言后 `EquipmentService ClientRequestSignParity`：PASS 18/18。`EquipmentSlotGate Inventory ItemGrant`：PASS 25/25。`cd client && npm run type-check`：FAIL，全仓 vue-tsc 历史噪音（PRE-EXISTING，未新增错误类）。独立评审两轮：第一轮 1 critical（测试名断言缺口）+ 若干 minor；补 `rollback`/`commit`/`create`/`removeItem` 断言后复审 APPROVE、无新 critical。

**Journey log** — ① axios 请求拦截器 reject 的普通 Error 没有 request/response，会掉进响应 else；必须自带 `__uiMessage`/`__uiNotified`。② `crypto.subtle` 仅安全上下文可用，http:// 官网写请求会全挂。③ 没包容量是数量总和不是格子数，前端闸要用 `totalCount`。④ 沙箱禁 `git worktree add`，经确认在 main 直接实现。⑤ `jest.clearAllMocks()` 不会清掉 `mockRejectedValue`，套件顺序可能漏网。

## [S1] Problem

玩家在储物袋装备栏点「确认卸下」（如大五行幻世轮）后，右上角弹出两条红色「请求配置错误」，卸下从未真正到达后端业务层。

根因不是卸下接口本身，而是**写请求在 axios 请求拦截器里签名阶段就失败**，且错误文案被响应拦截器的 else 分支吞成笼统的「请求配置错误」：

1. **`crypto.subtle` 不可用**（http:// 非安全上下文）：`requestSign.js` 调用 `crypto.subtle.digest/importKey` 抛 TypeError，请求未发出（无 response / 无 request）→ else 分支 → 「请求配置错误」。
2. **旧 JWT 无 `rk`**：`extractRequestKey` 返回 null 后 reject 自定义 Error，同样落入 else 分支，真实文案「会话缺少请求签名密钥」被盖掉；组件 catch 的 `showApiError` 再叠一条。
3. 截图里储物袋 **100/100 已满**：即便签名修好，卸下归还 `addItem` 也会因容量失败。业主要求**维持失败 + 明确提示**（不自动腾格、不超限归还）。

## [S2] Design

### [S2.1] 签名可用性

- `client/src/utils/requestSign.js`：`crypto.subtle` 可用则用 Web Crypto；不可用（http://）走**纯 JS SHA-256 / HMAC-SHA256**（RFC 4231 对拍），算法与 `server/utils/requestSign.js` 逐字节一致。
- 签名头字段、payload 拼法（`METHOD\noriginalUrl\ntimestamp\nnonce\nsha256hex(rawBody)`）不变。

### [S2.2] 请求拦截器失败的播报契约

- 拦截器内 setup 失败（缺 `rk`、签名计算异常）通过 `rejectSetupError(message, config, cause?)`：
  - `err.__uiMessage` = 玩家可读原因
  - `err.__uiNotified = true` 并 **当场 toast 一次**
  - 响应拦截器 else 分支：**已 `__uiNotified` 则闭嘴**；否则优先 `__uiMessage`，再 `error.message`，最后才「请求配置错误」
- 组件侧 `showApiError` 认 `__uiNotified`，不再叠第二条红字。

### [S2.3] 满包卸下（业指定案）

- **维持失败**：卸下/替换归还时 `InventoryService.addItem` 容量不足 → 事务回滚，装备仍在槽位。
- **明确提示**：`EquipmentService.returnItemToInventory` 把「储物袋容量不足」包装为：
  - 卸下：`储物袋已满，卸下后装备无法归还。请先清理储物袋腾出空位后再试。`
  - 替换：同文，`action=替换`
- 前端 `handleUnequip` 在 `totalCount >= capacity` 时前置拦截，不发请求，同一句可操作提示。

### [S2.4] 错误契约（验收）

| 场景 | 玩家看到 | 请求数 |
|---|---|---|
| http:// 无 subtle，正常卸下 | 成功 toast（签名可算） | 1 次业务请求 |
| 旧 token 无 rk | 「会话缺少请求签名密钥，请重新登录」×1 | 0 |
| 签名计算异常 | 「无法生成请求签名，请刷新页面后重试」×1 | 0 |
| 满包点卸下 | 「储物袋已满，卸下后装备无法归还…」×1 | 0（前置）或 1（后端兜底） |
| 其它拦截器未知失败 | `__uiMessage` / `error.message` / 兜底「请求配置错误」 | 0 |

## [S3] Out of Scope

- 不改服务端 `requestGuard` 验签算法、nonce 池、时间戳窗。
- 不做满包自动丢弃 / 邮件寄回 / 临时超限归还。
- 不清理 `vue-tsc` 历史 TS 报错（全仓 PRE-EXISTING）。
- 不改功法卸下（TechniquePanel）与 GM 强制卸下。

## Tasks

- [x] T1: 纯 JS SHA-256/HMAC 回退，http:// 下可签名 — acceptance: `ClientRequestSignParity` 对拍 Node crypto + 服务端 `signRequest` 验签通过（covers: S2.1）
- [x] T2: 拦截器 setup 失败改 `rejectSetupError`，else 尊重 `__uiNotified`/`__uiMessage` — acceptance: 缺 rk / 签名失败各只弹一条正确文案（covers: S2.2）
- [x] T3: 满包卸下/替换明确失败提示 + 前端前置拦截 — acceptance: 满包卸下不发请求或后端 400 文案可操作；装备不丢（covers: S2.3）
- [x] T4: 回归测试并跑通 — acceptance: `ClientRequestSignParity` `EquipmentService` `RequestGuard` 全绿（covers: S2.1–S2.3）
