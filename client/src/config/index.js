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
  // 默认分页大小
  defaultPageSize: 10,
  // 登录防抖时间（毫秒）
  loginDebounce: 500,
  // loading 最小显示时间（毫秒）
  minLoadingTime: 500,
  // 数字动画时长（毫秒）
  numberAnimationDuration: 300
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
  'stock:margin_call'
]
