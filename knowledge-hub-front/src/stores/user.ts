import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicUser } from '@/types/api'
import { fetchMe, fetchMyPermissions, login as loginApi } from '@/api/auth'
import { getToken, setToken } from '@/api/http'
import { clearSession } from '@/api/session'

/**
 * 登录用户态：token 存 localStorage（见 api/http），用户信息存本 store。
 * 刷新页面后 store 为空，由路由守卫调用 restoreSession() 经 /auth/me 恢复（工单 03）。
 */
export const useUserStore = defineStore('user', () => {
  const user = ref<PublicUser | null>(null)
  /** 当前用户权限码集合（/auth/permissions，登录/恢复会话后拉取） */
  const permissionCodes = ref<string[]>([])

  const isLoggedIn = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const roleLabel = computed(() => (user.value?.role === 'admin' ? '管理员' : '成员'))
  /**
   * 审核权限（工单 02）：真实会话按后端角色编码判定（ROLE_REVIEWER 或 ROLE_ADMIN）；
   * Mock 会话无 roles 字段，按压平的 role 兜底，保证 Mock 演示下管理员可见审核入口（工单 03 菜单依赖）。
   */
  const canReview = computed(() => {
    const roles = user.value?.roles
    return roles ? roles.includes('ROLE_REVIEWER') || roles.includes('ROLE_ADMIN') : user.value?.role === 'admin'
  })

  /** 拉取当前用户权限码（/auth/permissions）；失败静默（保留空集，hasPermission 兜底放行） */
  async function loadPermissions(): Promise<void> {
    try {
      const overview = await fetchMyPermissions()
      permissionCodes.value = overview.codes
    } catch {
      // 权限拉取失败不封锁 UI（Mock 会话/后端未启动场景），保持空集
    }
  }

  /** 按钮级/页面级渲染判定：admin 短路放行；权限码为空兜底放行（未加载/加载失败不锁死 UI） */
  function hasPermission(code: string): boolean {
    if (isAdmin.value) return true
    if (permissionCodes.value.length === 0) return true
    return permissionCodes.value.includes(code)
  }

  async function login(username: string, password: string): Promise<void> {
    const result = await loginApi(username, password)
    setToken(result.token)
    user.value = result.user
    await loadPermissions()
    // 会话桥（spec §3.3）：登录后镜像进 Mock 内存库，使 /api 端点组在真实登录态下可用
    const { bridgeSession } = await import('@/mocks/identity')
    bridgeSession(result.user)
  }

  /** 用本地 token 恢复会话；失败（token 无效/过期）清凭证。单飞避免并发守卫重复请求 */
  let restoring: Promise<void> | null = null
  function restoreSession(): Promise<void> {
    restoring ??= (async () => {
      if (!getToken()) return
      try {
        user.value = await fetchMe()
        await loadPermissions()
        // 会话桥：页面刷新后 Mock 内存库重建，必须重新镜像（spec §3.3）
        const { bridgeSession } = await import('@/mocks/identity')
        bridgeSession(user.value)
      } catch {
        user.value = null
        permissionCodes.value = []
        clearSession()
      }
    })().finally(() => {
      restoring = null
    })
    return restoring
  }

  /** 清空全部会话键（kh_token/kh_refresh_token/kh_token_exp/kh_mock_token）与用户态；页面跳转由调用方处理 */
  function logout(): void {
    clearSession()
    user.value = null
    permissionCodes.value = []
  }

  /** 个人资料更新后同步本地用户态（顶栏显示跟随刷新） */
  function setUser(u: PublicUser): void {
    user.value = u
  }

  return { user, permissionCodes, isLoggedIn, isAdmin, roleLabel, canReview, hasPermission, login, restoreSession, logout, setUser }
})
