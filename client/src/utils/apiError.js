/**
 * 从接口错误里取出「该给玩家看的那句话」
 *
 * 后端中央错误处理（server/middleware/errorHandler.js）返回
 * { code, error_code, message }，所以 message 才是规范字段。
 *
 * 而前端原先有 9 种各写各的取法（共 212 处）：
 *   error.response?.data?.message   54 处
 *   error.response?.data?.error     48 处  ← 读的是中央处理根本不发的字段
 *   err?.response?.data?.message    47 处
 *   ...
 * 只读 .error 的那些遇到 400 校验错误时拿不到具体原因，只能退回
 * "操作失败" 这种没信息量的兜底；玩家就不知道自己做错了什么。
 *
 * 优先级按"最可能是给玩家看的话"排：
 *   1. response.data.message  中央处理的规范字段
 *   2. response.data.error    少数路由自己返回 { error }
 *   3. 兜底文案（调用方给的、带业务上下文的说法）
 * axios 自身的 err.message（"Request failed with status code 500"）
 * 一律不采信：那是写给开发者看的，出现在玩家界面上就是事故。
 */
export function apiErrorMessage(err, fallback = '操作失败') {
  // 401：后端那句「未提供认证令牌，拒绝访问」是给开发者看的。
  // 此时响应拦截器已经登出并弹过一次提示，面板再原样贴一遍只会让玩家困惑。
  if (err?.response?.status === 401) return '登录已过期，请重新登录后再试'
  const data = err?.response?.data
  const fromBody = data?.message || data?.error
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim()
  return fallback
}

/** 状态码：调用方想按 401/403 之类做分支时用，别自己去翻 axios 内部结构 */
export const apiErrorStatus = (err) => err?.response?.status ?? null
