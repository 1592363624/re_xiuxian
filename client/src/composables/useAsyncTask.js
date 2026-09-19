import { onMounted, ref } from 'vue'
import { useUIStore } from '../stores/ui'

/**
 * 异步任务的 loading / error 记账
 *
 * 补的是这一层缺口：全站 42 个面板都挂了 PanelShell，但只有 1 个
 * 真的把 :error 传进去。后果不是"少个样式"，而是——
 *   拉取失败时面板 toast 一句就再没动静，3 秒后 toast 消失，
 *   玩家看到的是一片「暂无数据」，既不知道失败了，也没有重试入口，
 *   只能关掉面板重开一次。18 个面板的加载失败都是这个样子。
 *
 * 用法（一次把一个 loader 包进来，可以渐进采纳）：
 *   const { loading, error, run } = useAsyncTask({ fallback: '获取功法列表失败' })
 *   const fetchList = () => run(async () => {
 *     const res = await getTechniqueList()
 *     payload.value = res.data            // 原来的赋值逻辑照旧
 *   })
 *   onMounted(fetchList)
 *
 * 然后 PanelShell 上 :loading="loading" :error="error" @retry="fetchList" 三件套，
 * 失败就有常驻的错误态和重试按钮。
 */
export function useAsyncTask({ fallback = '加载失败' } = {}) {
  const uiStore = useUIStore()
  const loading = ref(false)
  const error = ref('')

  async function run(task) {
    loading.value = true
    error.value = ''
    try {
      return await task()
    } catch (err) {
      // showApiError 负责统一口径：拦截器已经播报过的不再叠一条
      error.value = uiStore.showApiError(err, fallback)
      return undefined
    } finally {
      loading.value = false
    }
  }

  return { loading, error, run }
}
