/**
 * QQ 登录回调参数处理
 *
 * 后端授权完成后 302 回前端，把一次性票据写在地址栏 query 上。读一次就要立刻擦掉：
 * 票据虽然 60 秒过期且取出即失效，但留在 URL 里会进浏览器历史，也会被玩家原样复制
 * 分享到聊天里。
 *
 * 结果缓存为模块单例，因为 App.vue 与 Login.vue 会在同一次页面加载里各读一次，
 * 而先读的那一处已经把地址栏擦干净了。
 */
let cached = null

const QQ_PARAMS = ['qq_ticket', 'qq_pending', 'qq_bind', 'qq_error']

export function readQQRedirect() {
  if (cached) return cached

  const params = new URLSearchParams(window.location.search)
  cached = {
    // 已绑定 QQ 登录成功，可换取正式登录态
    ticket: params.get('qq_ticket'),
    // QQ 校验通过但尚未绑定账号，需引导玩家登录/注册后完成绑定
    pending: params.get('qq_pending'),
    // 设置面板发起的绑定结果
    bindResult: params.get('qq_bind'),
    error: params.get('qq_error')
  }

  const present = QQ_PARAMS.filter(key => params.has(key))
  if (present.length) {
    present.forEach(key => params.delete(key))
    const rest = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
  }

  return cached
}
