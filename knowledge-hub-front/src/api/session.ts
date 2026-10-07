/**
 * 会话键管理（spec §3.3）。
 *
 * 四键 + 版本闸：
 * - kh_token        = access token（语义保持，兼容既有 getToken/setToken 消费者）
 * - kh_refresh_token = refresh token（双 Token 轮换）
 * - kh_token_exp    = access token 有效期（秒），用于前端过期预判
 * - kh_mock_token   = 会话桥签发的 Mock token，供 /api 通道使用
 * - kh_session_v    = 版本闸，升级时清理历史遗留单 token 会话
 *
 * 不放 Pinia：拦截器在组件树之外（spec §3.3）。
 */

const KEYS = {
  access: 'kh_token',
  refresh: 'kh_refresh_token',
  exp: 'kh_token_exp',
  mock: 'kh_mock_token',
  version: 'kh_session_v',
} as const

const CURRENT_SESSION_V = '1'

/** access token —— 兼容 http.ts 的 getToken / setToken / TOKEN_KEY 既有 import */
export const TOKEN_KEY = KEYS.access

export function getAccessToken(): string | null {
  return localStorage.getItem(KEYS.access)
}

export function setAccessToken(token: string): void {
  localStorage.setItem(KEYS.access, token)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(KEYS.refresh)
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(KEYS.refresh, token)
}

export function getTokenExp(): number | null {
  const raw = localStorage.getItem(KEYS.exp)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function setTokenExp(expiresIn: number): void {
  localStorage.setItem(KEYS.exp, String(expiresIn))
}

export function getMockToken(): string | null {
  return localStorage.getItem(KEYS.mock)
}

export function setMockToken(token: string): void {
  localStorage.setItem(KEYS.mock, token)
}

/** 清空全部会话键（不含版本键）—— 401 刷新失败 / logout 时调用 */
export function clearSession(): void {
  localStorage.removeItem(KEYS.access)
  localStorage.removeItem(KEYS.refresh)
  localStorage.removeItem(KEYS.exp)
  localStorage.removeItem(KEYS.mock)
}

/**
 * 版本闸：会话键结构升级时清理历史遗留。
 * 必须在 router mount 之前调用（main.ts 中先于 app.use(router)）。
 */
export function initSession(): void {
  const v = localStorage.getItem(KEYS.version)
  if (v !== CURRENT_SESSION_V) {
    clearSession()
    localStorage.setItem(KEYS.version, CURRENT_SESSION_V)
  }
}
