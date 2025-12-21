# 凡人修仙传 - 后端项目 (Server)

基于 Node.js + Express 构建的 RESTful API 服务，承载游戏的核心逻辑与数据存储。

## 🛠 技术栈

*   **运行时**: Node.js
*   **Web 框架**: Express
*   **ORM**: Sequelize
*   **数据库**: MySQL 5.6
*   **认证**: JWT (JSON Web Token)

## 📂 目录结构

*   `config/`: 配置文件 (数据库连接等)
*   `middleware/`: 中间件 (身份验证 `auth.js` 等)
*   `models/`: Sequelize 数据模型定义 (Player, Chat 等)
*   `routes/`: API 路由定义
    *   `auth.js`: 注册、登录
    *   `player.js`: 玩家信息、属性管理
    *   `chat.js`: 聊天系统
*   `index.js`: 服务端入口文件

## ⚙️ 配置说明

环境变量通常配置在 `.env` 文件中 (本项目目前直接在代码或 docker 环境变量中配置)：
*   `PORT`: 服务器端口 (默认 3000)
*   `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`: 数据库连接信息

## 📜 常用命令

### 启动服务器
```bash
npm start
```
启动生产环境服务器。

### 开发模式启动
```bash
npm run dev
```
使用 `nodemon` 启动服务器，支持代码变动自动重启。

## 🔒 核心机制

### 认证与安全
*   使用 JWT 进行无状态认证。
*   实现了单设备登录互斥机制：当新设备登录时，旧设备的 Token 会失效。
*   **位置验证**：后端强制校验玩家位置，防止前端伪造坐标。

### 静态资源托管
服务器配置了静态资源托管中间件，当访问非 API 路径时，会自动返回 `../client/dist` 目录下的前端页面。这意味着你可以直接部署后端服务来同时提供 API 和 页面访问。
