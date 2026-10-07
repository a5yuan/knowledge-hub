/**
 * 鉴权域字段映射（spec §4.1 权威定义，工单 02 引用不复制）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 */
import type { LoginResult, PublicUser } from '@/types/api'

/** 后端 AuthUser（knowledge-hub-backend/src/auth/interfaces/auth-user.interface.ts） */
export interface BackendAuthUser {
  /** 雪花 ID 字符串 */
  userId: string
  username: string
  realName: string | null
  email: string | null
  avatar: string | null
  /** 角色编码列表，如 ['ROLE_ADMIN', 'ROLE_USER'] */
  roles: string[]
}

/** 后端登录 / refresh 统一返回（auth.service.ts TokenPairResult） */
export interface BackendTokenPair {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  /** accessToken 有效期（秒） */
  expiresIn: number
  userInfo: BackendAuthUser
}

export function mapAuthUser(u: BackendAuthUser): PublicUser {
  return {
    id: String(u.userId),
    username: u.username,
    displayName: u.realName ?? u.username,
    role: u.roles.includes('ROLE_ADMIN') ? 'admin' : 'member',
    // 后端无部门字段，不可能提供（spec §4.1 有损映射）
    departmentId: '',
    // 派生安全：后端登录时已对禁用账号返回 403
    status: 'active',
    // 后端不提供，仅系统管理表格用（属 Mock 组）
    createdAt: '',
    roles: u.roles,
    avatar: u.avatar,
  }
}

export function mapTokenPair(res: BackendTokenPair): LoginResult {
  return { token: res.accessToken, user: mapAuthUser(res.userInfo) }
}
