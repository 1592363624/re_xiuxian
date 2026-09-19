/**
 * 面板路由
 *
 * 设计文档第二章写的原则是「组件化 + 路由化：通过统一路由管理跳转逻辑」。
 * 组件化那半落在 components/ui 与 panels/registry.js 上；这一层补路由化那半。
 *
 * 在此之前面板开关只是 GameLayout 里的一个局部 ref，于是：
 *   - 按浏览器后退 = 直接离开游戏，而不是收起当前面板；
 *   - F5 刷新必定回到总览，正在比对拍卖行的玩家被踢回起点；
 *   - 「打开着斗法面板」这个状态无法分享、无法从聊天链接跳过去。
 *
 * 现在面板标识进 URL：/ 是右坞总览，/p/<actionId> 是展开中的面板。
 * id 的合法性由 panels/registry.js 判（GameLayout 里 resolvePanel 拿不到组件
 * 就退回总览），这里不再重复一份白名单——两处清单必然会漂移。
 *
 * 用 hash 模式而非 history 模式：生产环境由 Node 直接托管静态文件，
 * 没有 SPA fallback，history 模式下刷新 /p/market 会打到后端拿 404。
 */
import { createRouter, createWebHashHistory } from 'vue-router'

const GameLayout = () => import('../components/layout/GameLayout.vue')

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: GameLayout },
    { path: '/p/:panelId', name: 'panel', component: GameLayout },
    // 手改 hash 或旧书签留下的未知地址，回总览而不是白屏
    { path: '/:any(.*)*', name: 'unknown', redirect: '/' },
  ],
})

/** 面板 id → 路由目标；null 表示回总览 */
export const panelRoute = (id) =>
  id ? { name: 'panel', params: { panelId: id } } : { name: 'home' }
