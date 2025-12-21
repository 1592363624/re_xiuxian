<script setup>
import { ref, watch } from 'vue'
import axios from 'axios'
import { usePlayerStore } from '../stores/player'

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

const playerStore = usePlayerStore()

const emit = defineEmits(['login-success'])

// 防抖计时器
const timers = {}

const checkUnique = async (type, value) => {
  if (!value) return
  checking.value[type] = true
  
  try {
    const res = await axios.get(`/api/auth/check-unique?type=${type}&value=${value}`)
    if (!res.data.available) {
      if (type === 'username') usernameError.value = res.data.message
      if (type === 'nickname') nicknameError.value = res.data.message
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
  
  timers[type] = setTimeout(() => {
    checkUnique(type, value)
  }, 500)
}

// 切换模式时清空状态
watch(isLogin, () => {
  errorMsg.value = ''
  usernameError.value = ''
  nicknameError.value = ''
  form.value = { username: '', password: '', nickname: '' }
})

const handleSubmit = async () => {
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
      // 登录
      const res = await axios.post('/api/auth/login', {
        username: form.value.username,
        password: form.value.password
      })
      // 清除之前的登出原因
      playerStore.logoutReason = null;
      
      // 使用 Pinia 存储状态
      playerStore.setToken(res.data.token)
      
      // 获取完整玩家数据
      await playerStore.fetchPlayer()
      
      // 触发登录成功事件，传递 true 表示成功，不需要传 player 对象，避免传旧数据
      emit('login-success', true)
    } else {
      // 注册
      await axios.post('/api/auth/register', form.value)
      isLogin.value = true
      errorMsg.value = '注册成功，请登录'
      // 注册成功后清空密码
      form.value.password = ''
    }
  } catch (error) {
    errorMsg.value = error.response?.data?.message || '请求失败，请检查网络'
  } finally {
    // 确保 loading 至少显示 500ms，避免闪烁
    const elapsed = Date.now() - startTime
    if (elapsed < 500) {
      await new Promise(resolve => setTimeout(resolve, 500 - elapsed))
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
    </div>
  </div>
</template>
