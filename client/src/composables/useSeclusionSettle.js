/**
 * 闭关结算 —— 结束/强行出关的唯一实现
 *
 * 为什么单独抽出来：结束闭关的按钮原来只长在 SeclusionOverlay 上，而那个进度条
 * 挂在右坞「总览」的状态槽里 —— 只要玩家开着任何一个面板，总览就被面板盖住
 * （FeatureDock 的 `v-show="!openPanelId"`）。于是从修炼面板点"开始常规闭关"之后，
 * 玩家眼前这个面板里没有任何出口，必须先关掉面板、回到总览，才找得到"结束修炼"。
 * 实测：闭关进行中在修炼面板里找不到出关按钮。
 *
 * 修法是给修炼面板也放一个结束入口，但结算文案与日志不能抄第二份 ——
 * 那份文案要同时照顾 exp_gain=0 不能回退到总修为（B13）、强行出关的扣益提示、
 * HP/MP 恢复值，抄一遍必漏。所以把"结束 + 拼日志 + 写日志"收在这里，
 * 遮罩和面板共用。
 */
import { computed, ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useUIStore } from '../stores/ui'
import { formatNumber } from '../utils/format'

export function useSeclusionSettle() {
  const store = usePlayerStore()
  const uiStore = useUIStore()
  const ending = ref(false)

  /** 强行出关损失百分比文案（如 "50%"），跟 GM 配置走，不硬编码 */
  const forcedPenaltyPercent = computed(() => {
    const penalty = store.systemConfig?.seclusion?.deep?.forced_penalty ?? 0.5
    return `${Math.round(penalty * 100)}%`
  })

  /**
   * 拼装闭关结算日志文案
   *
   * 常规闭关：必须展示 成功 / 失败 / 走火入魔 各多少次（多轮判定汇总）。
   * 深度闭关：保持时长收益语义，强行出关时提示扣益。
   *
   * 后端 routes/seclusion.js 返回：exp_gain / forced_end / hp_restored / mp_restored
   *   以及 success_count / fail_count / deviation_count / encounters / hp_loss。
   * exp_gain 必须用 ?? 0，禁止回退到 player.exp —— 那是总修为的 BigInt 字符串，
   * 立即结束（exp_gain=0）时会显示出"获得 99999999999 修为"。
   *
   * @param {Object} res  接口返回体
   * @param {boolean} isDeep  本次闭关是不是深度闭关（必须在状态被清空前抓住）
   * @param {boolean} forcedRequested  是不是玩家主动点的"强行出关"
   */
  function buildSettleLog(res, isDeep, forcedRequested) {
    const gain = Number(res?.data?.exp_gain ?? 0)
    const isForced = !!res?.data?.forced_end || forcedRequested
    const hpRestored = Number(res?.data?.hp_restored ?? 0)
    const mpRestored = Number(res?.data?.mp_restored ?? 0)
    const hpLoss = Number(res?.data?.hp_loss ?? 0)
    const modeLabel = isDeep ? '深度闭关' : '闭关'

    let content
    if (isDeep) {
      if (isForced) {
        content = `强行出关！${modeLabel}未达最短时长，损失 ${forcedPenaltyPercent.value} 收益，本次获得修为 ${formatNumber(gain)} 点。`
      } else {
        content = `结束${modeLabel}，本次修炼共获得修为 ${formatNumber(gain)} 点。`
      }
    } else {
      // 常规闭关：多轮判定结果次数必须出现在提示里
      const successCount = Number(res?.data?.success_count ?? 0)
      const failCount = Number(res?.data?.fail_count ?? 0)
      const deviationCount = Number(res?.data?.deviation_count ?? 0)
      const rounds = Number(res?.data?.rounds ?? 0)
      content = `常规闭关结束：成功 ${successCount} 次，失败 ${failCount} 次，走火入魔 ${deviationCount} 次，本次获得修为 ${formatNumber(gain)} 点`
      if (rounds > 0) {
        content += `（共 ${rounds} 轮`
        if (res?.data?.guarded && deviationCount > 0) {
          content += '，护法已减免走火入魔伤害'
        }
        content += '）'
      }
      content += '。'
    }

    // HP/MP：只在确实有变化时补，避免"+0"这种没信息量的尾巴
    const restoreParts = []
    if (hpRestored > 0) restoreParts.push(`气血 +${formatNumber(hpRestored)}`)
    else if (hpRestored < 0) restoreParts.push(`气血 ${formatNumber(hpRestored)}`)
    if (mpRestored > 0) restoreParts.push(`灵力 +${formatNumber(mpRestored)}`)
    if (restoreParts.length > 0) {
      content += ` 吐纳归元 ${restoreParts.join('、')}。`
    }
    if (hpLoss > 0) {
      content += ` 走火入魔损气血 ${formatNumber(hpLoss)}。`
    }

    // 奇遇
    const encounters = res?.data?.encounters
    if (Array.isArray(encounters) && encounters.length > 0) {
      content += ` 奇遇：${encounters.map(e => e.name || e.id).join('、')}。`
    }
    return content
  }

  /**
   * @param {boolean} force  true = 强行出关（深度闭关语义入口），false = 正常结束
   */
  async function settle(force) {
    if (ending.value) return { skipped: true }
    // 结束后 store 会把 seclusion_mode 复位成 normal，所以模式要在调用前抓
    const wasDeep = store.player?.seclusion_mode === 'deep'
    ending.value = true
    try {
      const res = force
        ? await store.forceEndSeclusion()
        : await store.endSeclusion()
      const hasDeviation = Number(res?.data?.deviation_count ?? 0) > 0
      const isForced = !!(res?.data?.forced_end || force)
      uiStore.addLog({
        content: buildSettleLog(res, wasDeep, force),
        type: isForced || hasDeviation ? 'warning' : 'success',
        actorId: 'self',
      })
      return { res }
    } catch (err) {
      console.error(force ? '强行出关失败:' : '结束闭关失败:', err)
      uiStore.showApiError(err, force ? '强行出关失败，请重试' : '结束闭关失败，请重试')
      return { error: err }
    } finally {
      ending.value = false
    }
  }

  return {
    ending,
    forcedPenaltyPercent,
    endNow: () => settle(false),
    forceEndNow: () => settle(true),
  }
}
