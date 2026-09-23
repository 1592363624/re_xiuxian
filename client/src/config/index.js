/**
 * 前端配置中心
 * 集中管理所有前端可变常量，避免硬编码
 * 后端地址、轮询间隔、重连参数、正则规则等统一从此处导出
 */

// Socket.IO 连接配置
export const SOCKET_CONFIG = {
  // 重连次数
  reconnectionAttempts: 5,
  // 重连延迟（毫秒）
  reconnectionDelay: 1000,
  // 传输方式
  transports: ['websocket', 'polling']
}

// 数据轮询间隔配置
export const POLL_INTERVALS = {
  // 系统状态轮询间隔（毫秒）
  stats: 30000,
  // 服务器状态检查间隔（毫秒）
  serverStatus: 5000,
  // 移动状态检查间隔（毫秒）
  moveCheck: 5000
}

// UI 配置
export const UI_CONFIG = {
  // 日志最大保留条数
  maxLogs: 200,
  // 实时通知最大保留条数
  maxLiveNotifications: 10,
  // 带配图的全服公告弹窗停留时长（毫秒）：默认 5 秒不足以让玩家看清截图
  announcementAlertDurationMs: 15000,
  // 默认分页大小
  defaultPageSize: 10,
  // 登录防抖时间（毫秒）
  loginDebounce: 500,
  // loading 最小显示时间（毫秒）
  minLoadingTime: 500,
  // 数字动画时长（毫秒）
  numberAnimationDuration: 300,
  // GM 管理后台左侧菜单「分组折叠状态 + 当前页」的本地存储键名（持久化用）
  adminMenuStateKey: 'gm_admin_menu_state'
}

// 后台日志终端（GM 后台「后台日志」页）显示配置
// 日志是要逐行扫读的，字号太小等于没给看；给几档可选并记住上次选择
export const LOG_CONSOLE_CONFIG = {
  // 可选字号（px）
  optionsPx: [12, 14, 16, 18],
  // 默认字号：原先固定 11px 在高分屏上根本看不清，默认提到 14
  defaultPx: 14,
  // 行高倍率：跟着字号一起放大，避免大字号下行距过挤
  lineHeightRatio: 1.6,
  // 上次选择的字号存本地（与菜单折叠状态同一套持久化口径）
  storageKey: 'gm_log_console_font_size'
}

// 全服公告配图配置
// 与后端 server/config/announcement_upload.json 保持一致：前端负责压缩与体积预检，
// 后端负责最终校验，任一侧调阈值时两边都要改
export const ANNOUNCEMENT_IMAGE_CONFIG = {
  // 上传接口（原始二进制直传，避免 base64 带来的 33% 体积膨胀）
  uploadUrl: '/api/uploads/announcement-image',
  // 单条公告最多配几张图
  maxCount: 3,
  // 压缩后允许的最长边（像素）：粘贴 4K 整屏截图时不至于把弹窗和传输都撑爆
  maxEdgePx: 1600,
  // 统一转 JPEG 的压缩质量
  quality: 0.85,
  // 允许粘贴/选择的图片类型（与后端白名单一致）
  acceptTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  // 允许上传的最大体积（字节，与后端 max_file_size_bytes 对应）
  maxSizeBytes: 5 * 1024 * 1024,
  // 列表批量删除单次最多勾选条数（与后端 batch_delete.max_ids_per_request 对应）
  batchDeleteMax: 200
}

// 账号密码正则（与后端 game_balance.auth 保持一致）
export const AUTH_REGEX = {
  // 账号正则：6-12位英文或数字
  username: /^[a-zA-Z0-9]{6,12}$/,
  // 密码正则：6-12位英文或数字
  password: /^[a-zA-Z0-9]{6,12}$/
}

// 道号长度限制（与后端 game_balance.auth 保持一致）
export const NICKNAME_LIMITS = {
  min: 2,
  max: 10
}

// 默认头像 URL（可配置化，避免依赖第三方图床）
export const DEFAULT_AVATAR = import.meta.env.VITE_DEFAULT_AVATAR || ''

// 灵根类型映射（应由后端下发，前端仅做展示映射）
export const ROOT_TYPE_MAP = {
  metal: { name: '金灵根', class: 'text-yellow-400' },
  wood: { name: '木灵根', class: 'text-emerald-400' },
  water: { name: '水灵根', class: 'text-blue-400' },
  fire: { name: '火灵根', class: 'text-red-400' },
  earth: { name: '土灵根', class: 'text-amber-600' },
  thunder: { name: '雷灵根', class: 'text-purple-400' },
  ice: { name: '冰灵根', class: 'text-cyan-400' },
  wind: { name: '风灵根', class: 'text-teal-400' }
}

// 中文灵根名 → 展示配置：服务端归一后可能只给中文名（新建角色存的是 { '金灵根': {...} } 形状），
// 从 ROOT_TYPE_MAP 反推，避免两份表各自漂移
export const ROOT_NAME_MAP = Object.fromEntries(
  Object.entries(ROOT_TYPE_MAP).map(([type, entry]) => [entry.name.replace(/灵根$/, ''), entry])
)

// Socket 事件白名单（与服务端保持一致）
export const SOCKET_EVENTS = [
  'player:updated',
  'move:completed',
  'notification',
  'notification:global',
  'new_message',
  'auth_error',
  // 状态快照：Socket 重连时后端主动推送，前端据此恢复闭关/移动/战斗/历练 UI
  'state:snapshot',
  // 股市系统事件（第四阶段新增：买卖/转账/价格更新/分红/强平/熔断/追加保证金）
  'stock:buy',
  'stock:sell',
  'stock:deposit',
  'stock:withdraw',
  'stock:price_update',
  'stock:dividend',
  'stock:liquidation',
  'stock:halt',
  'stock:margin_call',
  // 大世界地图事件（World Map MVP：同图玩家位置实时同步）
  'world:player-moved'
]
