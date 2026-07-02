<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">AI 配置管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchConfigs" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
        <button @click="openCreateModal" class="px-3 py-1 bg-green-700 hover:bg-green-600 rounded text-white text-sm">新增配置</button>
      </div>
    </div>

    <!-- 配置列表 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-900 text-gray-400">
          <tr>
            <th class="px-3 py-2 text-left">提供商</th>
            <th class="px-3 py-2 text-left">显示名</th>
            <th class="px-3 py-2 text-left">模型</th>
            <th class="px-3 py-2 text-left">API Key</th>
            <th class="px-3 py-2 text-left">状态</th>
            <th class="px-3 py-2 text-left">最近测试</th>
            <th class="px-3 py-2 text-center">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading" class="text-center text-gray-500">
            <td colspan="7" class="px-3 py-6">加载中...</td>
          </tr>
          <tr v-else-if="configs.length === 0" class="text-center text-gray-500">
            <td colspan="7" class="px-3 py-6">暂无 AI 配置，请点击「新增配置」</td>
          </tr>
          <tr v-for="cfg in configs" :key="cfg.id" class="border-t border-gray-700 hover:bg-gray-750">
            <td class="px-3 py-2 text-gray-300">{{ cfg.provider }}</td>
            <td class="px-3 py-2 text-white">{{ cfg.display_name }}</td>
            <td class="px-3 py-2 text-gray-300 font-mono text-xs">{{ cfg.model }}</td>
            <td class="px-3 py-2 text-gray-400 font-mono">
              <span v-if="cfg.has_api_key">{{ cfg.api_key_masked }}</span>
              <span v-else class="text-red-500">未配置</span>
            </td>
            <td class="px-3 py-2">
              <span v-if="cfg.is_active" class="px-2 py-0.5 bg-green-900 text-green-300 rounded text-xs">启用中</span>
              <span v-else class="px-2 py-0.5 bg-gray-700 text-gray-400 rounded text-xs">停用</span>
            </td>
            <td class="px-3 py-2 text-xs">
              <div v-if="cfg.last_test_status">
                <span :class="cfg.last_test_status === 'success' ? 'text-green-400' : 'text-red-400'">
                  {{ cfg.last_test_status === 'success' ? '✓ 成功' : '✗ 失败' }}
                </span>
                <div class="text-gray-500">{{ cfg.last_tested_at }}</div>
              </div>
              <span v-else class="text-gray-600">未测试</span>
            </td>
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <button v-if="!cfg.is_active" @click="handleActivate(cfg)" class="px-2 py-1 bg-green-700 hover:bg-green-600 rounded text-white text-xs mr-1">激活</button>
              <button @click="handleTest(cfg)" :disabled="testingId === cfg.id" class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs mr-1 disabled:opacity-50">
                {{ testingId === cfg.id ? '测试中...' : '测试' }}
              </button>
              <button @click="openEditModal(cfg)" class="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 rounded text-white text-xs mr-1">编辑</button>
              <button v-if="!cfg.is_active" @click="handleDelete(cfg)" class="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-white text-xs">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="closeModal">
      <div class="bg-gray-800 rounded-lg border border-gray-600 p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h3 class="text-lg font-bold text-white mb-4">{{ editMode ? '编辑 AI 配置' : '新增 AI 配置' }}</h3>

        <div class="space-y-4">
          <!-- 提供商选择 -->
          <div>
            <label class="block text-sm text-gray-400 mb-1">提供商 *</label>
            <select v-if="!editMode" v-model="form.provider" @change="onProviderChange"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              <option value="">请选择</option>
              <option v-for="p in providers" :key="p.provider" :value="p.provider">
                {{ p.name }}（{{ p.provider }}）
              </option>
            </select>
            <input v-else :value="form.provider" disabled
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-gray-500">
          </div>

          <!-- 显示名称 -->
          <div>
            <label class="block text-sm text-gray-400 mb-1">显示名称 *</label>
            <input v-model="form.display_name" type="text"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              placeholder="如：DeepSeek 测试">
          </div>

          <!-- Base URL -->
          <div>
            <label class="block text-sm text-gray-400 mb-1">Base URL *</label>
            <input v-model="form.base_url" type="text"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              placeholder="https://api.deepseek.com/v1">
            <p class="mt-1 text-xs text-gray-500">应包含版本号路径（如 /v1），不含 /chat/completions 后缀</p>
          </div>

          <!-- 模型 -->
          <div>
            <label class="block text-sm text-gray-400 mb-1">模型名称 *</label>
            <input v-if="!availableModels.length" v-model="form.model" type="text"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              placeholder="如 deepseek-chat">
            <select v-else v-model="form.model"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <!-- API Key -->
          <div>
            <label class="block text-sm text-gray-400 mb-1">API Key</label>
            <input v-model="form.api_key" type="password"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              :placeholder="editMode && editingConfig?.has_api_key ? `已配置（${editingConfig.api_key_masked}），留空则不修改` : '输入 API Key'">
            <p class="mt-1 text-xs text-gray-500">加密存储，接口返回时仅显示后4位</p>
          </div>

          <!-- 高级设置 -->
          <details class="text-gray-400">
            <summary class="cursor-pointer text-sm">高级设置</summary>
            <div class="grid grid-cols-2 gap-4 mt-3">
              <div>
                <label class="block text-sm mb-1">通信协议</label>
                <select v-model="form.protocol"
                  class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
                  <option value="openai">openai（默认，兼容所有 OpenAI 协议模型）</option>
                  <option value="anthropic">anthropic（仅 Claude）</option>
                </select>
              </div>
              <div>
                <label class="block text-sm mb-1">采样温度</label>
                <input v-model.number="form.temperature" type="number" step="0.1" min="0" max="2"
                  class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
              <div>
                <label class="block text-sm mb-1">最大 token 数</label>
                <input v-model.number="form.max_tokens" type="number" min="1"
                  class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
              <div>
                <label class="block text-sm mb-1">超时时间（毫秒）</label>
                <input v-model.number="form.timeout" type="number" min="1000"
                  class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
            </div>
          </details>

          <!-- 启用选项（仅新增时） -->
          <div v-if="!editMode" class="flex items-center space-x-2">
            <input v-model="form.is_active" type="checkbox" id="is_active" class="rounded">
            <label for="is_active" class="text-sm text-gray-400">立即启用（其他配置将自动停用）</label>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="flex justify-end space-x-2 mt-6">
          <button @click="closeModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
          <button @click="handleSave" :disabled="saving"
            class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm disabled:opacity-50">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 自定义确认弹窗 -->
    <div v-if="confirmDialog.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="confirmDialog.show = false">
      <div class="bg-gray-800 rounded-lg border border-gray-600 p-6 w-full max-w-md">
        <h3 class="text-lg font-bold text-white mb-2">{{ confirmDialog.title }}</h3>
        <p class="text-gray-300 mb-4">{{ confirmDialog.message }}</p>
        <div class="flex justify-end space-x-2">
          <button @click="confirmDialog.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
          <button @click="confirmDialog.onConfirm" class="px-4 py-2 bg-red-700 hover:bg-red-600 rounded text-white text-sm">确认</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * AI 配置管理组件
 * 供 GM 后台管理 AI 服务参数（提供商、URL、模型、API Key 等）
 * 支持测试连接性、激活配置、加密存储 API Key
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import {
  getAiConfigs, getAiProviders,
  createAiConfig, updateAiConfig, deleteAiConfig,
  activateAiConfig, testAiConfig
} from '../../../api/admin_ai'

const uiStore = useUIStore()

// 配置列表与加载状态
const configs = ref([])
const providers = ref([])
const availableModels = ref([])
const loading = ref(false)
const testingId = ref(null)
const saving = ref(false)

// 弹窗状态
const showModal = ref(false)
const editMode = ref(false)
const editingConfig = ref(null)

// 表单数据
const form = reactive({
  provider: '',
  display_name: '',
  base_url: '',
  model: '',
  api_key: '',
  protocol: 'openai',
  temperature: 0.7,
  max_tokens: 1000,
  timeout: 30000,
  is_active: false
})

// 自定义确认弹窗
const confirmDialog = reactive({
  show: false,
  title: '',
  message: '',
  onConfirm: () => {}
})

/**
 * 获取配置列表
 */
const fetchConfigs = async () => {
  loading.value = true
  try {
    const res = await getAiConfigs()
    const body = res.data?.data || res.data || []
    configs.value = Array.isArray(body) ? body : []
  } catch (err) {
    uiStore.showToast('获取 AI 配置列表失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 获取可选提供商列表
 */
const fetchProviders = async () => {
  try {
    const res = await getAiProviders()
    const body = res.data?.data || res.data || []
    providers.value = Array.isArray(body) ? body : []
  } catch (err) {
    console.error('获取提供商列表失败:', err)
  }
}

/**
 * 打开新增弹窗
 */
const openCreateModal = () => {
  editMode.value = false
  editingConfig.value = null
  Object.assign(form, {
    provider: '', display_name: '', base_url: '', model: '',
    api_key: '', protocol: 'openai', temperature: 0.7,
    max_tokens: 1000, timeout: 30000, is_active: false
  })
  availableModels.value = []
  showModal.value = true
}

/**
 * 打开编辑弹窗
 */
const openEditModal = (cfg) => {
  editMode.value = true
  editingConfig.value = cfg
  Object.assign(form, {
    provider: cfg.provider,
    display_name: cfg.display_name,
    base_url: cfg.base_url,
    model: cfg.model,
    api_key: '',   // 编辑时不回填，留空表示不修改
    protocol: cfg.protocol,
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    timeout: cfg.timeout
  })
  // 加载该提供商的模型列表
  const p = providers.value.find(p => p.provider === cfg.provider)
  availableModels.value = p?.models || []
  showModal.value = true
}

/**
 * 关闭弹窗
 */
const closeModal = () => {
  showModal.value = false
  editingConfig.value = null
}

/**
 * 提供商变更时自动填充默认值
 */
const onProviderChange = () => {
  const p = providers.value.find(p => p.provider === form.provider)
  if (!p) {
    availableModels.value = []
    return
  }
  // 自动填充默认 endpoint
  if (p.default_endpoint && !form.base_url) {
    form.base_url = p.default_endpoint
  }
  // 自动填充显示名
  if (!form.display_name) {
    form.display_name = p.name
  }
  // 自动填充协议
  if (p.compatible_with) {
    form.protocol = p.compatible_with
  }
  // 加载可选模型列表
  availableModels.value = p.models || []
  // 默认选择第一个模型
  if (availableModels.value.length > 0 && !form.model) {
    form.model = availableModels.value[0]
  }
}

/**
 * 保存（新增或更新）
 */
const handleSave = async () => {
  // 参数校验
  if (!form.provider || !form.display_name || !form.base_url || !form.model) {
    uiStore.showToast('请填写完整：提供商、显示名、Base URL、模型', 'error')
    return
  }

  saving.value = true
  try {
    if (editMode.value) {
      // 编辑模式：仅发送修改过的字段
      const updates = {
        display_name: form.display_name,
        base_url: form.base_url,
        model: form.model,
        protocol: form.protocol,
        temperature: form.temperature,
        max_tokens: form.max_tokens,
        timeout: form.timeout
      }
      // API Key 仅在用户输入时才更新
      if (form.api_key) {
        updates.api_key = form.api_key
      }
      await updateAiConfig(editingConfig.value.id, updates)
      uiStore.showToast('AI 配置更新成功', 'success')
    } else {
      // 新增模式
      await createAiConfig({
        provider: form.provider,
        display_name: form.display_name,
        base_url: form.base_url,
        model: form.model,
        api_key: form.api_key,
        protocol: form.protocol,
        temperature: form.temperature,
        max_tokens: form.max_tokens,
        timeout: form.timeout,
        is_active: form.is_active
      })
      uiStore.showToast('AI 配置创建成功', 'success')
    }
    closeModal()
    await fetchConfigs()
  } catch (err) {
    const msg = err.response?.data?.message || '保存失败'
    uiStore.showToast(msg, 'error')
  } finally {
    saving.value = false
  }
}

/**
 * 激活配置
 */
const handleActivate = (cfg) => {
  confirmDialog.title = '激活确认'
  confirmDialog.message = `确定要激活配置「${cfg.display_name}」吗？其他配置将自动停用，AI 服务将立即切换。`
  confirmDialog.onConfirm = async () => {
    confirmDialog.show = false
    try {
      await activateAiConfig(cfg.id)
      uiStore.showToast(`已激活：${cfg.display_name}`, 'success')
      await fetchConfigs()
    } catch (err) {
      const msg = err.response?.data?.message || '激活失败'
      uiStore.showToast(msg, 'error')
    }
  }
  confirmDialog.show = true
}

/**
 * 测试连接
 */
const handleTest = async (cfg) => {
  testingId.value = cfg.id
  try {
    const res = await testAiConfig(cfg.id)
    const result = res.data?.data || res.data
    if (result?.status === 'success') {
      uiStore.showToast(`连接成功：${cfg.display_name}`, 'success')
    } else {
      uiStore.showToast(`测试失败：${result?.message || '未知原因'}`, 'error')
    }
    // 刷新列表以显示最新测试结果
    await fetchConfigs()
  } catch (err) {
    const msg = err.response?.data?.message || '测试请求失败'
    uiStore.showToast(msg, 'error')
  } finally {
    testingId.value = null
  }
}

/**
 * 删除配置
 */
const handleDelete = (cfg) => {
  confirmDialog.title = '删除确认'
  confirmDialog.message = `确定要删除配置「${cfg.display_name}」吗？此操作不可恢复。`
  confirmDialog.onConfirm = async () => {
    confirmDialog.show = false
    try {
      await deleteAiConfig(cfg.id)
      uiStore.showToast('AI 配置已删除', 'success')
      await fetchConfigs()
    } catch (err) {
      const msg = err.response?.data?.message || '删除失败'
      uiStore.showToast(msg, 'error')
    }
  }
  confirmDialog.show = true
}

onMounted(() => {
  fetchConfigs()
  fetchProviders()
})
</script>
