import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd())
  const clientPort = parseInt(env.VITE_CLIENT_PORT) || 8000
  const apiUrl = env.VITE_API_URL || 'http://localhost:5000'

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: clientPort,
      proxy: {
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              if (err.code === 'ECONNREFUSED') {
                console.warn('[前端] 后端服务暂未就绪，请求将自动重试...')
              }
            })
          }
        }
      }
    }
  }
})
