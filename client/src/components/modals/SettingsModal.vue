<template>
  <div class="fixed inset-0 z-system flex items-center justify-center p-4">
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>
    
    <!-- Modal Content -->
    <div class="relative w-full max-w-md bg-surface-base border border-line rounded-panel shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-fade-in" role="dialog" aria-label="设置">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-line-subtle bg-surface-raised">
        <h2 class="text-xl font-bold text-gold-500 tracking-wider font-display">设置</h2>
        <button @click="$emit('close')" type="button" class="focus-ring rounded-control text-fg-faint hover:text-fg-secondary transition-colors" aria-label="关闭设置">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      
      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-6 space-y-8 scroll-thin">

        <!-- QQ 账号绑定 -->
        <section v-if="qqEnabled">
          <h3 class="flex items-center gap-2 text-fg-primary font-bold mb-3 text-lg font-display">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            QQ 登录
          </h3>
          <div class="bg-surface-raised rounded border border-line-subtle p-4">
            <template v-if="qqBinding">
              <div class="flex items-center gap-3 mb-4">
                <img v-if="qqBinding.avatarUrl" :src="qqBinding.avatarUrl" alt="QQ 头像" class="w-10 h-10 rounded-full border border-line object-cover">
                <div v-else class="w-10 h-10 rounded-full bg-surface-hover border border-line flex items-center justify-center text-fg-faint text-[10px] font-black">QQ</div>
                <div class="min-w-0">
                  <p class="text-fg-primary font-bold truncate">{{ qqBinding.nickname || '已绑定的 QQ' }}</p>
                  <p class="text-xs text-fg-faint">绑定于 {{ formatBoundAt(qqBinding.boundAt) }}</p>
                </div>
              </div>
              <p class="text-xs text-fg-faint mb-3">下次起可直接在登录页用这个 QQ 进入游戏。换绑需先解绑；解绑后本账号仍只能用账号密码登录。</p>
              <AppButton
                @click="showUnbindConfirm = true"
                :disabled="qqBusy"
                variant="default"
                size="md"
                block
              >
                {{ qqBusy ? '处理中...' : '解除绑定' }}
              </AppButton>
            </template>
            <template v-else>
              <p class="text-fg-faint text-sm mb-4">本账号还没有绑定 QQ。绑定后即可跳过账号密码，直接用 QQ 登录。</p>
              <!-- QQ 品牌蓝 #12B7F5 无对应令牌，且套 AppButton 变体会改掉品牌色，故保留自绘按钮 -->
              <button
                @click="startQQBind"
                :disabled="qqBusy"
                class="w-full py-2 bg-[#12B7F5]/90 hover:bg-[#12B7F5] text-surface-sunken font-bold rounded-control transition-colors disabled:opacity-50"
              >
                {{ qqBusy ? '跳转中...' : '绑定 QQ' }}
              </button>
            </template>
          </div>
        </section>

        <!-- Game Management -->
        <section>
          <h3 class="flex items-center gap-2 text-fg-primary font-bold mb-3 text-lg font-display">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
            重新开始游戏
          </h3>
          <div class="bg-surface-raised rounded border border-line-subtle p-4">
            <p class="text-fg-faint text-sm mb-4">清除所有本地缓存并退出登录，返回登录界面。</p>
            <button 
              @click="handleLogout"
              class="w-full flex items-center justify-center gap-2 py-3 bg-red-900/80 hover:bg-red-800 text-red-100 rounded border border-red-700/50 transition-all font-bold shadow-lg hover:shadow-red-900/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path><path d="M16 16l5-5"></path><path d="M21 21v-5h-5"></path></svg>
              重新开始游戏 (注销)
            </button>
          </div>
        </section>

        <!-- Shortcuts -->
        <section>
          <h3 class="flex items-center gap-2 text-fg-primary font-bold mb-3 text-lg font-display">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            快捷键
          </h3>
          <div class="bg-surface-raised rounded border border-line-subtle overflow-hidden">
            <div class="flex items-center justify-between p-3 border-b border-line-subtle/50 last:border-0 hover:bg-surface-hover transition-colors">
              <span class="text-fg-muted">发送消息</span>
              <kbd class="px-2 py-1 bg-surface-hover rounded text-fg-secondary text-xs font-mono border border-line">Enter</kbd>
            </div>
            <div class="flex items-center justify-between p-3 border-b border-line-subtle/50 last:border-0 hover:bg-surface-hover transition-colors">
              <span class="text-fg-muted">关闭窗口</span>
              <kbd class="px-2 py-1 bg-surface-hover rounded text-fg-secondary text-xs font-mono border border-line">Esc</kbd>
            </div>
             <!-- Add more if needed -->
          </div>
          <p class="mt-2 text-xs text-fg-faint">查看所有可用的键盘快捷键，提高操作效率</p>
        </section>

        <!-- About -->
        <section>
          <h3 class="flex items-center gap-2 text-fg-primary font-bold mb-3 text-lg font-display">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            关于
          </h3>
          <div class="bg-surface-raised rounded border border-line-subtle p-4 space-y-3">
             <div class="flex justify-between items-center">
                <span class="text-fg-muted">游戏版本</span>
                <span class="text-gold-500 num">{{ gameVersion }}</span>
             </div>
             <div class="flex justify-between items-center text-xs text-fg-faint">
                <span>最后更新</span>
                <span>2026年7月23日</span>
             </div>
             
             <a href="https://github.com/1592363624/re_xiuxian" class="flex items-center justify-between p-3 bg-surface-hover/50 rounded border border-line/50 hover:bg-surface-hover hover:border-line-strong text-fg-secondary transition-all group">
                <div class="flex items-center gap-2">
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                   GitHub 仓库
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-fg-faint group-hover:text-fg-secondary"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
             </a>

             <a href="#" class="flex items-center justify-between p-3 bg-surface-hover/50 rounded border border-line/50 hover:bg-surface-hover hover:border-line-strong text-fg-secondary transition-all group">
                <div class="flex items-center gap-2">
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                   查看更新日志
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-fg-faint group-hover:text-fg-secondary"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
             </a>
          </div>
        </section>
      </div>
    </div>

    <!-- 注销确认弹窗（自定义，替代浏览器原生 confirm） -->
    <Teleport to="body">
      <transition name="modal">
        <div v-if="showLogoutConfirm" class="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <!-- 遮罩层 -->
          <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="showLogoutConfirm = false"></div>
          <!-- 弹窗内容 -->
          <div class="relative w-full max-w-sm bg-surface-base border border-line rounded-panel shadow-2xl p-6 animate-fade-in" role="dialog" aria-label="确认注销">
            <h3 class="text-lg font-bold text-gold-500 mb-3 font-display">确认注销</h3>
            <p class="text-fg-secondary text-sm mb-6">确定要注销当前账号吗？此操作将清除所有本地缓存并返回登录界面。</p>
            <div class="flex justify-end gap-3">
              <button
                @click="showLogoutConfirm = false"
                class="px-4 py-2 bg-surface-active hover:bg-line-strong text-fg-secondary rounded transition-colors"
              >取消</button>
              <button
                @click="doLogout"
                class="px-4 py-2 bg-red-700 hover:bg-red-600 text-red-100 rounded font-bold transition-colors"
              >确认注销</button>
            </div>
          </div>
        </div>
      </transition>

      <!-- QQ 解绑确认弹窗 -->
      <transition name="modal">
        <div v-if="showUnbindConfirm" class="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="showUnbindConfirm = false"></div>
          <div class="relative w-full max-w-sm bg-surface-base border border-line rounded-panel shadow-2xl p-6 animate-fade-in" role="dialog" aria-label="确认解除 QQ 绑定">
            <h3 class="text-lg font-bold text-gold-500 mb-3 font-display">确认解除 QQ 绑定</h3>
            <p class="text-fg-secondary text-sm mb-2">解绑后这个 QQ 将无法登录本账号。</p>
            <p class="text-fg-muted text-sm mb-6">请确认你记得本账号的账号密码，否则解绑后可能无法再进入游戏。</p>
            <div class="flex justify-end gap-3">
              <button
                @click="showUnbindConfirm = false"
                class="px-4 py-2 bg-surface-active hover:bg-line-strong text-fg-secondary rounded transition-colors"
              >取消</button>
              <button
                @click="doUnbind"
                class="px-4 py-2 bg-red-700 hover:bg-red-600 text-red-100 rounded font-bold transition-colors"
              >确认解绑</button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup>
/**
 * 设置弹窗组件
 * 提供账号绑定、游戏设置、快捷键说明、关于信息等功能
 */
import { ref, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { getQQAuthorizeUrl, getQQBinding, unbindQQ } from '../../api/auth'
// 引入版本号，保证设置面板与更新日志版本一致（单一数据源）
import { currentVersion } from '../../data/changelog'
import AppButton from '../ui/AppButton.vue'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()
const uiStore = useUIStore()
// 游戏版本（从 changelog 单一数据源读取，避免硬编码不同步）
const gameVersion = currentVersion

// 注销确认弹窗显示状态
const showLogoutConfirm = ref(false)

/**
 * 点击"重新开始游戏"按钮，弹出确认弹窗（替代浏览器原生 confirm）
 */
const handleLogout = () => {
  showLogoutConfirm.value = true
}

/**
 * 执行注销操作：清除玩家数据并刷新页面
 */
const doLogout = () => {
  showLogoutConfirm.value = false
  playerStore.logout()
  window.location.reload()
}

// ===== QQ 绑定 =====
const qqEnabled = ref(false)
const qqBinding = ref(null)
const qqBusy = ref(false)
const showUnbindConfirm = ref(false)

const loadQQBinding = async () => {
  try {
    const res = await getQQBinding()
    qqEnabled.value = !!res.data.enabled
    qqBinding.value = res.data.binding
  } catch (error) {
    // 绑定状态读不到时保持入口隐藏，避免让玩家点了却没反应
    qqEnabled.value = false
  }
}

/**
 * 发起绑定：整页跳去 QQ 授权，回调由后端处理后带参数回到首页，
 * 届时 App.vue 会弹出"绑定成功"提示，本面板重开时再拉一次状态即可。
 */
const startQQBind = async () => {
  qqBusy.value = true
  try {
    const res = await getQQAuthorizeUrl('bind')
    window.location.href = res.data.url
  } catch (error) {
    uiStore.showApiError(error, '无法发起 QQ 绑定，请稍后再试')
    qqBusy.value = false
  }
}

const doUnbind = async () => {
  showUnbindConfirm.value = false
  qqBusy.value = true
  try {
    await unbindQQ()
    uiStore.showToast('已解除 QQ 绑定', 'success')
    await loadQQBinding()
    // 左上角头像取自 /player/me 下发的 avatar_url，解绑后刷一次才会立刻回到默认图标
    await playerStore.fetchPlayer()
  } catch (error) {
    uiStore.showApiError(error, '解绑失败，请稍后再试')
  } finally {
    qqBusy.value = false
  }
}

const formatBoundAt = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(loadQQBinding)
</script>

<style scoped>
@keyframes fade-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.animate-fade-in {
  animation: fade-in 0.2s ease-out;
}
</style>
