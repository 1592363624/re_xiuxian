<script setup>
import { ref, watch, onMounted } from 'vue'
import apiClient from '../api'
// 修复：使用统一封装的 auth API 替代直接调用 apiClient
import {
  checkUnique as checkUniqueApi,
  login as loginApi,
  register as registerApi,
  getQQStatus,
  getQQAuthorizeUrl,
  getQQPending,
  bindQQPending
} from '../api/auth'
import { usePlayerStore } from '../stores/player'
import { useUIStore } from '../stores/ui'
// 修复：正则与道号长度限制从配置读取，避免硬编码
import { AUTH_REGEX, NICKNAME_LIMITS, UI_CONFIG } from '../config'
import { readQQRedirect } from '../utils/qqAuth'

const isLogin = ref(true) // true: 登录模式, false: 注册模式
const form = ref({
  username: '',
  password: '',
  nickname: ''
})
const loading = ref(false)
const errorMsg = ref('')

const usernameError = ref('')
const nicknameError = ref('')
const checking = ref({ username: false, nickname: false })

// QQ 登录入口是否可用（服务端未配置 QQ 互联凭据时隐藏）
const qqEnabled = ref(false)
// 已通过 QQ 校验但尚未绑定账号时，后端回跳带来的待绑定票据
const qqPendingTicket = ref('')
const qqPendingProfile = ref(null)

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const emit = defineEmits(['login-success'])

// 正则与长度限制从配置读取
const { username: USERNAME_REGEX, password: PASSWORD_REGEX } = AUTH_REGEX

const validateFormat = () => {
  if (!isLogin.value) {
    if (!USERNAME_REGEX.test(form.value.username)) {
      errorMsg.value = `账号必须为${NICKNAME_LIMITS.min}-${NICKNAME_LIMITS.max + 4}位英文或数字`
      return false
    }
    if (!PASSWORD_REGEX.test(form.value.password)) {
      errorMsg.value = `密码必须为${NICKNAME_LIMITS.min}-${NICKNAME_LIMITS.max + 4}位英文或数字`
      return false
    }
  }
  return true
}

// 防抖计时器
const timers = {}

const checkUnique = async (type, value) => {
  if (!value) return
  checking.value[type] = true

  try {
    // 修复：使用统一封装的 auth API
    const res = await checkUniqueApi(type, value)
    const body = res.data || res
    if (!body.available) {
      if (type === 'username') usernameError.value = body.message
      if (type === 'nickname') nicknameError.value = body.message
    } else {
      if (type === 'username') usernameError.value = ''
      if (type === 'nickname') nicknameError.value = ''
    }
  } catch (err) {
    console.error('Check unique error:', err)
  } finally {
    checking.value[type] = false
  }
}

const handleInput = (type) => {
  if (isLogin.value) return

  const value = form.value[type]

  // 清除对应错误
  if (type === 'username') usernameError.value = ''
  if (type === 'nickname') nicknameError.value = ''

  if (!value) return

  if (timers[type]) clearTimeout(timers[type])

  // 防抖时间从配置读取
  timers[type] = setTimeout(() => {
    checkUnique(type, value)
  }, UI_CONFIG.loginDebounce)
}

// 切换模式时清空状态
watch(isLogin, () => {
  errorMsg.value = ''
  usernameError.value = ''
  nicknameError.value = ''
  form.value = { username: '', password: '', nickname: '' }
})

// 待绑定提示条上的 QQ 名称，QQ 互联未放开资料接口时为空，只说"这个 QQ"
const pendingQQLabel = () => {
  const name = qqPendingProfile.value?.nickname
  return name ? `QQ「${name}」` : '这个 QQ'
}

/**
 * 整页跳转到 QQ 授权页
 * 授权结果由后端 302 回本页面，靠地址栏上的一次性参数交接，因此这里不做等待
 */
const startQQLogin = async () => {
  errorMsg.value = ''
  try {
    const res = await getQQAuthorizeUrl('login')
    window.location.href = res.data.url
  } catch (error) {
    errorMsg.value = error.response?.data?.message || '无法发起 QQ 登录，请稍后再试'
  }
}

/**
 * 登录成功后补完绑定
 *
 * 未绑定过的 QQ 走登录流程时，后端只会给出待绑定票据而不会放行登录；
 * 玩家随后在本页正常登录/注册，此刻才把 QQ 挂到这个账号上。
 * 绑定失败不影响本次登录，最多是玩家下次再点一次 QQ 登录。
 */
const finishPendingQQBind = async () => {
  if (!qqPendingTicket.value) return
  try {
    await bindQQPending(qqPendingTicket.value)
    uiStore.showToast(`${pendingQQLabel()}已绑定到本账号，以后可直接用 QQ 登录`, 'success')
  } catch (error) {
    uiStore.showToast(error.response?.data?.message || 'QQ 绑定失败，可稍后在设置中重试', 'error')
  } finally {
    qqPendingTicket.value = ''
    qqPendingProfile.value = null
  }
}

onMounted(async () => {
  const qq = readQQRedirect()
  if (qq.pending) {
    try {
      const res = await getQQPending(qq.pending)
      qqPendingTicket.value = qq.pending
      qqPendingProfile.value = res.data.profile
    } catch (error) {
      // 票据已过期，不再展示引导条，避免出现点了登录却绑不上任何东西
      uiStore.showToast(error.response?.data?.message || 'QQ 绑定会话已过期，请重新发起 QQ 登录', 'error')
    }
  }

  try {
    const res = await getQQStatus()
    qqEnabled.value = !!res.data.enabled
  } catch (error) {
    qqEnabled.value = false
  }
})

const handleSubmit = async () => {
  if (!validateFormat()) {
    return
  }
  
  // 注册模式下，如果有验证错误，阻止提交
  if (!isLogin.value && (usernameError.value || nicknameError.value)) {
    return
  }
  
  // 注册模式下，如果正在检查，等待检查完成（简单处理：阻止提交并提示）
  if (!isLogin.value && (checking.value.username || checking.value.nickname)) {
    errorMsg.value = '正在验证账号信息，请稍候...'
    return
  }

  const startTime = Date.now()
  loading.value = true
  errorMsg.value = ''
  
  try {
    if (isLogin.value) {
      // 登录（使用统一封装的 auth API）
      const res = await loginApi({
        username: form.value.username,
        password: form.value.password
      })
      // 清除之前的登出原因
      playerStore.logoutReason = null;

      // 使用 Pinia 存储状态
      // 后端返回 { code, message, token, player } 在 res.data 顶层（详见 AuthResponse 类型）
      const token = res.data?.token
      if (!token) {
        throw new Error('登录响应缺失 token 字段')
      }
      playerStore.setToken(token)

      // 获取完整玩家数据
      await playerStore.fetchPlayer()

      // 同步最新的闭关状态，避免 localStorage 缓存的旧状态
      await playerStore.fetchSeclusionStatus()

      // 若本次登录是由未绑定的 QQ 授权发起的，此时才把 QQ 挂到刚登录的账号上
      await finishPendingQQBind()

      // 触发登录成功事件，传递 true 表示成功，不需要传 player 对象，避免传旧数据
      emit('login-success', true)
    } else {
      // 注册（使用统一封装的 auth API）
      await registerApi(form.value)
      isLogin.value = true
      uiStore.showToast('注册成功，请登录', 'success')
      form.value = { username: '', password: '', nickname: '' }
    }
  } catch (error) {
    errorMsg.value = error.response?.data?.message || '请求失败，请检查网络'
  } finally {
    // loading 最小显示时间从配置读取，避免硬编码
    const elapsed = Date.now() - startTime
    if (elapsed < UI_CONFIG.minLoadingTime) {
      await new Promise(resolve => setTimeout(resolve, UI_CONFIG.minLoadingTime - elapsed))
    }
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-xiuxian-dark text-xiuxian-text p-4">
    <div class="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg p-8 shadow-2xl">
      <h1 class="text-3xl font-bold text-center text-xiuxian-gold mb-2">重生之凡人修仙传</h1>
      <p class="text-center text-gray-500 mb-8 text-sm">踏入仙途，逆天改命</p>
      
      <!-- 登出/互踢提示 -->
      <div v-if="playerStore.logoutReason" class="mb-6 p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm text-center animate-pulse">
        {{ playerStore.logoutReason }}
      </div>

      <!-- QQ 已通过校验但还没绑定账号：引导正常登录/注册，成功后自动完成绑定 -->
      <div v-if="qqPendingTicket" class="mb-6 p-3 bg-sky-900/40 border border-sky-700 rounded text-sky-100 text-sm">
        <p class="font-bold mb-1">{{ pendingQQLabel() }}还没有绑定任何账号</p>
        <p class="text-sky-200/80">登录已有账号、或注册一个新账号，完成后会自动把这个 QQ 绑定上去，以后就能直接用 QQ 登录。</p>
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-6">
        <div>
          <label class="block text-sm font-medium text-gray-400 mb-1">账号</label>
          <div class="relative">
            <input 
                v-model="form.username" 
                @input="handleInput('username')"
                type="text" 
                required 
                class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-xiuxian-gold focus:ring-1 focus:ring-xiuxian-gold transition-colors"
                :class="{'border-red-500 focus:border-red-500 focus:ring-red-500': usernameError}"
                placeholder="请输入账号"
            >
            <div v-if="checking.username" class="absolute right-3 top-2.5">
                <div class="animate-spin h-4 w-4 border-2 border-xiuxian-gold border-t-transparent rounded-full"></div>
            </div>
          </div>
          <p v-if="usernameError" class="mt-1 text-xs text-red-500">{{ usernameError }}</p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-400 mb-1">密码</label>
          <input 
            v-model="form.password" 
            type="password" 
            required 
            class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-xiuxian-gold focus:ring-1 focus:ring-xiuxian-gold transition-colors"
            placeholder="请输入密码"
          >
        </div>

        <div v-if="!isLogin">
          <label class="block text-sm font-medium text-gray-400 mb-1">道号 (昵称)</label>
          <div class="relative">
            <input 
                v-model="form.nickname" 
                @input="handleInput('nickname')"
                type="text" 
                required 
                class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-xiuxian-gold focus:ring-1 focus:ring-xiuxian-gold transition-colors"
                :class="{'border-red-500 focus:border-red-500 focus:ring-red-500': nicknameError}"
                placeholder="例如：韩天尊"
            >
             <div v-if="checking.nickname" class="absolute right-3 top-2.5">
                <div class="animate-spin h-4 w-4 border-2 border-xiuxian-gold border-t-transparent rounded-full"></div>
            </div>
          </div>
          <p v-if="nicknameError" class="mt-1 text-xs text-red-500">{{ nicknameError }}</p>
        </div>

        <div class="min-h-[1.25rem] text-red-500 text-sm text-center">
          {{ errorMsg }}
        </div>

        <button 
          type="submit" 
          :disabled="loading || (!isLogin && (!!usernameError || !!nicknameError))"
          class="w-full bg-xiuxian-gold text-black font-bold py-2 rounded hover:bg-yellow-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? '处理中...' : (isLogin ? '登 录' : '注 册') }}
        </button>
      </form>

      <div class="mt-6 text-center text-sm">
        <button 
          @click="isLogin = !isLogin"
          class="text-gray-400 hover:text-white underline underline-offset-4"
        >
          {{ isLogin ? '没有账号？点击注册' : '已有账号？返回登录' }}
        </button>
      </div>

      <!-- QQ 登录：服务端未配置 QQ 互联凭据时整块隐藏 -->
      <div v-if="qqEnabled" class="mt-6">
        <div class="flex items-center gap-3 text-xs text-gray-600 mb-4">
          <div class="flex-1 h-px bg-gray-700"></div>
          <span>或</span>
          <div class="flex-1 h-px bg-gray-700"></div>
        </div>
        <button
          type="button"
          @click="startQQLogin"
          :disabled="loading"
          class="w-full flex items-center justify-center gap-2 bg-[#12B7F5]/90 text-black font-bold py-2 rounded hover:bg-[#12B7F5] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span class="w-5 h-5 flex items-center justify-center rounded-full bg-black text-[#12B7F5] text-[10px] font-black leading-none">QQ</span>
          使用 QQ 登录
        </button>
        <p class="mt-2 text-xs text-gray-500 text-center">首次使用需用 QQ 验证后绑定或注册一个账号</p>
      </div>
    </div>
  </div>
</template>
