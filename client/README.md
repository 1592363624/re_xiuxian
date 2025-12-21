# 凡人修仙传 - 前端项目 (Client)

基于 Vue 3 + Vite 构建的现代化单页应用 (SPA)，为玩家提供流畅的修仙体验。

## 🛠 技术栈

*   **核心框架**: Vue 3 (Composition API)
*   **构建工具**: Vite
*   **状态管理**: Pinia
*   **路由管理**: Vue Router
*   **样式框架**: Tailwind CSS
*   **HTTP 客户端**: Axios

## 📂 目录结构

*   `src/`
    *   `assets/`: 静态资源 (图片、样式)
    *   `components/`: Vue 组件
        *   `layout/`: 布局组件 (如游戏主界面框架)
        *   `modals/`: 弹窗组件 (如设置、背包、战斗结算)
        *   `panels/`: 功能面板 (如属性面板、背包面板)
        *   `widgets/`: 小部件 (如全局聊天)
    *   `router/`: 路由配置
    *   `stores/`: Pinia 状态仓库 (玩家数据、游戏状态)
    *   `views/`: 页面级组件 (登录页、创建角色页)
    *   `App.vue`: 根组件
    *   `main.js`: 入口文件

## 📜 常用命令

### 启动开发服务器
```bash
npm run dev
```
启动本地开发服务器，默认端口 5173。支持热模块替换 (HMR)。

### 构建生产版本
```bash
npm run build
```
将项目编译打包到 `dist` 目录。生成的静态文件可由后端服务器托管。

### 预览生产构建
```bash
npm run preview
```
在本地预览构建后的 `dist` 目录内容。
