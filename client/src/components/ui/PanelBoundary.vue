<!--
 * 面板故障边界：兜住子面板在渲染期抛出的异常。
 *
 * 为什么必须有这一层：43 个面板各自解析形态各异的服务端数据，任一面板渲染期
 * 抛错都会沿组件树向上冒泡，把整个 <RouterView>（状态栏 / 日志 / 右坞一起）拆掉，
 * 玩家只能刷新页面。有了边界，坏的只是那一个面板，游戏照玩。
 *
 * ⚠ 换面板用的 :key 必须挂在「本组件」上而不是内层 <component> 上：
 *   否则 error 状态会跟着边界实例存活到下一个面板，从坏面板切到好面板也永远停在错误页。
-->
<script setup>
import { ref, onErrorCaptured } from 'vue'
import PanelShell from './PanelShell.vue'
import ErrorState from './ErrorState.vue'

defineProps({
  /** 出错兜底面板的标题，取当前面板 id */
  label: { type: String, default: '功能面板' }
})

const emit = defineEmits(['close'])
const error = ref(null)

onErrorCaptured((err) => {
  error.value = err
  console.error(`[PanelBoundary] ${err?.message || err}`, err)
  // 不再向上冒泡：到这里为止
  return false
})

// 出错时 slot 已被 v-if 卸载，清空 error 即整个面板重挂，等同于重新进面板
const retry = () => {
  error.value = null
}
</script>

<template>
  <PanelShell
    v-if="error"
    :title="label"
    hint="渲染异常"
    @close="emit('close')"
  >
    <ErrorState
      :message="`该面板加载失败：${error.message || '未知异常'}`"
      @retry="retry"
    />
  </PanelShell>
  <slot v-else />
</template>
