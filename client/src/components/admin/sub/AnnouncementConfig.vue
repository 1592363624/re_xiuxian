<template>
  <div class="bg-surface-base/50 p-4 rounded-panel border border-line">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h4 class="text-md font-bold text-gold-500">公告配图参数</h4>
        <p class="text-xs text-fg-faint mt-0.5">改动即时热加载，无需重启服务</p>
      </div>
      <AppButton variant="primary" size="sm" :loading="saving" @click="handleSave">保存</AppButton>
    </div>

    <div v-if="loading" class="text-xs text-fg-faint py-2">加载中…</div>
    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div>
        <label class="block text-sm text-fg-muted mb-1">单张图片上限 (MB)</label>
        <input
          v-model.number="friendly.maxFileSizeMb"
          type="number"
          :min="minFileSizeMb"
          :max="maxFileSizeMb"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
        <p class="mt-1 text-xs text-fg-faint">当前 {{ form['upload.max_file_size_bytes'] }} 字节</p>
      </div>

      <div>
        <label class="block text-sm text-fg-muted mb-1">单条公告最多几张图</label>
        <input
          v-model.number="form['upload.max_images_per_announcement']"
          type="number"
          min="1"
          max="9"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
      </div>

      <div>
        <label class="block text-sm text-fg-muted mb-1">批量删除单次上限</label>
        <input
          v-model.number="form['batch_delete.max_ids_per_request']"
          type="number"
          min="1"
          max="1000"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
      </div>

      <div>
        <label class="block text-sm text-fg-muted mb-1">图片缓存时长 (小时)</label>
        <input
          v-model.number="friendly.maxAgeHours"
          type="number"
          min="0"
          max="8760"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
        <p class="mt-1 text-xs text-fg-faint">文件名含随机串，内容不会变</p>
      </div>

      <div>
        <label class="block text-sm text-fg-muted mb-1">孤儿图回收周期 (分钟)</label>
        <input
          v-model.number="friendly.cleanupIntervalMin"
          type="number"
          min="1"
          step="1"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
      </div>

      <div>
        <label class="block text-sm text-fg-muted mb-1">孤儿图保留时长 (小时)</label>
        <input
          v-model.number="form['cleanup.retention_hours']"
          type="number"
          min="1"
          max="720"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"
        >
        <p class="mt-1 text-xs text-fg-faint">上传后未发出的图留够这段时间</p>
      </div>

      <label class="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
        <input v-model="form['cleanup.enabled']" type="checkbox" class="cursor-pointer">
        启用孤儿图定时回收
      </label>

      <label class="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
        <input v-model="form['upload.delete_file_when_notification_removed']" type="checkbox" class="cursor-pointer">
        删除通知时一并删除配图文件
      </label>
    </div>

    <!-- 锁死字段：由后端下发并附带理由，避免 GM 以为"这里没做" -->
    <div v-if="lockedFields.length" class="mt-4 pt-3 border-t border-line-subtle">
      <p class="text-xs text-fg-faint mb-1">以下字段不支持在线修改：</p>
      <ul class="text-xs text-fg-faint space-y-0.5">
        <li v-for="field in lockedFields" :key="field">· {{ field }}</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
/**
 * 公告配图参数配置子组件
 *
 * GM 在「通知管理」页直接调参：单张体积上限、配图张数、缓存时长、孤儿图回收策略等。
 * 所有可改字段由后端下发的 editable_fields 决定 —— 前端不硬编码清单，
 * 后端新增一个可调字段，这里只要在 form 里有同名输入框就会出现。
 */
import { reactive, ref, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import { getAnnouncementConfig, updateAnnouncementConfig } from '../../../api/admin'
import AppButton from '../../ui/AppButton.vue'

const uiStore = useUIStore()

// MB↔字节、小时↔毫秒的换算都是纯展示层的：后端只认字节/毫秒
const MB = 1024 * 1024
const HOUR_MS = 3600 * 1000
const MINUTE_MS = 60 * 1000

/** 表单各字段的范围，与后端 EDITABLE_FIELDS 保持一致，用于 UI 侧的 min/max 提示 */
const minFileSizeMb = 1
const maxFileSizeMb = 20

const loading = ref(true)
const saving = ref(false)
const lockedFields = ref([])
const editableFields = ref([])

// key 就是后端要求的点分路径，提交时可直接当 patch 用
const form = reactive({
  'upload.max_file_size_bytes': 5 * MB,
  'upload.max_images_per_announcement': 3,
  'upload.delete_file_when_notification_removed': true,
  'static.max_age_ms': 7 * 24 * HOUR_MS,
  'cleanup.enabled': true,
  'cleanup.interval_ms': HOUR_MS,
  'cleanup.retention_hours': 24,
  'batch_delete.max_ids_per_request': 200
})

// 字节/毫秒在输入框里不好读，另设三个"人类单位"的镜像字段
const friendly = reactive({
  maxFileSizeMb: 5,
  maxAgeHours: 168,
  cleanupIntervalMin: 60
})

/**
 * 按点分路径取值
 * @param {Object} source - 配置对象
 * @param {string} key - 形如 'upload.max_file_size_bytes'
 */
const readPath = (source, key) =>
  key.split('.').reduce((node, segment) => (node == null ? undefined : node[segment]), source)

/**
 * 加载配置
 */
const fetchConfig = async () => {
  loading.value = true
  try {
    const res = await getAnnouncementConfig()
    const { config, editable_fields: editable, locked_fields: locked } = res.data?.data || {}
    editableFields.value = editable || []
    lockedFields.value = locked || []

    // 只回填后端声明可改的字段：配置里多出来的段（如 description/comment）不进表单
    for (const key of editableFields.value) {
      if (!(key in form)) continue
      const value = readPath(config, key)
      if (value !== undefined) form[key] = value
    }

    friendly.maxFileSizeMb = Math.round(form['upload.max_file_size_bytes'] / MB)
    friendly.maxAgeHours = Math.round(form['static.max_age_ms'] / HOUR_MS)
    friendly.cleanupIntervalMin = Math.round(form['cleanup.interval_ms'] / MINUTE_MS)
  } catch (error) {
    uiStore.showApiError(error, '获取公告配图配置失败')
  } finally {
    loading.value = false
  }
}

/**
 * 保存：把三个"人类单位"字段换算回字节/毫秒后再提交
 */
const handleSave = async () => {
  saving.value = true
  try {
    form['upload.max_file_size_bytes'] = Math.round(friendly.maxFileSizeMb * MB)
    form['static.max_age_ms'] = Math.round(friendly.maxAgeHours * HOUR_MS)
    form['cleanup.interval_ms'] = Math.round(friendly.cleanupIntervalMin * MINUTE_MS)

    const patch = {}
    for (const key of editableFields.value) {
      if (key in form) patch[key] = form[key]
    }

    await updateAnnouncementConfig(patch)
    uiStore.showToast('公告配图配置已更新并热加载', 'success')
    fetchConfig()
  } catch (error) {
    uiStore.showApiError(error, '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(fetchConfig)
</script>
