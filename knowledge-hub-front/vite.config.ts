import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

// 双通道代理（工单 01 / spec §3.1）：/api 是 Mock 保留地，永不配置代理。
// server 与 preview 必须成对配置 —— 构建产物经 preview 或 nginx 部署时不存在 server.proxy，
// 漏配 preview.proxy 则构建产物下所有真实请求落到 SPA fallback（spec §3.2 硬约束 4）。
const realProxy: Record<string, ProxyOptions> = {
  // NestJS（3000）：/real 前缀在代理层剥掉；复数→单数等路径重写知识留在 src/api/endpoint.ts 的 REAL_ROOT 常量内
  '/real': {
    target: 'http://127.0.0.1:3000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/real/, ''),
  },
  // RustFS 对象存储（9000）：前端把 source_file_url 归一为 /storage/<bucket>/<key>，
  // 代理剥掉 /storage 前缀转发到 RustFS 同路径
  '/storage': {
    target: 'http://127.0.0.1:9000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/storage/, ''),
  },
}

// 后端地址用 127.0.0.1 而非 localhost（Windows 上 Node 可能优先解析 ::1）
// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: realProxy,
  },
  preview: {
    proxy: realProxy,
  },
})
