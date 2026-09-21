<template>
  <div class="md:col-span-2">
    <label class="block text-sm text-fg-muted mb-1">{{ label }}</label>
    <div
      ref="rootRef"
      class="rounded-control border border-dashed border-line px-3 py-3 cursor-pointer transition-colors hover:border-gold-600/60"
      @click="triggerFilePicker"
      @dragover.prevent
      @drop.prevent="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        class="hidden"
        :accept="imageConfig.acceptTypes.join(',')"
        multiple
        @change="handleFileChange"
      >
      <div v-if="entries.length === 0" class="text-center text-xs text-fg-faint py-2">
        点击选择图片，或直接 Ctrl+V 粘贴剪贴板中的截图
      </div>
      <div v-else class="flex flex-wrap gap-3">
        <div
          v-for="entry in entries"
          :key="entry.id"
          class="relative w-28 h-28 rounded border border-line overflow-hidden bg-surface-sunken"
        >
          <img :src="entry.previewUrl || entry.serverUrl" alt="公告配图预览" class="w-full h-full object-contain">
          <!-- 上传中遮罩：未拿到服务端地址前不允许提交，避免公告里出现拿不到的地址 -->
          <div v-if="entry.uploading" class="absolute inset-0 grid place-items-center bg-black/60 text-xs text-fg-secondary">
            上传中…
          </div>
          <button
            type="button"
            class="absolute top-1 right-1 grid place-items-center w-5 h-5 rounded bg-black/70 text-red-300 hover:text-red-200"
            title="移除该图"
            @click.stop="removeEntry(entry)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
          </button>
        </div>
      </div>
    </div>
    <p class="mt-1 text-xs text-fg-faint">
      最多 {{ imageConfig.maxCount }} 张；GIF 保留动图，其它格式压缩为 JPEG 后上传
    </p>
  </div>
</template>

<script setup>
/**
 * 公告配图上传器（发送表单与编辑弹窗共用）
 *
 * 对外只认"服务端地址数组"（v-model），内部保留本地预览地址：
 *   - 新增：压缩 → 上传 → 拿到地址后并入 v-model
 *   - 已有（编辑时回填）：直接用服务端地址当预览，不再重新上传
 * 这样"编辑公告时复用已上传的图"就退化成"不要把它的地址从数组里删掉"，无需任何额外代码。
 */
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { ANNOUNCEMENT_IMAGE_CONFIG } from '../../../config'
import { prepareAnnouncementImage, extractClipboardImages } from '../../../utils/image'
import { uploadAnnouncementImage } from '../../../api/admin'
import { registerUploader, activateUploader, isActiveUploader } from '../../../utils/imagePasteBus'
import { useUIStore } from '../../../stores/ui'

const props = defineProps({
  /** 配图地址列表（服务端地址） */
  modelValue: {
    type: Array,
    default: () => []
  },
  label: {
    type: String,
    default: '公告配图'
  }
})

const emit = defineEmits(['update:modelValue'])
const uiStore = useUIStore()

const imageConfig = ANNOUNCEMENT_IMAGE_CONFIG

const rootRef = ref(null)
const fileInputRef = ref(null)
// 递增 ID：用下标做 key 时，删除中间一张会导致后续预览错位
let entrySeq = 0
const entries = ref([])
const instanceId = `uploader-${Math.random().toString(36).slice(2, 10)}`

const isUploading = computed(() => entries.value.some(entry => entry.uploading))
defineExpose({ isUploading })

/**
 * 触发文件选择
 */
const triggerFilePicker = () => {
  activateUploader(instanceId)
  fileInputRef.value?.click()
}

/**
 * 文件选择回调
 */
const handleFileChange = (event) => {
  // FileList 在部分浏览器不可迭代，统一用 Array.from
  addFiles(Array.from(event.target.files || []))
  // 清空 input：同一张图连续选两次也要能触发 change
  event.target.value = ''
}

/**
 * 拖拽
 */
const handleDrop = (event) => {
  activateUploader(instanceId)
  addFiles(Array.from(event.dataTransfer?.files || []))
}

/**
 * 粘贴（挂 document，由 imagePasteBus 仲裁由谁接管）
 * @param {ClipboardEvent} event
 */
const handlePaste = (event) => {
  if (!isActiveUploader(instanceId)) return

  const files = extractClipboardImages(event)
  if (files.length === 0) return

  // 阻止浏览器把图片按"文件名/图片地址"文本插入到当前输入框
  event.preventDefault()
  addFiles(files)
}

/**
 * 添加并上传若干图片
 * @param {File[]} files
 */
const addFiles = (files) => {
  if (files.length === 0) return

  const remain = imageConfig.maxCount - entries.value.length
  if (remain <= 0) {
    uiStore.showToast(`最多只能添加 ${imageConfig.maxCount} 张配图`, 'warning')
    return
  }
  if (files.length > remain) {
    uiStore.showToast(`最多只能添加 ${imageConfig.maxCount} 张配图，已忽略多余的 ${files.length - remain} 张`, 'warning')
  }
  files.slice(0, remain).forEach(uploadFile)
}

/**
 * 单张：压缩 → 上传 → 记录服务端地址
 * @param {File} file
 */
const uploadFile = async (file) => {
  const entry = reactive({
    id: ++entrySeq,
    previewUrl: '',
    serverUrl: '',
    uploading: true
  })
  entries.value.push(entry)

  try {
    const prepared = await prepareAnnouncementImage(file)
    entry.previewUrl = prepared.previewUrl

    const res = await uploadAnnouncementImage(prepared.blob, prepared.mimeType)
    const data = res.data?.data || res.data

    // 上传过程中可能已被移除，此时不能再把地址写回已删除的条目
    if (!entries.value.includes(entry)) return

    entry.serverUrl = data.url
    entry.uploading = false
    emitChange()
  } catch (error) {
    // 失败即摘掉，避免留下一个永远转圈、也提交不出去的占位
    removeEntry(entry)
    notifyImageError(error)
  }
}

/**
 * 移除一张配图
 * @param {Object} entry
 */
const removeEntry = (entry) => {
  const index = entries.value.indexOf(entry)
  if (index === -1) return

  entries.value.splice(index, 1)
  // 本地预览用的是 Blob URL，不释放会一直占着内存直到页面刷新
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl)
  emitChange()
}

/**
 * 向父组件回传当前地址列表
 */
const emitChange = () => {
  emit('update:modelValue', entries.value.map(entry => entry.serverUrl).filter(Boolean))
}

/**
 * 配图失败的统一提示
 *
 * 本地预处理抛出的错误（格式不支持、压缩后仍超上限）没有 response，
 * 此时 error.message 才是 GM 需要看的那句话，不能走 apiErrorMessage 的兜底文案。
 * @param {Error} error
 */
const notifyImageError = (error) => {
  if (!error?.response && error?.message) {
    console.error('图片上传失败:', error)
    uiStore.showToast(error.message, 'error')
    return
  }
  uiStore.showApiError(error, '图片上传失败')
}

/**
 * 用外部传入的地址重建条目
 *
 * 只在地址真的变了时重建：emitChange 之后会反过来触发这个 watch，
 * 若不比较就会把刚上传好的预览和 Blob URL 一起冲掉（表现为"上传后图片闪一下消失"）。
 * @param {string[]} urls
 */
const syncFromModel = (urls) => {
  const next = Array.isArray(urls) ? urls.filter(Boolean) : []
  const current = entries.value.map(entry => entry.serverUrl).filter(Boolean)
  if (next.length === current.length && next.every((url, index) => url === current[index])) return

  entries.value.forEach(entry => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl)
  })
  // 已有地址不需要本地预览：直接用服务端地址当 img src
  entries.value = next.map(url => reactive({
    id: ++entrySeq,
    previewUrl: '',
    serverUrl: url,
    uploading: false
  }))
}

watch(() => props.modelValue, syncFromModel, { deep: true })

// 注销函数放在 setup 作用域：生命周期钩子只能在 setup 里同步注册，
// 写进 onMounted 回调里不会被当前实例接管
let unregisterUploader = null

onMounted(() => {
  syncFromModel(props.modelValue)
  unregisterUploader = registerUploader(instanceId)
  // 组件挂载即抢占粘贴权：弹窗里的上传器后挂载，天然接管
  activateUploader(instanceId)
  document.addEventListener('paste', handlePaste)
})

onUnmounted(() => {
  document.removeEventListener('paste', handlePaste)
  if (unregisterUploader) unregisterUploader()
  entries.value.forEach(entry => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl)
  })
})
</script>
