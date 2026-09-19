import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { router } from './router'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(router)

// 等首屏路由解析完再挂：否则 App.vue 会在 route 还是 START_LOCATION 时
// 渲染一次，GameLayout 拿到 panelId=undefined，面板闪一下再消失。
router.isReady().then(() => app.mount('#app'))
