/**
 * 服务端业务响应判定的唯一口径（2026-09-23）
 *
 * 后端的约定写在每个路由文件顶部的 `sendServiceResult()` 里（`routes/concubine.js`、`routes/dungeon.js`…）：
 *   · 成功     → `{ code: 200, message, data }`
 *   · 业务失败 → HTTP 200 + `{ code: 200, success: false, message, error_code }`
 *     （routes/ascension.js 里那句原话：「业务失败返回 200 + success:false，便于前端按业务提示处理」）
 *
 * 所以 **`code === 200` 不是成功**：被拒绝的操作也带 200。本轮两个面板里有 24 处写成
 * `if (resp.data?.code === 200) showToast(msg, 'success')`，表现是"侍妾已经把这笔奖励领过了"
 * 这种被拒的事，玩家看到的是一条绿色成功提示 + 界面自己刷新成失败前的样子（实测见
 * server/scripts/smoke_companion_voyage.js 的 V8b/C4b）。
 * 另一族路由（如 routes/gambling_stone.js）失败直接回 HTTP 400，那类调用点在拦截器里就被 reject 了，
 * `code === 200` 只是冗余而非缺陷 —— 本口径不区分这两种，它只保证"成败只按这一个地方判"。
 * 传输层错误（401/403/404/500/断网）由 api/index.ts 的响应拦截器统一播报，不会走到这里。
 *
 * 用法：
 *   if (isBizOk(resp)) { ... } else { uiStore.showToast(bizMessage(resp, '操作失败'), 'error'); }
 * 新代码不要再写 `resp.data?.code === 200`（client/scripts/ui-check.mjs 第 12 项按文件计数，只许变小）。
 */

/** 服务端统一响应体（`success` 只在失败时出现） */
export interface ServiceEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
  success?: boolean;
  error_code?: string | null;
}

/** axios 响应的最小形状：判定只用 `data` 这一层 */
export interface ServiceResponse<T = unknown> {
  data?: ServiceEnvelope<T> | null;
}

/**
 * 这次操作是不是真的成功了。
 * @param resp 接口返回的 axios 响应
 */
export function isBizOk(resp: ServiceResponse | null | undefined): boolean {
  const body = resp?.data;
  if (!body) return false;
  if (body.success === false) return false;      // 业务失败：HTTP 200、code 也还是 200
  return Number(body.code) === 200;
}

/**
 * 该给玩家看的那句话（后端 message 优先，它带着具体原因，如"远航未结束，预计 … 归来"）。
 * @param resp 接口返回的 axios 响应
 * @param fallback 后端没给 message 时的兜底文案
 */
export function bizMessage(resp: ServiceResponse | null | undefined, fallback = '操作失败'): string {
  return String(resp?.data?.message || fallback);
}
