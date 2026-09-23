/**
 * GM 后台「游戏内容选项」加载器
 *
 * 统一从内容层拉主键+显示名，供 SearchableSelect 使用。
 * 禁止前端再抄一份物品/境界/灵兽清单 —— 资料片加一条内容，抄的那份就少一条。
 *
 * 缓存：同一会话内按 dataset+collection 缓存，避免每个下拉各打一次接口。
 */
import { ref } from 'vue'
import {
  getContentKeyOptions,
  getGameBalancePublic,
  getRealmsConfig,
  getItemsConfig,
} from '../api/config'

/** key → Promise<{value,label,meta,group,color}[]> */
const cache = new Map()

async function cached(key, loader) {
  if (cache.has(key)) return cache.get(key)
  const p = loader().catch(err => {
    cache.delete(key)
    throw err
  })
  cache.set(key, p)
  return p
}

/** 清空缓存（热更配置后调用） */
export function clearContentOptionCache() {
  cache.clear()
}

/**
 * 内容主键清单 → 选项数组
 * GET /config/content/keys/:dataset[?collection=]
 */
export function useContentKeyOptions(dataset, collection) {
  const options = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      const list = await cached(`keys:${dataset}:${collection || ''}`, async () => {
        const res = await getContentKeyOptions(dataset, collection)
        return (res.data?.data?.entries || []).map(e => ({
          value: e.key,
          label: e.name || e.key,
          meta: e.key,
          group: e.collection || '',
          color: e.color || undefined,
        }))
      })
      options.value = list
    } catch (err) {
      error.value = err
      options.value = []
      throw err
    } finally {
      loading.value = false
    }
  }

  return { options, loading, error, load }
}

/**
 * 境界清单（玩家实际境界名，按 rank 排序）
 * GET /config/data/realms
 */
export function useRealmOptions() {
  const options = ref([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const list = await cached('realms', async () => {
        const res = await getRealmsConfig()
        const realms = res.data?.data?.realms || []
        return realms
          .slice()
          .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
          .map(r => ({
            value: r.name,
            label: r.name,
            meta: `rank ${r.rank}`,
            group: '子境界',
            rank: r.rank,
          }))
      })
      options.value = list
    } finally {
      loading.value = false
    }
  }

  return { options, loading, load }
}

/**
 * 境界门槛选项：子境界 + 大境界名（min_realm 配置用，如「筑基期」）
 * 与 RealmService.resolveMinRealmRank 的解析能力对齐。
 */
export function useRealmThresholdOptions() {
  const options = ref([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const list = await cached('realm-thresholds', async () => {
        const res = await getRealmsConfig()
        const realms = res.data?.data?.realms || []
        const sub = realms
          .slice()
          .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
          .map(r => ({
            value: r.name,
            label: r.name,
            meta: `rank ${r.rank}`,
            group: '子境界',
          }))
        // 大境界门槛（与 server/utils/gameConstants.REALM_TIER_MIN_RANK 对齐）
        const tiers = [
          { value: '凡人', label: '凡人', meta: 'rank 0', group: '大境界' },
          { value: '炼气期', label: '炼气期', meta: 'rank 1+', group: '大境界' },
          { value: '筑基期', label: '筑基期', meta: 'rank 11+', group: '大境界' },
          { value: '金丹期', label: '金丹期', meta: 'rank 15+', group: '大境界' },
          { value: '结丹期', label: '结丹期', meta: '金丹同义', group: '大境界' },
          { value: '元婴期', label: '元婴期', meta: 'rank 19+', group: '大境界' },
          { value: '化神期', label: '化神期', meta: 'rank 23+', group: '大境界' },
          { value: '元神期', label: '元神期', meta: '化神同义', group: '大境界' },
          { value: '炼虚期', label: '炼虚期', meta: 'rank 27+', group: '大境界' },
          { value: '合体期', label: '合体期', meta: 'rank 31+', group: '大境界' },
          { value: '大乘期', label: '大乘期', meta: 'rank 35+', group: '大境界' },
          { value: '渡劫期', label: '渡劫期', meta: 'rank 39+', group: '大境界' },
          { value: '真仙', label: '真仙', meta: 'rank 40', group: '大境界' },
        ]
        return [...tiers, ...sub]
      })
      options.value = list
    } finally {
      loading.value = false
    }
  }

  return { options, loading, load }
}

/**
 * 物品清单（发放/引用道具用）
 * GET /config/data/items + game_balance.item_types 中文名
 */
export function useItemOptions() {
  const options = ref([])
  const loading = ref(false)
  const typeLabels = ref({})

  async function load() {
    loading.value = true
    try {
      const data = await cached('items', async () => {
        const [itemsRes, gbRes] = await Promise.all([
          getItemsConfig(),
          getGameBalancePublic().catch(() => null),
        ])
        const items = itemsRes.data?.data?.items || []
        const labels = gbRes?.data?.data?.item_types || {}
        return {
          labels,
          list: items.map(it => ({
            value: String(it.id),
            label: it.name || String(it.id),
            meta: `${it.id}${it.quality ? ` · ${it.quality}` : ''}`,
            group: labels[it.type] || it.type || '其他',
          })),
        }
      })
      typeLabels.value = data.labels
      options.value = data.list
    } finally {
      loading.value = false
    }
  }

  return { options, loading, typeLabels, load }
}
