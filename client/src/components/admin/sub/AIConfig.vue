<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">AI 配置管理</h3>
      <div class="flex space-x-2">
        <AppButton variant="primary" size="sm" @click="fetchConfigs">刷新</AppButton>
        <AppButton variant="primary" size="sm" @click="openCreateModal">新增配置</AppButton>
      </div>
    </div>

    <!-- 配置列表 -->
    <div class="bg-surface-base/50 rounded-panel border border-line overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-surface-raised text-fg-muted">
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
          <tr v-if="loading" class="text-center text-fg-faint">
            <td colspan="7" class="px-3 py-6">加载中...</td>
          </tr>
          <tr v-else-if="configs.length === 0" class="text-center text-fg-faint">
            <td colspan="7" class="px-3 py-6">暂无 AI 配置，请点击「新增配置」</td>
          </tr>
          <tr v-for="cfg in configs" :key="cfg.id" class="border-t border-line-subtle hover:bg-surface-hover">
            <td class="px-3 py-2 text-fg-secondary">{{ cfg.provider }}</td>
            <td class="px-3 py-2 text-fg-primary">{{ cfg.display_name }}</td>
            <td class="px-3 py-2 text-fg-secondary font-mono text-xs">{{ cfg.model }}</td>
            <td class="px-3 py-2 text-fg-muted font-mono">
              <span v-if="cfg.has_api_key">{{ cfg.api_key_masked }}</span>
              <span v-else class="text-red-500">未配置</span>
            </td>
            <td class="px-3 py-2">
              <span v-if="cfg.is_active" class="px-2 py-0.5 bg-green-900 text-green-300 rounded text-xs">启用中</span>
              <span v-else class="px-2 py-0.5 bg-surface-active text-fg-muted rounded text-xs">停用</span>
            </td>
            <td class="px-3 py-2 text-xs">
              <div v-if="cfg.last_test_status">
                <span :class="cfg.last_test_status === 'success' ? 'text-green-400' : 'text-red-400'">
                  {{ cfg.last_test_status === 'success' ? '✓ 成功' : '✗ 失败' }}
                </span>
                <div class="text-fg-faint num">{{ formatBeijing(cfg.last_tested_at, { fallback: '-' }) }}</div>
              </div>
              <span v-else class="text-line-strong">未测试</span>
            </td>
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <AppButton v-if="!cfg.is_active" variant="primary" size="xs" class="mr-1" @click="handleActivate(cfg)">激活</AppButton>
              <AppButton
                variant="outline"
                size="xs"
                class="mr-1"
                :disabled="testingId === cfg.id"
                @click="handleTest(cfg)"
              >
                {{ testingId === cfg.id ? '测试中...' : '测试' }}
              </AppButton>
              <AppButton variant="outline" size="xs" class="mr-1" @click="openEditModal(cfg)">编辑</AppButton>
              <AppButton v-if="!cfg.is_active" variant="danger" size="xs" @click="handleDelete(cfg)">删除</AppButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" @click.self="closeModal">
      <div class="bg-surface-base rounded-panel border border-line p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto scroll-thin shadow-2xl shadow-black/60">
        <h3 class="text-lg font-bold text-fg-primary mb-4">{{ editMode ? '编辑 AI 配置' : '新增 AI 配置' }}</h3>

        <div class="space-y-4">
          <!-- 接口类型：仅保留 OpenAI 兼容接口，无需用户选择 -->
          <div>
            <label class="block text-sm text-fg-muted mb-1">接口类型</label>
            <input :value="activeProviderName" disabled
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-faint">
            <p class="mt-1 text-xs text-fg-faint">{{ activeProviderDescription }}</p>
          </div>

          <!-- 显示名称 -->
          <div>
            <label class="block text-sm text-fg-muted mb-1">显示名称 *</label>
            <input v-model="form.display_name" type="text"
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
              placeholder="如：DeepSeek 测试">
          </div>

          <!-- Base URL -->
          <div>
            <label class="block text-sm text-fg-muted mb-1">Base URL *</label>
            <input v-model="form.base_url" type="text"
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
              placeholder="https://api.deepseek.com/v1">
            <p class="mt-1 text-xs text-fg-faint">应包含版本号路径（如 /v1），不含 /chat/completions 后缀</p>
          </div>

          <!-- 模型 -->
          <div>
            <label class="block text-sm text-fg-muted mb-1">模型名称 *</label>
            <input v-if="!availableModels.length" v-model="form.model" type="text"
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
              placeholder="如 deepseek-chat">
            <select v-else v-model="form.model"
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
              <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <!-- API Key -->
          <div>
            <label class="block text-sm text-fg-muted mb-1">API Key</label>
            <input v-model="form.api_key" type="password"
              class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
              :placeholder="editMode && editingConfig?.has_api_key ? `已配置（${editingConfig.api_key_masked}），留空则不修改` : '输入 API Key'">
            <p class="mt-1 text-xs text-fg-faint">加密存储，接口返回时仅显示后4位</p>
          </div>

          <!-- 高级设置 -->
          <details class="text-fg-muted">
            <summary class="cursor-pointer text-sm">高级设置</summary>
            <div class="grid grid-cols-3 gap-4 mt-3">
              <div>
                <label class="block text-sm mb-1">采样温度</label>
                <input v-model.number="form.temperature" type="number" step="0.1" min="0" max="2"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
              </div>
              <div>
                <label class="block text-sm mb-1">最大 token 数</label>
                <input v-model.number="form.max_tokens" type="number" min="1"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
              </div>
              <div>
                <label class="block text-sm mb-1">超时时间（毫秒）</label>
                <input v-model.number="form.timeout" type="number" min="1000"
                  class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
              </div>
            </div>
          </details>

          <!-- 启用选项（仅新增时） -->
          <div v-if="!editMode" class="flex items-center space-x-2">
            <input v-model="form.is_active" type="checkbox" id="is_active" class="rounded">
            <label for="is_active" class="text-sm text-fg-muted">立即启用（其他配置将自动停用）</label>
          </div>
        </div>

        <!-- 测试连接结果（详细原因直接展示在弹窗内，不再只有一句笼统报错） -->
        <div v-if="modalTestResult" class="mt-4 rounded border p-3 text-sm"
          :class="modalTestResult.status === 'success'
            ? 'border-green-700/50 bg-green-900/20 text-green-300'
            : 'border-red-700/50 bg-red-900/20 text-red-300'">
          <div class="font-bold">{{ modalTestResult.status === 'success' ? '✓ 连接成功' : '✗ 连接失败' }}</div>
          <div class="mt-1">{{ modalTestResult.message }}</div>
          <!-- detail：后端给出的排查线索（常见原因、响应片段等），失败时才展示 -->
          <div v-if="modalTestResult.status === 'failed' && modalTestResult.detail" class="mt-1 text-xs opacity-80 wrap-cjk">
            {{ modalTestResult.detail }}
          </div>
        </div>

        <!-- 操作按钮：保存前即可测试连接，测通了再保存 -->
        <div class="flex justify-end space-x-2 mt-6">
          <AppButton variant="default" @click="closeModal">取消</AppButton>
          <AppButton variant="outline" :disabled="modalTesting || saving" @click="handleModalTest">
            {{ modalTesting ? '测试中...' : '测试连接' }}
          </AppButton>
          <AppButton variant="primary" :disabled="saving" @click="handleSave">
            {{ saving ? '保存中...' : '保存' }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 自定义确认弹窗 -->
    <div v-if="confirmDialog.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" @click.self="confirmDialog.show = false">
      <div class="bg-surface-base rounded-panel border border-line p-6 w-full max-w-md shadow-2xl shadow-black/60">
        <h3 class="text-lg font-bold text-fg-primary mb-2">{{ confirmDialog.title }}</h3>
        <p class="text-fg-secondary mb-4 wrap-cjk">{{ confirmDialog.message }}</p>
        <div class="flex justify-end space-x-2">
          <AppButton variant="default" @click="confirmDialog.show = false">取消</AppButton>
          <AppButton variant="danger" @click="confirmDialog.onConfirm">确认</AppButton>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { formatBeijing } from '../../../utils/time'
import { useUIStore } from '../../../stores/ui'
import {
  getAiConfigs, getAiProviders,
  createAiConfig, updateAiConfig, deleteAiConfig,
  activateAiConfig, testAiConfig, testAiConfigPayload
} from '../../../api/admin_ai'
import AppButton from '../../ui/AppButton.vue'

const uiStore = useUIStore()

// 配置列表与加载状态
const configs = ref([])
const providers = ref([])
const availableModels = ref([])
const loading = ref(false)
const testingId = ref(null)
const saving = ref(false)
// 弹窗内"测试连接"状态与结果（保存前即可验证表单配置）
const modalTesting = ref(false)
const modalTestResult = ref(null)

// 弹窗状态
const showModal = ref(false)
const editMode = ref(false)
const editingConfig = ref(null)

// 表单数据（provider 固定为唯一的 OpenAI 兼容接口，不再由用户选择）
const form = reactive({
  provider: '',
  display_name: '',
  base_url: '',
  model: '',
  api_key: '',
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

// 当前唯一的接口类型（来自后端 providers，仅用于只读展示）
const activeProviderName = computed(() => providers.value[0]?.name || 'OpenAI 兼容接口')
const activeProviderDescription = computed(
  () => providers.value[0]?.description || '填入 Base URL、模型名与 API Key 即可接入任意 OpenAI 兼容服务'
)

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
    uiStore.showApiError(err, '操作失败')
  } finally {
    loading.value = false
  }
}

/**
 * 获取可选接口列表（现仅一个 OpenAI 兼容接口，用于只读展示）
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
    // provider 固定为唯一接口；后端 providers 尚未返回时兜底 openai
    provider: providers.value[0]?.provider || 'openai',
    display_name: '', base_url: '', model: '',
    api_key: '', temperature: 0.7,
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
  // 顺带清掉上一次的测试结果，避免下次打开残留
  modalTestResult.value = null
}

/**
 * 弹窗内测试连接：用当前表单值直接测试，不需要先保存
 * 编辑已有配置且未重新输入 Key 时，后端自动复用该配置已保存的 Key
 */
const handleModalTest = async () => {
  // 与保存相同的必填校验，缺项时直接提示，不发请求
  if (!form.base_url || !form.model) {
    uiStore.showToast('请先填写 Base URL 与模型名称', 'error')
    return
  }
  // 编辑模式下未填 Key 也没有已存 Key 时，测了也必然失败，提前拦下
  if (editMode.value && !form.api_key && !editingConfig.value?.has_api_key) {
    uiStore.showToast('请先填写 API Key', 'error')
    return
  }
  if (!editMode.value && !form.api_key) {
    uiStore.showToast('请先填写 API Key', 'error')
    return
  }

  modalTesting.value = true
  modalTestResult.value = null
  try {
    const res = await testAiConfigPayload({
      base_url: form.base_url,
      model: form.model,
      // Key 留空时后端用 config_id 复用已保存的 Key
      api_key: form.api_key || undefined,
      config_id: editMode.value ? editingConfig.value.id : undefined,
      timeout: form.timeout
    })
    // 该接口永不返回 5xx：失败也以 200 + status='failed' + 详细原因返回
    modalTestResult.value = res.data?.data || res.data
  } catch (err) {
    // 真·HTTP 错误（鉴权失败等）走统一错误提示
    uiStore.showApiError(err, '测试请求失败')
  } finally {
    modalTesting.value = false
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
    uiStore.showApiError(err, '保存失败')
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
      uiStore.showApiError(err, '激活失败')
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
    uiStore.showApiError(err, '测试请求失败')
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
      uiStore.showApiError(err, '删除失败')
    }
  }
  confirmDialog.show = true
}

onMounted(() => {
  fetchConfigs()
  fetchProviders()
})
</script>
