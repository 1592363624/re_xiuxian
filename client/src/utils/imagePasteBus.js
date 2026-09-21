/**
 * 配图粘贴的仲裁器
 *
 * 为什么需要：配图上传器支持"直接 Ctrl+V"，做法是监听 document 的 paste。
 * 而页面上可能同时挂着多个上传器（发送表单 + 编辑弹窗），
 * 如果两个都响应同一次粘贴，一张图会被上传两遍，预览里出现两份。
 *
 * 规则：只有"当前激活"的那个上传器接管事件。激活时机由组件自己决定
 * （挂载时抢占、用户点进上传区时再抢占），弹窗打开/关闭会自然完成接力。
 */

/** 当前接管粘贴的上传器 id */
let activeId = null
/** 已注册的上传器 id，用来在注销时把接力棒交出去 */
const registered = new Set()

/**
 * 注册一个上传器
 * @param {string} id - 上传器唯一标识
 * @returns {Function} 注销函数（组件卸载时调用）
 */
export function registerUploader(id) {
  registered.add(id)
  // 第一个注册的先接管：正常情况下"发送表单"会比"编辑弹窗"先挂载
  if (activeId === null) activeId = id

  return () => {
    registered.delete(id)
    // 注销的正是当前接管者时把接力棒交给还在的任意一个（弹窗关闭 → 回到发送表单）
    if (activeId === id) {
      activeId = registered.size > 0 ? registered.values().next().value : null
    }
  }
}

/**
 * 让某个上传器接管粘贴（弹窗打开、或用户点进了某个上传区域时调用）
 * @param {string} id
 */
export function activateUploader(id) {
  if (registered.has(id)) activeId = id
}

/**
 * 判断某个上传器此刻是否该接管粘贴
 * @param {string} id
 * @returns {boolean}
 */
export function isActiveUploader(id) {
  return activeId === id
}
