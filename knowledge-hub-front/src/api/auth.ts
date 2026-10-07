import { adapt } from './adapt'
import { endpoint } from './endpoint'
import { request } from './http'
import { setAccessToken, setRefreshToken, setTokenExp } from './session'
import { mapAuthUser, mapTokenPair, type BackendAuthUser, type BackendTokenPair } from './adapters/auth'
import type { LoginResult, PublicUser } from '@/types/api'

/**
 * 登录：真实通道（/real/auth/login）双 Token 落盘（kh_token / kh_refresh_token / kh_token_exp）；
 * Mock 通道原样返回（token 由调用方经 setToken 写入 kh_token）。
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const { baseURL, url } = endpoint('auth', '/login')
  const config = { baseURL, url, method: 'post' as const, data: { username, password } }
  const raw = await request<LoginResult>(config)
  return adapt<LoginResult, BackendTokenPair>(config, raw, (real) => {
    setAccessToken(real.accessToken)
    setRefreshToken(real.refreshToken)
    setTokenExp(real.expiresIn)
    return mapTokenPair(real)
  })
}

/** 会话恢复：真实通道 /auth/me 返回 AuthUser，经 mapAuthUser 归一 */
export async function fetchMe(): Promise<PublicUser> {
  const { baseURL, url } = endpoint('auth', '/me')
  const config = { baseURL, url, method: 'get' as const }
  const raw = await request<PublicUser>(config)
  return adapt<PublicUser, BackendAuthUser>(config, raw, mapAuthUser)
}

/** 菜单树节点（后端 PermissionService.MenuNode，camelCase 直出无需映射） */
export interface PermissionMenuNode {
  id: string
  permissionName: string
  permissionCode: string
  menuUrl: string | null
  icon: string | null
  sort: number
  children: PermissionMenuNode[]
}

/** 当前用户三级权限总览（GET /auth/permissions）：codes 全量权限码 / menus 菜单树 / buttons 按钮码 */
export interface PermissionOverview {
  codes: string[]
  menus: PermissionMenuNode[]
  buttons: string[]
}

/** 当前用户权限总览（菜单/按钮渲染控制数据源，登录与恢复会话后拉取） */
export function fetchMyPermissions(): Promise<PermissionOverview> {
  const { baseURL, url } = endpoint('auth', '/permissions')
  return request<PermissionOverview>({ baseURL, url, method: 'get' })
}

/** 更新个人资料（昵称）：后端无 PATCH /auth/profile，显式钉在 Mock 通道 */
export function updateProfile(displayName: string): Promise<PublicUser> {
  const { baseURL, url } = endpoint('auth', '/profile', 'mock')
  return request<PublicUser>({ baseURL, url, method: 'patch', data: { displayName } })
}

/** 修改密码：后端无 PUT /auth/password，显式钉在 Mock 通道 */
export function changePassword(oldPassword: string, newPassword: string): Promise<null> {
  const { baseURL, url } = endpoint('auth', '/password', 'mock')
  return request<null>({ baseURL, url, method: 'put', data: { oldPassword, newPassword } })
}
