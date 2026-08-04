# 项目长期记忆 - re_xiuxian 修仙游戏

## 项目性质（重要）
- 本项目是 **Vue 3 + Express + MySQL 的网页文字游戏**，可使用网页特效。
- 根目录的 `xiuxian_game_guide.md` 描述的是 **Telegram 群聊机器人**（`.检测灵根` 类聊天指令、LDC 充值等），
  **与本项目形态不符，不可直接作为需求规格**。开发以现有代码为准。
- 用户已明确：不用管 Telegram 机器人相关内容。

## 项目规模（避免误判为"半成品"）
| 层 | 规模 |
|---|---|
| 后端路由 `server/routes` | 80 个（约 60 玩家端 + 19 GM 端） |
| 后端服务 `server/game` | 105 个文件 |
| 数据模型 `server/models` | 113 个 |
| 配置 `server/config` | 56 个 JSON |
| 前端面板 `client/src/components/panels` | 40+ 个 .vue |

炼丹/炼器/宗门任务/洞府/秘境/道侣 六大模块**均已实现**，不是待开发功能。

## 关键架构约定
- 配置统一放 `server/config/*.json`，通过 `ConfigLoader.getConfig(name)` 读取。
  **注意**：配置未加载时 `getConfig` 会抛异常，服务层读配置需 try/catch 兜底。
- 服务层多为**单例导出**：`module.exports = new XxxService()`。
- 服务间互相引用时用**延迟 require**（在函数内 require）避免循环依赖。
- 前端 `GameLayout` 是 40+ 面板的 `v-if` 状态机，**未使用 vue-router 做面板路由**。
- 前端构建仅 `vite build`，**未接入 vue-tsc 类型检查**（`npx vue-tsc` 会因版本不兼容报错，不可用于验证）。

## 测试
- 测试框架：**Jest 29.7.0**（2026-08-03 引入，装在 `server/`）。
- 配置写在 `server/package.json` 的 `jest` 字段，`testMatch: **/tests/**/*.test.js`。
- 命令：`cd server && npm test`。
- 测试策略：mock 掉 `config/database`、models、依赖服务，只测纯逻辑，**无需 MySQL 即可运行**。
- 现有测试套件：`CraftingService.test.js`（57 用例，含炼丹/炼器火候、品质倍率）、`CaveService.test.js`（洞府 seclusion/defense 断链）。

## 洞府加成断链已接通（2026-08-04）
- `CaveService.getCaveBonus()` 返回的 `seclusion_bonus`/`defense` 此前无调用者；现已通过 `getCaveSeclusionBonus(playerId)` / `getCaveDefenseBonus(playerId)` 接通。
- `seclusion_bonus` → `routes/seclusion.js` 闭关收益；`defense` → `WorldBossService` 玩家受 BOSS 反击伤害减免。
- 开关与上限在 `game_balance.json` 的 `cave_bonus.seclusion/defense.{enabled,max_bonus}` 配置中心化。

## 品质效果倍率已闭环（2026-08-04）
- `Item` 模型新增 `metadata` JSON 列（migration_0076 自动执行）。
- 炼制产出写入 `effect_multiplier`（丹药）/ `attr_multiplier`（装备），服用端 `InventoryService.useItem` 按 `effect_multiplier` 放大恢复/修为效果。
- 装备的 `attr_multiplier` 已预留，但 **equip 流程尚未消费**（另一待办）。

## 用户偏好
- 全程使用中文交流。
- 代码需三级注释：文件顶级注释、类/函数注释、关键逻辑行内注释（解释"为什么"）。
- **所有可变数值（阈值/开关/周期/比例/概率/文案/URL/名单）必须抽取到配置文件**，禁止硬编码魔法数字。
- API 变更需同步更新 `docs/openapi.json`（符合 OpenAPI 规范，可导入 Apifox）。
- 每次完成后需给出总结并推荐后续步骤。
