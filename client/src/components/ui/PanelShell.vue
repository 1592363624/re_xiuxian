<script setup>
/**
 * 功能面板统一外壳
 *
 * 全站所有停靠面板的根节点。它负责三件事，面板自己不要再写一遍：
 *   1. 右坞停靠 —— 根节点带 .panel-shell、遮罩带 .panel-backdrop、主体带 .panel-body，
 *      这三个类名是 style.css 里停靠规则认的契约，改名会导致面板脱离右坞。
 *   2. 关闭交互 —— Esc、点击遮罩（窄屏）、右上角按钮，窄屏时锁 body 滚动。
 *   3. 三种数据态 —— loading / error / empty，避免每个面板各自发明一套「加载中…」。
 *
 * 面板只需要：
 *   <PanelShell title="坊市" :loading="loading" @close="$emit('close')">
 *     ...内容...
 *   </PanelShell>
 *
 * ⚠ loading / error / empty 三者任一为真时，外壳会整块替换掉默认插槽。
 *   所以带页签栏的面板不要把这三个状态交给外壳 —— 页签会跟着被藏掉，
 *   玩家再也切不到别的页签。典型翻车现场：新号"一本功法都没习得"时
 *   把 :empty 交给外壳，结果「可习得」页签一起消失，账号直接卡死在入门。
 *   带页签的面板请把 LoadingBlock / EmptyState 放在插槽内部、页签栏之下。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import LoadingBlock from './LoadingBlock.vue'
import ErrorState from './ErrorState.vue'
import EmptyState from './EmptyState.vue'

const props = defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  /** 面板宽度档位；表格型玩法用 xl/2xl，单列表单用 sm/md */
  size: { type: String, default: 'lg', validator: v => ['sm', 'md', 'lg', 'xl', '2xl'].includes(v) },
  loading: { type: Boolean, default: false },
  /** 出错文案；非空时优先于 empty 展示错误态 */
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  emptyText: { type: String, default: '暂无数据' },
  emptyHint: { type: String, default: '' },
  /** 内容自带滚动容器（含 Tab 切换的面板）时置 true，外壳不再包一层滚动 */
  scopedScroll: { type: Boolean, default: false },
  /**
   * 撑满停靠高度。列表/背包等工作台面板需要内部 flex 各占一截时打开；
   * 表单型短面板保持默认（内容有多高面板就多高），避免正文和底栏之间空出一大块。
   * scopedScroll 面板内部通常写死 h-full，默认自动 fill。
   */
  fill: { type: Boolean, default: false },
  bodyClass: { type: String, default: '' },
  closable: { type: Boolean, default: true },
  showClose: { type: Boolean, default: true },
  /** 允许点击遮罩关闭；带未保存输入的面板应设为 false */
  backdropClose: { type: Boolean, default: true },
})

const emit = defineEmits(['close', 'retry'])

const SIZE_CLASS = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
  '2xl': 'max-w-7xl',
}

const bodySize = computed(() => SIZE_CLASS[props.size])
const isFill = computed(() => props.fill || props.scopedScroll)
const showPlaceholder = computed(() => props.loading || !!props.error || props.empty)
const bodyEl = ref(null)

const onKey = (e) => {
  if (e.key === 'Escape' && props.closable) emit('close')
}

let prevOverflow = ''
let prevFocus = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // 窄屏是全屏 modal，底层不该跟着滚；桌面端停靠时这个锁无影响
  if (!props.closable) return
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  // 把焦点收进面板：键盘用户点开面板后 Tab 不该还落在背后的界面上
  prevFocus = document.activeElement
  nextTick(() => bodyEl.value?.focus({ preventScroll: true }))
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = prevOverflow
  // 关闭后焦点交还触发方，避免焦点掉到 body 上
  if (prevFocus && typeof prevFocus.focus === 'function') {
    prevFocus.focus({ preventScroll: true })
  }
})
</script>

<template>
  <div class="panel-shell fixed inset-0 z-panel flex items-center justify-center p-3 sm:p-4">
    <div
      class="panel-backdrop absolute inset-0 bg-black/70 backdrop-blur-sm"
      :aria-hidden="true"
      @click="closable && backdropClose ? emit('close') : null"
    ></div>

    <section
      ref="bodyEl"
      class="panel-body relative flex flex-col w-full overflow-hidden
             bg-surface-base border border-line rounded-panel shadow-2xl shadow-black/60
             outline-none"
      :class="[
        bodySize,
        isFill ? 'panel-body--fill h-[88vh] max-h-[88vh]' : 'max-h-[88vh] h-auto',
      ]"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header
        class="shrink-0 flex items-center gap-3 px-4 h-12 border-b border-line-subtle bg-surface-raised"
      >
        <h2 class="font-display text-[15px] font-bold text-gold-500 tracking-[0.08em] truncate">
          {{ title }}
        </h2>
        <span v-if="hint" class="hidden sm:block text-[11px] text-fg-faint truncate">{{ hint }}</span>
        <div class="ms-auto flex items-center gap-2 shrink-0">
          <slot name="header-actions" />
          <button
            v-if="showClose && closable"
            type="button"
            @click="emit('close')"
            class="focus-ring grid place-items-center w-8 h-8 -mr-1 rounded text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors"
            aria-label="关闭面板"
            title="关闭（Esc）"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </header>

      <!-- 占位态（加载/错误/空）由外壳统一给，正文只在有数据时渲染 -->
      <div
        v-if="showPlaceholder"
        class="flex-1 min-h-0 overflow-y-auto"
        :class="scopedScroll ? '' : 'p-4'"
      >
        <LoadingBlock v-if="loading" />
        <ErrorState v-else-if="error" :message="error" @retry="emit('retry')" />
        <EmptyState v-else :text="emptyText" :hint="emptyHint">
          <slot name="empty-action" />
        </EmptyState>
      </div>

      <div
        v-else
        class="flex-1 min-h-0"
        :class="scopedScroll ? '' : 'overflow-y-auto p-4'"
      >
        <slot />
      </div>

      <footer
        v-if="$slots.footer"
        class="shrink-0 flex items-center gap-2 px-4 py-2 min-h-12 border-t border-line-subtle bg-surface-raised"
      >
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>
