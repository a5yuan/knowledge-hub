/**
 * 单飞刷新（spec §7 术语表）：并发 401 共享同一个 refresh 请求，避免刷新风暴。
 * 不放 Pinia —— 拦截器在组件树之外，且避免 store → api → http → store 循环依赖
 * （与 stores/user.ts 的 restoring 单飞模式一致）。
 *
 * 用独立的裸 axios 实例发请求，不经 http.ts 拦截器 —— 刷新请求自身的 401
 * 天然不会再次触发刷新（无递归入口），_skipAuthRefresh 标记由 http.ts 重放时使用。
 */
import axios from 'axios'
import { getRefreshToken, setAccessToken, setRefreshToken, setTokenExp } from './session'
import type { BackendTokenPair } from './adapters/auth'

let inflight: Promise<boolean> | null = null

/**
 * 刷新双 Token 并写入会话键。
 * @returns true = 刷新成功（新 token 已落盘）；false = 无 refresh token 或后端拒绝（调用方应清会话跳登录）
 */
export function refreshTokens(): Promise<boolean> {
  inflight ??= doRefresh().finally(() => {
    inflight = null
  })
  return inflight
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  try {
    // 真实通道无包络：2xx body 即 TokenPairResult；后端轮换双 Token，两个都要落盘
    const { data } = await axios.post<BackendTokenPair>(
      '/real/auth/refresh',
      { refreshToken },
      { timeout: 15000 },
    )
    setAccessToken(data.accessToken)
    setRefreshToken(data.refreshToken)
    setTokenExp(data.expiresIn)
    return true
  } catch {
    return false
  }
}
