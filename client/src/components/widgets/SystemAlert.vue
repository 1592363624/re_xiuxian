<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useNotificationStore } from '../../stores/notification'
import { useUIStore } from '../../stores/ui'

const props = defineProps({
  modelValue: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'dismiss'])

const notificationStore = useNotificationStore()
const uiStore = useUIStore()

const visible = ref(false)
const currentAlert = ref(null)
const dismissTimer = ref(null)
const isAnimating = ref(false)
const isHovered = ref(false)

const alert = computed({
  get: () => props.modelValue || notificationStore.systemAlert,
  set: (val) => {
    if (props.modelValue) {
      emit('update:modelValue', val)
    } else {
      if (val) {
        notificationStore.showSystemAlert(val)
      } else {
        notificationStore.dismissSystemAlert()
      }
    }
  }
})

const getAlertStyle = (type) => {
  const styles = {
    breakthrough: {
      bg: 'bg-gradient-to-br from-amber-900/95 via-yellow-900/95 to-amber-800/95',
      border: 'border-amber-500',
      icon: '🏆',
      iconBg: 'bg-amber-500/20',
      textColor: 'text-amber-100',
      glow: 'shadow-[0_0_50px_rgba(245,158,11,0.5)]'
    },
    death: {
      bg: 'bg-gradient-to-br from-red-900/95 via-rose-900/95 to-red-800/95',
      border: 'border-red-500',
      icon: '💀',
      iconBg: 'bg-red-500/20',
      textColor: 'text-red-100',
      glow: 'shadow-[0_0_50px_rgba(239,68,68,0.5)]'
    },
    achievement: {
      bg: 'bg-gradient-to-br from-purple-900/95 via-violet-900/95 to-purple-800/95',
      border: 'border-purple-500',
      icon: '⭐',
      iconBg: 'bg-purple-500/20',
      textColor: 'text-purple-100',
      glow: 'shadow-[0_0_50px_rgba(168,85,247,0.5)]'
    },
    event: {
      bg: 'bg-gradient-to-br from-cyan-900/95 via-blue-900/95 to-cyan-800/95',
      border: 'border-cyan-500',
      icon: '🎭',
      iconBg: 'bg-cyan-500/20',
      textColor: 'text-cyan-100',
      glow: 'shadow-[0_0_50px_rgba(6,182,212,0.5)]'
    },
    announcement: {
      bg: 'bg-gradient-to-br from-amber-900/95 via-yellow-900/95 to-orange-800/95',
      border: 'border-yellow-500',
      icon: '📢',
      iconBg: 'bg-yellow-500/20',
      textColor: 'text-yellow-100',
      glow: 'shadow-[0_0_50px_rgba(234,179,8,0.5)]'
    },
    warning: {
      bg: 'bg-gradient-to-br from-orange-900/95 via-red-900/95 to-orange-800/95',
      border: 'border-orange-500',
      icon: '⚠️',
      iconBg: 'bg-orange-500/20',
      textColor: 'text-orange-100',
      glow: 'shadow-[0_0_50px_rgba(249,115,22,0.5)]'
    },
    milestone: {
      bg: 'bg-gradient-to-br from-emerald-900/95 via-teal-900/95 to-emerald-800/95',
      border: 'border-emerald-500',
      icon: '🎯',
      iconBg: 'bg-emerald-500/20',
      textColor: 'text-emerald-100',
      glow: 'shadow-[0_0_50px_rgba(16,185,129,0.5)]'
    },
    default: {
      bg: 'bg-gradient-to-br from-amber-900/95 via-yellow-900/95 to-amber-800/95',
      border: 'border-amber-500',
      icon: '🔔',
      iconBg: 'bg-amber-500/20',
      textColor: 'text-amber-100',
      glow: 'shadow-[0_0_50px_rgba(245,158,11,0.5)]'
    }
  }
  return styles[type] || styles.default
}

const currentStyle = computed(() => {
  if (!currentAlert.value) return getAlertStyle('default')
  return getAlertStyle(currentAlert.value.type || 'default')
})

const resetDismissTimer = () => {
  if (dismissTimer.value) {
    clearTimeout(dismissTimer.value)
    dismissTimer.value = null
  }

  if (currentAlert.value && (currentAlert.value.duration || 5000) > 0 && !isHovered.value) {
    const duration = currentAlert.value.duration || 5000
    dismissTimer.value = setTimeout(() => {
      dismiss()
    }, duration)
  }
}

const onMouseEnter = () => {
  isHovered.value = true
  if (dismissTimer.value) {
    clearTimeout(dismissTimer.value)
    dismissTimer.value = null
  }
}

const onMouseLeave = () => {
  isHovered.value = false
  resetDismissTimer()
}

const show = (alertData) => {
  if (dismissTimer.value) {
    clearTimeout(dismissTimer.value)
  }
  
  currentAlert.value = alertData
  isAnimating.value = true
  isHovered.value = false
  
  setTimeout(() => {
    visible.value = true
    isAnimating.value = false
  }, 50)

  const duration = alertData.duration || 5000
  if (duration > 0) {
    dismissTimer.value = setTimeout(() => {
      dismiss()
    }, duration)
  }
}

const dismiss = () => {
  if (dismissTimer.value) {
    clearTimeout(dismissTimer.value)
    dismissTimer.value = null
  }
  
  visible.value = false
  
  setTimeout(() => {
    currentAlert.value = null
    alert.value = null
    emit('dismiss')
    notificationStore.dismissSystemAlert()
  }, 300)
}

watch(() => notificationStore.systemAlert, (newAlert) => {
  if (newAlert && newAlert.visible) {
    show(newAlert)
  }
})

watch(alert, (newAlert) => {
  if (newAlert && newAlert.visible) {
    show(newAlert)
  }
})

onMounted(() => {
  if (notificationStore.systemAlert && notificationStore.systemAlert.visible) {
    show(notificationStore.systemAlert)
  }
})

onUnmounted(() => {
  if (dismissTimer.value) {
    clearTimeout(dismissTimer.value)
  }
})

defineExpose({ show, dismiss })
</script>

<template>
  <Teleport to="body">
    <Transition name="alert">
      <div
        v-if="visible && currentAlert"
        class="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none"
      >
        <!-- 遮罩层 -->
        <div 
          class="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
          @click="dismiss"
        ></div>
        
        <!-- 通知内容 -->
        <div 
          class="relative mx-4 max-w-md w-full pointer-events-auto transform transition-all duration-500"
          :class="[
            currentStyle.bg,
            currentStyle.border,
            currentStyle.glow,
            isAnimating ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
          ]"
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
        >
          <!-- 顶部装饰线 -->
          <div 
            class="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent"
          ></div>
          
          <!-- 装饰粒子 -->
          <div class="absolute inset-0 overflow-hidden pointer-events-none">
            <div class="absolute top-2 left-4 w-1 h-1 bg-amber-400/30 rounded-full animate-ping"></div>
            <div class="absolute top-4 right-8 w-1.5 h-1.5 bg-yellow-400/20 rounded-full animate-pulse"></div>
            <div class="absolute bottom-3 left-8 w-1 h-1 bg-amber-500/30 rounded-full animate-ping" style="animation-delay: 1s;"></div>
          </div>
          
          <div class="relative p-6 border-2 rounded-lg">
            <!-- 关闭按钮 -->
            <button 
              @click="dismiss"
              class="absolute top-2 right-2 p-1.5 rounded-full hover:bg-white/10 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-white/70">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
            
            <!-- 图标 -->
            <div 
              class="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full"
              :class="currentStyle.iconBg"
            >
              <span class="text-3xl">{{ currentStyle.icon }}</span>
            </div>
            
            <!-- 标题 -->
            <h3 
              class="text-xl font-bold text-center mb-3"
              :class="currentStyle.textColor"
            >
              {{ currentAlert.title || '系统通知' }}
            </h3>
            
            <!-- 内容 -->
            <p 
              class="text-center text-sm leading-relaxed"
              :class="currentStyle.textColor + '/90'"
            >
              {{ currentAlert.message || currentAlert.content }}
            </p>
            
            <!-- 底部装饰 -->
            <div class="mt-4 pt-3 border-t border-white/10">
              <div class="flex justify-center gap-1">
                <div 
                  v-for="i in 3" 
                  :key="i"
                  class="w-1.5 h-1.5 rounded-full"
                  :class="i === 2 ? 'bg-amber-400' : 'bg-white/30'"
                  :style="{ animationDelay: `${i * 0.2}s` }"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.alert-enter-active,
.alert-leave-active {
  transition: all 0.3s ease;
}

.alert-enter-from,
.alert-leave-to {
  opacity: 0;
}

.alert-enter-from .absolute.inset-0.bg-black\/60,
.alert-leave-to .absolute.inset-0.bg-black\/60 {
  opacity: 0;
}

.alert-enter-from .relative,
.alert-leave-to .relative {
  transform: scale(0.9) translateY(-20px);
}
</style>
