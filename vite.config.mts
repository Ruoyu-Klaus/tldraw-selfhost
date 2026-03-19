import react from '@vitejs/plugin-react-swc'
import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  root: path.join(__dirname, 'src/client'),
  publicDir: path.join(__dirname, 'public'),
  server: {
    port: 5757,
    proxy: {
      // 开发时将 API 请求代理到后端，避免 CORS 问题
      '/connect': { target: 'ws://localhost:5858', ws: true },
      '/uploads': { target: 'http://localhost:5858' },
      '/unfurl': { target: 'http://localhost:5858' },
      '/api': { target: 'http://localhost:5858' },
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['@tldraw/assets'],
  },
})
