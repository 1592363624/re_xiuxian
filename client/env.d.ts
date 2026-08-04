/**
 * 前端全局类型声明
 *
 * 声明 *.vue 单文件组件模块，使 TypeScript / vue-tsc 在类型检查阶段
 * 能够正确解析 .vue 导入（Vite 运行时由 @vitejs/plugin-vue 处理，但 vue-tsc 需要显式声明）。
 */
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
