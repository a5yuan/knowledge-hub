// 演示录制专用配置（临时文件，录制后可删）
// 目的：把 Vite 的依赖预构建缓存指向 worktree 本地目录，
// 避免与主仓库共享的 node_modules/.vite 冲突（配置差异会触发重建，进而触发批量删除保护）。
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

export default mergeConfig(
  base,
  defineConfig({
    cacheDir: '.vite-demo',
  }),
)
