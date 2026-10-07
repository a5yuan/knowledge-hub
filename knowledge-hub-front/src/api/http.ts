import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import { ApiError, normalizeResponse, toApiError } from './normalize'
import { isReal } from './endpoint'
import { clearSession, getAccessToken, getMockToken } from './session'
import { refreshTokens } from './refresh'

export { ApiError }
export { TOKEN_KEY } from './session'

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 重放请求标记：命中 401 时不再触发刷新（防循环） */
    _skipAuthRefresh?: boolean
  }
}

export function getToken(): string | null {
  return getAccessToken()
}

export function setToken(token: string): void {
  localStorage.setItem('kh_token', token)
}

/** 清空全部会话键（kh_token / kh_refresh_token / kh_token_exp / kh_mock_token） */
export function clearToken(): void {
  clearSession()
}

const http = axios.create({
  // 默认走 Mock 保留地（spec §3.1：/api 永不配置代理）；真实请求由 endpoint() 显式覆盖 baseURL 为 /real
  baseURL: '/api',
  timeout: 15000,
})

// 按通道选 token（spec §3.3）：/real 用 access token；/api 用 mock token（会话桥），纯 Mock 会话回落 kh_token
http.interceptors.request.use((config) => {
  const token = isReal(config) ? getAccessToken() : (getMockToken() ?? getAccessToken())
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 职责收敛（spec §3.2 硬约束 5）：拦截器只管「401 → 单飞刷新 → 重放一次」；业务码校验统一在 normalizeResponse
http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as (InternalAxiosRequestConfig & { _skipAuthRefresh?: boolean }) | undefined
    if (error.response?.status === 401 && config && !config._skipAuthRefresh) {
      if (isReal(config)) {
        // 单飞刷新：并发 401 共享同一个 refresh；成功后重放一次（标记 _skipAuthRefresh 防循环）
        const refreshed = await refreshTokens()
        if (refreshed) {
          config._skipAuthRefresh = true
          config.headers.Authorization = `Bearer ${getAccessToken() ?? ''}`
          return http.request(config)
        }
      }
      // 刷新失败（或 Mock 通道 401）：清全部会话键并跳登录
      clearSession()
      // 同时清内存用户态（工单 05）：否则守卫见 store 仍「已登录」会把 /login 弹回业务页，点菜单循环弹跳
      const { useUserStore } = await import('@/stores/user')
      useUserStore().user = null
      // 动态引入避免 router → layout → store → api → http 循环依赖；已在登录页时不重复跳转
      const { default: router } = await import('@/router')
      if (router.currentRoute.value.path !== '/login') {
        void router
          .push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
          .catch(() => { })
      }
    }
    return Promise.reject(toApiError(error))
  },
)

/** 类型安全的请求封装：签名不变（12 个 API 模块调用点零改动），拆包按通道分流至 normalizeResponse */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  const response = await http.request<T>(config)
  return normalizeResponse<T>(response)
}

export default http
