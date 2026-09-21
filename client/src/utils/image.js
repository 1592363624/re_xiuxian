/**
 * 图片处理工具
 * 公告配图专用：把剪贴板/文件选择得到的图片先本地压缩，再交给上传接口
 *
 * 为什么必须先压缩再上传：
 *   截图工具产出的整屏图常见 2~5MB，直接上传既慢又容易被后端体积上限拒掉；
 *   而公告配图在弹窗里最宽也只有几百像素，缩到 1600px 长边肉眼几乎无损，体积能降一个量级。
 */
import { ANNOUNCEMENT_IMAGE_CONFIG } from '../config'

/**
 * 字节数转可读体积（用于错误提示，避免 GM 看到一串裸数字）
 * @param {number} bytes
 * @returns {string} 形如 "1.2 MB"
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 判断 MIME 是否在允许的图片白名单内
 * @param {string} type
 * @returns {boolean}
 */
export function isSupportedImageType(type) {
  return ANNOUNCEMENT_IMAGE_CONFIG.acceptTypes.includes(type)
}

/**
 * 加载 Blob 为可绘制的 HTMLImageElement
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      // 已经拿到解码结果，及时释放对象 URL，避免长时间占用内存
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('图片解析失败，请重新粘贴或换一张图片'))
    }
    img.src = objectUrl
  })
}

/**
 * 等比缩放并转成 JPEG
 * @param {Blob} blob - 原图
 * @returns {Promise<Blob>} 压缩后的 JPEG Blob
 */
async function resizeToJpeg(blob) {
  const { maxEdgePx, quality } = ANNOUNCEMENT_IMAGE_CONFIG
  const img = await loadImage(blob)

  const longestEdge = Math.max(img.width, img.height)
  // 只缩不放：小图强行放大只会变糊且体积更大
  const scale = longestEdge > maxEdgePx ? maxEdgePx / longestEdge : 1
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  // JPEG 不支持透明通道，先铺白底，否则 PNG 截图的透明区域会变成黑块
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  const compressed = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!compressed) {
    throw new Error('图片压缩失败，请重新粘贴或换一张图片')
  }
  return compressed
}

/**
 * 预处理一张待上传的公告配图
 * @param {File|Blob} file - 剪贴板或文件选择得到的图片
 * @returns {Promise<{blob: Blob, mimeType: string, previewUrl: string}>}
 *   blob 为上传用的数据，previewUrl 为本地预览地址（由调用方在移除图片时 revoke）
 * @throws {Error} 类型不支持、解析失败或压缩后仍超大时抛出可直接展示的提示语
 */
export async function prepareAnnouncementImage(file) {
  if (!file || !isSupportedImageType(file.type)) {
    throw new Error('仅支持 PNG / JPG / WEBP / GIF 格式的图片')
  }

  // GIF 动图经 canvas 会只剩第一帧，直接原样上传
  const prepared = file.type === 'image/gif' ? file : await resizeToJpeg(file)
  const { maxSizeBytes } = ANNOUNCEMENT_IMAGE_CONFIG

  if (prepared.size > maxSizeBytes) {
    throw new Error(`图片体积过大（压缩后 ${formatBytes(prepared.size)}，上限 ${formatBytes(maxSizeBytes)}）`)
  }

  return {
    blob: prepared,
    mimeType: prepared.type || file.type,
    previewUrl: URL.createObjectURL(prepared)
  }
}

/**
 * 从剪贴板事件中取出所有图片文件
 * @param {ClipboardEvent} event
 * @returns {File[]} 剪贴板里的图片（无图时为空数组）
 */
export function extractClipboardImages(event) {
  const items = event?.clipboardData?.items
  if (!items) return []

  const files = []
  // 用下标遍历而非 for...of：DataTransferItemList 在部分浏览器里没有实现 Symbol.iterator
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isSupportedImageType(file.type)) files.push(file)
  }
  return files
}
