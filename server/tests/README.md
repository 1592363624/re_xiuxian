# 测试目录说明

本目录分两类，运行方式完全不同，不要混放。

## 1. `*.test.js`（本目录根下）— Jest 自动化用例

```bash
cd server
npm test                 # 全部
npx jest tests/CaveService.test.js
```

`package.json` 里 `testMatch: **/tests/**/*.test.js`，所以只有以 `.test.js` 结尾的文件会被 `npm test` 收集。新增自动化用例请放这里并用 `.test.js` 后缀。

## 2. `e2e/` — 手工端到端脚本

84 个按玩法组织的一次性验证脚本（`test_*.js`），历史上散落在 `server/scripts/` 和 `server/` 根目录，2026-09-19 收敛到此。它们**不是** Jest 用例，靠 `console.log` + `assert` 输出结果：

```bash
cd server && node tests/e2e/test_spirit_beast.js
# 或从仓库根：node server/tests/e2e/test_spirit_beast.js
```

部分脚本要求后端已在运行（脚本内部打 `http://localhost:3000/api/...`），运行前先起服务。

## 跑之前必须确认的三件事

1. **数据库指向**。`e2e/` 里的脚本会真实读写 `server/.env` 指向的库。本地 `.env` 当前指向隔离库 `re_xiuxian_test`；线上是 `.env_pord` → `xiuxian`。**禁止把 `DB_NAME` 切成 `xiuxian` 后跑这些脚本。**
2. **备份字段要补全**。`test_batch_4_3_runtime.js` / `test_death_flow.js` / `test_core_gameplay.js` 曾因为只备份了部分玩家字段，把测试账号 `realm_rank` 从 23 永久写成 0（见 `docs/功能对比清单.md` B46）。新增脚本时，凡是改动玩家状态的用例，`backup` 必须覆盖 `realm/realm_rank/role/attributes/is_secluded/is_meditating/bottleneck_state/bottleneck_insight/weakness_end_time/seclusion_end_time/last_seclusion_time`。
3. **不进 CI**。`.github/workflows/` 目前只有部署流水线，测试需要外部 MySQL，接进 CI 前先改成连影子库。

## 一次性探针不要留在这里

临时排查用的 `_test_*` / `check_*` / `debug_*` 脚本请写到系统临时目录，或在同一条命令里创建并删除。2026-09-19 已清理掉 26 个此类历史遗留（`fix_test_account_full.js`、`fix_test_account_realm.js` 这类数据修复工具按约定保留在 `server/scripts/`）。
