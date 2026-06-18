# AdminPanel 子组件目录

AdminPanel 拆分后的功能子组件，每个子组件负责一个 Tab 页面的独立功能。

## 文件说明

| 文件 | 功能 |
|------|------|
| `PlayerManagement.vue` | 玩家数据管理（列表、搜索、排序、分页） |
| `SystemConfig.vue` | 系统参数配置（存档间隔、闭关配置、时间加速） |
| `NotificationManagement.vue` | 通知管理（发送公告、通知列表） |
| `ServerStats.vue` | 服务器统计（玩家数、在线数、境界分布） |
| `OperationLogs.vue` | 操作日志（管理员操作记录查看） |

## 设计原则

- 每个子组件独立管理自己的数据和 API 调用
- 通过 `defineExpose` 暴露刷新方法供父组件调用
- 弹窗类操作通过 `emit` 事件委托给父组件 AdminPanel 处理
- 使用 `v-if` 懒加载，仅当前激活的 Tab 才会渲染对应子组件
