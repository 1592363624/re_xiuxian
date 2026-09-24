/**
 * 公告图文混排
 *
 * 内容里用 Markdown 图片语法占位：`![图片](url)`。
 * 粘贴截图时把标记插进光标处，展示端按同样顺序拆成文字段/图片段渲染，
 * 不再把配图统一堆在正文下面。
 *
 * 兼容旧公告：content 里没有标记、配图在 metadata.imageUrls 时，图仍追加在文末。
 */

/** 图片标记：![任意说明](url)；url 可为空或 pending:xxx（上传中占位） */
const IMAGE_TOKEN_RE = /!\[([^\]]*)\]\(([^)]*)\)/g

/**
 * 从正文取出已就绪的图片地址（跳过上传中 pending: 与空 url）
 * @param {string} content
 * @returns {string[]}
 */
export function extractInlineImageUrls(content) {
  const urls = []
  const re = new RegExp(IMAGE_TOKEN_RE.source, 'g')
  let m = re.exec(content || '')
  while (m) {
    const url = (m[2] || '').trim()
    if (url && !url.startsWith('pending:')) urls.push(url)
    m = re.exec(content || '')
  }
  return urls
}

/**
 * 正文里图片标记个数（含上传中），用于「最多 N 张」预检
 * @param {string} content
 * @returns {number}
 */
export function countInlineImages(content) {
  const re = new RegExp(IMAGE_TOKEN_RE.source, 'g')
  return (content || '').match(re)?.length || 0
}

/**
 * 把正文拆成展示段：[{type:'text'|'image', text|url, uploading?}]
 * @param {string} content
 * @param {string[]} [fallbackImageUrls] - 旧数据：正文无标记时追加到文末的配图
 * @returns {Array<{type: string, text?: string, url?: string, uploading?: boolean}>}
 */
export function parseAnnouncementSegments(content, fallbackImageUrls = []) {
  const text = content || ''
  const segments = []
  const re = new RegExp(IMAGE_TOKEN_RE.source, 'g')
  let last = 0
  let m = re.exec(text)
  while (m) {
    if (m.index > last) {
      segments.push({ type: 'text', text: text.slice(last, m.index) })
    }
    const url = (m[2] || '').trim()
    if (url && !url.startsWith('pending:')) {
      segments.push({ type: 'image', url })
    } else {
      segments.push({ type: 'image', url: '', uploading: true })
    }
    last = m.index + m[0].length
    m = re.exec(text)
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) })
  }

  const hasInline = segments.some(s => s.type === 'image')
  if (!hasInline && Array.isArray(fallbackImageUrls)) {
    for (const url of fallbackImageUrls) {
      if (url) segments.push({ type: 'image', url })
    }
  }

  return segments.filter(s => s.type === 'image' || (s.text != null && s.text.length > 0))
}

/**
 * 列表/摘要用：去掉图片标记，只留可读文字
 * @param {string} content
 * @returns {string}
 */
export function stripImageTokens(content) {
  return (content || '').replace(new RegExp(IMAGE_TOKEN_RE.source, 'g'), ' [图] ').replace(/\s+\[图\]\s+/g, ' [图] ')
}

/**
 * 构造一个图片标记
 * @param {string} url - 真实地址，或 pending:ID 上传中占位
 * @param {string} [alt]
 */
export function imageToken(url, alt = '图片') {
  return `![${alt}](${url})`
}

/**
 * 把标记插进 textarea 光标处（独占一行，方便 GM 读源文）
 * @param {HTMLTextAreaElement} ta
 * @param {string} token
 * @returns {{ value: string, caret: number }} 插入后的值与新光标位置
 */
export function insertTokenAtCaret(ta, token) {
  const value = ta.value
  const start = ta.selectionStart ?? value.length
  const end = ta.selectionEnd ?? start
  const before = value.slice(0, start)
  const after = value.slice(end)
  // 图片标记独占一行：前面补换行、后面还有正文时也补换行
  const insert = `${before.length > 0 && !before.endsWith('\n') ? '\n' : ''}${token}${after.length > 0 ? '\n' : ''}`
  const next = before + insert + after
  const caret = before.length + insert.length
  return { value: next, caret }
}

/**
 * 在正文中就地替换某个占位标记
 * @param {string} content
 * @param {string} pendingId
 * @param {string} url
 * @returns {string}
 */
export function replacePendingToken(content, pendingId, url) {
  const re = new RegExp(`!\\[([^\\]]*)\\]\\(pending:${escapeRegExp(pendingId)}\\)`)
  return (content || '').replace(re, imageToken(url))
}

/**
 * 删掉某个上传中占位（失败时清场）
 * @param {string} content
 * @param {string} pendingId
 * @returns {string}
 */
export function removePendingToken(content, pendingId) {
  const re = new RegExp(`!\\[([^\\]]*)\\]\\(pending:${escapeRegExp(pendingId)}\\)\\n?`)
  return (content || '').replace(re, '')
}

/**
 * 旧公告（正文无图、配图在 imageUrls）编辑时并入正文，便于拖到任意位置
 * @param {string} content
 * @param {string[]} imageUrls
 * @returns {string}
 */
export function inlineLegacyImages(content, imageUrls) {
  const text = content || ''
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return text
  if (extractInlineImageUrls(text).length > 0 || countInlineImages(text) > 0) return text
  let out = text
  for (const url of imageUrls) {
    if (!url) continue
    if (out.length > 0 && !out.endsWith('\n')) out += '\n'
    out += `${imageToken(url)}\n`
  }
  return out
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
