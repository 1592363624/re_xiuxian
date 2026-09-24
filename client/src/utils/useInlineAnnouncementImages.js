/**
 * 公告正文内联贴图
 * 在 textarea 光标处插入 ![图片](url) 标记；上传中用 pending:ID 占位，完成后就地替换。
 */
import { ref, nextTick } from 'vue'
import { prepareAnnouncementImage, extractClipboardImages } from './image'
import { uploadAnnouncementImage } from '../api/admin'
import {
  imageToken,
  insertTokenAtCaret,
  replacePendingToken,
  removePendingToken,
  extractInlineImageUrls,
  countInlineImages
} from './announcementContent'
import { ANNOUNCEMENT_IMAGE_CONFIG } from '../config'
import { useUIStore } from '../stores/ui'

let pendingSeq = 0

/**
 * @param {import('vue').Ref<string>} contentRef - 正文（含图片标记）
 * @param {import('vue').Ref<HTMLTextAreaElement|null>} textareaRef
 */
export function useInlineAnnouncementImages(contentRef, textareaRef) {
  const uiStore = useUIStore()
  const uploadingCount = ref(0)

  const applyValue = async (value, caret) => {
    contentRef.value = value
    await nextTick()
    const ta = textareaRef.value
    if (ta) {
      ta.focus()
      const pos = Math.min(caret ?? value.length, value.length)
      ta.setSelectionRange(pos, pos)
    }
  }

  const onPaste = async (event) => {
    const files = extractClipboardImages(event)
    if (files.length === 0) return

    event.preventDefault()
    const ta = event.target instanceof HTMLTextAreaElement ? event.target : textareaRef.value
    if (!ta) return

    if (countInlineImages(contentRef.value) + files.length > ANNOUNCEMENT_IMAGE_CONFIG.maxCount) {
      uiStore.showToast(`公告配图最多 ${ANNOUNCEMENT_IMAGE_CONFIG.maxCount} 张`, 'warning')
      return
    }

    for (const file of files) {
      const pendingId = `p${++pendingSeq}-${Date.now()}`
      const token = imageToken(`pending:${pendingId}`, '图片上传中')
      const { value, caret } = insertTokenAtCaret(ta, token)
      // 多图连续粘贴时，后续插入要基于已更新的正文
      ta.value = value
      await applyValue(value, caret)

      uploadingCount.value += 1
      uploadOne(file, pendingId).finally(() => {
        uploadingCount.value = Math.max(0, uploadingCount.value - 1)
      })
    }
  }

  const uploadOne = async (file, pendingId) => {
    try {
      const prepared = await prepareAnnouncementImage(file)
      const res = await uploadAnnouncementImage(prepared.blob, prepared.mimeType)
      const data = res.data?.data || res.data
      const url = data?.url
      if (!url) throw new Error('上传成功但未返回图片地址')

      // 用户可能已手动删掉占位：此时不要再插回去
      if (!contentRef.value.includes(`pending:${pendingId}`)) return
      contentRef.value = replacePendingToken(contentRef.value, pendingId, url)
    } catch (error) {
      if (contentRef.value.includes(`pending:${pendingId}`)) {
        contentRef.value = removePendingToken(contentRef.value, pendingId)
      }
      if (!error?.response && error?.message) {
        uiStore.showToast(error.message, 'error')
      } else {
        uiStore.showApiError(error, '图片上传失败')
      }
    }
  }

  /** 提交前取出地址列表（供后端白名单/清理使用） */
  const getImageUrls = () => extractInlineImageUrls(contentRef.value)

  /** 是否仍有图在传 */
  const isUploading = () => uploadingCount.value > 0

  return { onPaste, getImageUrls, isUploading, uploadingCount }
}
