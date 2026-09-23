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

        <!-- AI 配置（玩家自定义接口，走自己的额度） -->
        <section v-if="aiFeatureEnabled">
          <h3 class="flex items-center gap-2 text-fg-primary font-bold mb-3 text-lg font-display">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>
            AI 配置
          </h3>
          <div class="bg-surface-raised rounded border border-line-subtle p-4">
            <p class="text-fg-faint text-xs mb-3">填写你自己的 AI 接口后，剧情/事件描述将使用你的接口与额度，不消耗服务器公共额度。支持任意 OpenAI 兼容服务（DeepSeek、Kimi、硅基流动、中转站等）。</p>

            <!-- 启用开关（已保存配置才显示） -->
            <div v-if="aiSaved" class="flex items-center justify-between mb-3">
              <span class="text-fg-secondary text-sm">使用我的 AI 接口</span>
              <button
                @click="toggleAiEnabled"
                :disabled="aiSaving"
                class="relative w-11 h-6 rounded-full transition-colors focus-ring"
                :class="aiForm.enabled ? 'bg-gold-600' : 'bg-surface-active border border-line'"
                role="switch" :aria-checked="aiForm.enabled" aria-label="启用个人 AI 配置"
              >
                <span class="absolute top-0.5 w-5 h-5 bg-surface-base rounded-full shadow transition-all" :class="aiForm.enabled ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </div>

            <div class="space-y-3">
              <!-- Base URL -->
              <div>
                <label class="block text-xs text-fg-muted mb-1">Base URL（含版本路径）</label>
                <input v-model="aiForm.base_url" type="text"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-sm text-fg-secondary focus-ring focus:border-gold-600"
                  placeholder="https://api.deepseek.com/v1">
              </div>
              <!-- 模型名称 -->
              <div>
                <label class="block text-xs text-fg-muted mb-1">模型名称</label>
                <input v-model="aiForm.model" type="text"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-sm text-fg-secondary focus-ring focus:border-gold-600"
                  placeholder="如 deepseek-chat">
              </div>
              <!-- API Key -->
              <div>
                <label class="block text-xs text-fg-muted mb-1">API Key</label>
                <input v-model="aiForm.api_key" type="password"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-sm text-fg-secondary focus-ring focus:border-gold-600"
                  :placeholder="aiSaved && aiSavedConfig?.has_api_key ? `已配置（${aiSavedConfig.api_key_masked}），留空则不修改` : '输入你的 API Key'">
                <p class="mt-1 text-xs text-fg-faint">加密存储，任何人（包括后台）都无法再查看完整 Key</p>
              </div>
            </div>

            <!-- 测试连接结果（详细原因展示） -->
            <div v-if="aiTestResult" class="mt-3 rounded border p-2.5 text-xs"
              :class="aiTestResult.status === 'success'
                ? 'border-green-700/50 bg-green-900/20 text-green-300'
                : 'border-red-700/50 bg-red-900/20 text-red-300'">
              <div class="font-bold">{{ aiTestResult.status === 'success' ? '✓ 连接成功' : '✗ 连接失败' }}</div>
              <div class="mt-1">{{ aiTestResult.message }}</div>
              <div v-if="aiTestResult.status === 'failed' && aiTestResult.detail" class="mt-1 opacity-80 wrap-cjk">
                {{ aiTestResult.detail }}
              </div>
            </div>

            <!-- 操作按钮：先测再存 -->
            <div class="flex gap-2 mt-4">
              <button
                @click="handleAiTest"
                :disabled="aiTesting || aiSaving"
                class="flex-1 py-2 bg-surface-active hover:bg-line-strong text-fg-secondary rounded border border-line transition-colors disabled:opacity-50 text-sm"
              >
                {{ aiTesting ? '测试中...' : '测试连接' }}
              </button>
              <button
                @click="handleAiSave"
                :disabled="aiSaving || aiTesting"
                class="flex-1 py-2 bg-gold-600 hover:bg-gold-500 text-surface-sunken font-bold rounded transition-colors disabled:opacity-50 text-sm"
              >
                {{ aiSaving ? '保存中...' : '保存' }}
              </button>
            </div>
            <!-- 清除配置 -->
            <button
              v-if="aiSaved"
              @click="showAiDeleteConfirm = true"
              :disabled="aiSaving"
              class="w-full mt-2 py-1.5 text-xs text-fg-faint hover:text-red-400 transition-colors disabled:opacity-50"
            >
              清除 AI 配置（回到服务器公共接口）
            </button>
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

      <!-- 清除 AI 配置确认弹窗 -->
      <transition name="modal">
        <div v-if="showAiDeleteConfirm" class="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="showAiDeleteConfirm = false"></div>
          <div class="relative w-full max-w-sm bg-surface-base border border-line rounded-panel shadow-2xl p-6 animate-fade-in" role="dialog" aria-label="确认清除 AI 配置">
            <h3 class="text-lg font-bold text-gold-500 mb-3 font-display">确认清除 AI 配置</h3>
            <p class="text-fg-secondary text-sm mb-6">清除后将回到使用服务器公共 AI 接口的状态，你的 API Key 会被立即删除且不可恢复。</p>
            <div class="flex justify-end gap-3">
              <button
                @click="showAiDeleteConfirm = false"
                class="px-4 py-2 bg-surface-active hover:bg-line-strong text-fg-secondary rounded transition-colors"
              >取消</button>
              <button
                @click="doDeleteAiConfig"
                class="px-4 py-2 bg-red-700 hover:bg-red-600 text-red-100 rounded font-bold transition-colors"
              >确认清除</button>
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
import { ref, reactive, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { getQQAuthorizeUrl, getQQBinding, unbindQQ } from '../../api/auth'
import { getUserAiConfig, saveUserAiConfig, deleteUserAiConfig, testUserAiConfig } from '../../api/user_ai'
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
    await playerStore.scheduleFetchPlayer(0)
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

// ===== 个人 AI 配置 =====
// 服务器是否开放了自定义 AI 功能（关闭时整个区块隐藏）
const aiFeatureEnabled = ref(false)
// 已保存的配置（用于回填表单与判断"首次保存必须填 Key"）
const aiSavedConfig = ref(null)
const aiSaved = ref(false)
const aiSaving = ref(false)
const aiTesting = ref(false)
const aiTestResult = ref(null)
const showAiDeleteConfirm = ref(false)

// 表单数据；api_key 不回填（后端只存密文），留空表示不修改
const aiForm = reactive({
  base_url: '',
  model: '',
  api_key: '',
  enabled: true
})

/**
 * 拉取当前玩家的个人 AI 配置并回填表单
 * 读不到时保持区块隐藏，避免玩家点了没反应
 */
const loadAiConfig = async () => {
  try {
    const res = await getUserAiConfig()
    const data = res.data?.data || res.data
    aiFeatureEnabled.value = !!data?.feature_enabled
    aiSavedConfig.value = data?.config || null
    aiSaved.value = !!data?.config
    if (data?.config) {
      aiForm.base_url = data.config.base_url || ''
      aiForm.model = data.config.model || ''
      aiForm.enabled = data.config.enabled !== false
    }
  } catch (error) {
    aiFeatureEnabled.value = false
  }
}

/**
 * 切换"使用我的 AI 接口"开关：直接保存 enabled 状态（表单其余字段不变）
 */
const toggleAiEnabled = async () => {
  aiSaving.value = true
  try {
    const target = !aiForm.enabled
    await saveUserAiConfig({
      base_url: aiForm.base_url,
      model: aiForm.model,
      // 未重新输入 Key 时不传 api_key，后端保留旧 Key
      enabled: target
    })
    aiForm.enabled = target
    uiStore.showToast(target ? '已启用个人 AI 接口' : '已停用，回到服务器公共接口', 'success')
  } catch (error) {
    uiStore.showApiError(error, '切换失败')
  } finally {
    aiSaving.value = false
  }
}

/**
 * 测试连接：把当前表单值发给后端验证（不需要先保存）
 * 后端会把表单里没填的字段用已保存的值补齐（如未重输 Key 时复用旧 Key）
 */
const handleAiTest = async () => {
  if (!aiForm.base_url && !aiSaved) {
    uiStore.showToast('请先填写 Base URL', 'error')
    return
  }
  if (!aiForm.model && !aiSaved) {
    uiStore.showToast('请先填写模型名称', 'error')
    return
  }
  aiTesting.value = true
  aiTestResult.value = null
  try {
    const res = await testUserAiConfig({
      base_url: aiForm.base_url || undefined,
      model: aiForm.model || undefined,
      api_key: aiForm.api_key || undefined,
      timeout: aiSavedConfig.value?.timeout || undefined
    })
    // 接口永不返回 5xx：失败也以 200 + status='failed' + 详细原因返回
    aiTestResult.value = res.data?.data || res.data
  } catch (error) {
    uiStore.showApiError(error, '测试请求失败')
  } finally {
    aiTesting.value = false
  }
}

/**
 * 保存个人 AI 配置（首次保存必须填写 Key）
 */
const handleAiSave = async () => {
  if (!aiForm.base_url.trim() || !aiForm.model.trim()) {
    uiStore.showToast('请填写 Base URL 与模型名称', 'error')
    return
  }
  // 首次保存必须有 Key；编辑时留空表示沿用旧 Key
  if (!aiSaved && !aiForm.api_key) {
    uiStore.showToast('首次配置请填写 API Key', 'error')
    return
  }
  aiSaving.value = true
  try {
    await saveUserAiConfig({
      base_url: aiForm.base_url.trim(),
      model: aiForm.model.trim(),
      api_key: aiForm.api_key || undefined,
      enabled: aiForm.enabled
    })
    uiStore.showToast('AI 配置已保存', 'success')
    aiForm.api_key = ''
    // 重新拉取以刷新脱敏 Key 展示
    await loadAiConfig()
  } catch (error) {
    uiStore.showApiError(error, '保存失败')
  } finally {
    aiSaving.value = false
  }
}

/**
 * 清除个人 AI 配置：删除后 AI 调用回到服务器公共配置
 */
const doDeleteAiConfig = async () => {
  showAiDeleteConfirm.value = false
  aiSaving.value = true
  try {
    await deleteUserAiConfig()
    uiStore.showToast('已清除个人 AI 配置', 'success')
    // 重置表单与状态
    aiSaved.value = false
    aiSavedConfig.value = null
    aiForm.base_url = ''
    aiForm.model = ''
    aiForm.api_key = ''
    aiForm.enabled = true
    aiTestResult.value = null
  } catch (error) {
    uiStore.showApiError(error, '清除失败')
  } finally {
    aiSaving.value = false
  }
}

onMounted(() => {
  loadQQBinding()
  loadAiConfig()
})
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
