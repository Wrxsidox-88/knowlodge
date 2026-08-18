import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 后端端口跟随 server/.env 中的 PORT（如未设置环境变量，默认 2032）
const API_PORT = process.env.KL_API_PORT || '2032';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true
      }
    }
  }
});