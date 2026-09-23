import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd())
  const clientPort = parseInt(env.VITE_CLIENT_PORT) || 5173
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
            // 后端尚未就绪时的连接错误是启动竞态，不是故障：只记一行提示，不走 stderr。
            // Vite 自己的 http proxy error 红字仍会出，所以 start.bat 会先等后端 /api/health。
            proxy.on('error', (err) => {
              if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
                console.log('[前端] 后端服务暂未就绪，请求将自动重试...')
              }
            })
          }
        }
      }
    }
  }
})
