<template>
  <!-- 仅管理员可见：GM 测试用的「立即完成」，用于跳过耗时操作的等待时间 -->
  <button
    v-if="isAdmin"
    type="button"
    :disabled="disabled"
    class="px-3 py-1 text-xs rounded border border-amber-700/60 text-amber-300 hover:text-amber-200 hover:border-amber-500 hover:bg-amber-950/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider shrink-0"
    :title="title"
    @click="handleClick"
  >
    <span v-if="busy">加速中...</span>
    <span v-else>立即完成</span>
  </button>
</template>

<script setup>
/**
 * 管理员「立即完成」按钮（GM 测试加速专用）
 *
 * 作用：把当前操作的时间戳前推，使其等同于「已按计划时长自然完成」，跳过等待。
 *
 * 关键约束（不得影响本次操作的流程与结果）：
 *   本组件自身**不做结算**，只负责：
 *     1) 调用后端 /admin/quick-finish 完成时间加速；
 *     2) 加速成功后 emit('done')，由父组件触发各自原有的结算流程
 *        （结束闭关 / 完成历练 / 强制结算悟道）。
 *   这样加速后走的仍是玩家正常的结算代码路径，收益与结果和自然到点完全一致。
 *
 * 权限：非管理员不渲染（前端隐藏）+ 后端 adminCheck 双保险（即使被伪造请求也会 403）。
 */
import { computed, ref } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { quickFinish } from '../../api/admin_quick_finish'

const props = defineProps({
  /** 目标操作类型，与后端白名单一致 */
  state: { type: String, required: true },
  /** 父组件结算中的 loading 态，用于禁用按钮避免重复点击 */
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['done'])

const store = usePlayerStore()
const uiStore = useUIStore()
const busy = ref(false)

/** 是否管理员：player.role === 'admin'（后端权威字段） */
const isAdmin = computed(() => store.player?.role === 'admin')

/** 按钮禁用：自身加速中或父组件结算中 */
const disabled = computed(() => busy.value || props.loading)

const title = computed(() => 'GM 测试用：跳过等待，按计划时长立即完成（结果与自然到点一致）')

/**
 * 点击：先加速时间，再通知父组件执行原有结算流程
 */
const handleClick = async () => {
  if (disabled.value) return
  busy.value = true
  try {
    const res = await quickFinish(props.state)
    const finished = res?.data?.data?.finished || []
    // 目标操作不在加速结果里，说明当前并未进行中，给出提示且不触发结算
    if (!finished.some((item) => item.state === props.state)) {
      uiStore.showToast('当前没有进行中的该操作，无需加速', 'warning')
      return
    }
    emit('done')
  } catch (error) {
    console.error('立即完成失败:', error)
    uiStore.showApiError(error, '立即完成失败')
  } finally {
    busy.value = false
  }
}
</script>