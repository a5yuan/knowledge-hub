import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { permission } from './directives/permission'
import { initSession } from './api/session'
import './styles/index.css'

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(ElementPlus)
app.directive('permission', permission)

async function bootstrap(): Promise<void> {
  // 版本闸最先落地（工单 01）：kh_session_v 不匹配时清理历史遗留单 token，先于一切会话读取
  initSession()

  // Mock 门（spec §3.1）：开发默认开启；生产构建默认关闭，VITE_ENABLE_MOCK=true 可显式开启（preview 演示），
  // VITE_ENABLE_MOCK=false 始终关闭（联调真实后端）
  const mockEnabled =
    import.meta.env.VITE_ENABLE_MOCK !== 'false' &&
    (import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK === 'true')

  if (mockEnabled) {
    const { worker } = await import('./mocks/browser')
    await worker.start({
      onUnhandledRequest(request, print) {
        const { pathname } = new URL(request.url)
        // /real 与 /storage 走 Vite 代理直连后端/对象存储，MSW 静默放行
        if (pathname.startsWith('/real') || pathname.startsWith('/storage')) return
        // /api 是 Mock 命名空间：漏 handler 才告警；其余请求维持原 bypass 语义
        if (pathname.startsWith('/api')) print.warning()
      },
    })
  }

  // worker 必须先于 router 就绪，否则首次路由守卫的 /auth/me 会绕过 mock 直打 dev server
  app.use(router)
  app.mount('#app')
}

void bootstrap()
