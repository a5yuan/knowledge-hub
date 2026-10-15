/**
 * 用户域字段映射（18 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 *
 * ⚠️ `import type { UserView } from '../users'` 必须是 **type-only**：
 * users.ts 会 import 本文件，用 `import type` 保证这条边在编译后被完全擦除，
 * 不会形成运行时循环依赖。
 */
import type { PageQuery, UserRole, UserStatus } from '@/types/api'
import type { UserView } from '../users'

/** 后端 /user 列表行（UserAdminService 的 UserAdminView，snake_case 原样） */
export interface BackendUserView {
  id: string
  username: string
  /** → displayName（空时回落 username） */
  real_name: string | null
  email: string | null
  avatar: string | null
  /** 后端角色码原样，如 ['ROLE_ADMIN','ROLE_USER'] */
  roles: string[]
  /** → departmentId（null → ''） */
  department_id: string | null
  /** → departmentName（null → '—'） */
  department_name: string | null
  /** kh_user.status 原值：0 禁用 1 启用 → 'active' | 'disabled' */
  status: number
  created_at: string
}

/** 后端 /user 分页响应（items 而非 list，与 /document 一致） */
export interface BackendUserPage {
  items: BackendUserView[]
  total: number
  page: number
  pageSize: number
}

/**
 * 后端 → 视图归一。
 *
 * `role` 是**有损折叠**：前端 `UserRole` 只有 admin / member，而 kh_role 有
 * ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER 三种。规则与 `adapters/auth.ts.mapAuthUser`
 * 保持一致（含 ROLE_ADMIN → admin，其余 → member），避免同一用户在顶栏与用户表格里显示不同角色。
 */
export function mapUser(b: BackendUserView): UserView {
  return {
    id: String(b.id),
    username: b.username,
    displayName: b.real_name ?? b.username,
    role: (b.roles ?? []).includes('ROLE_ADMIN') ? 'admin' : 'member',
    roles: b.roles ?? [],
    departmentId: b.department_id ?? '',
    departmentName: b.department_name ?? '—',
    status: b.status === 1 ? 'active' : 'disabled',
    createdAt: b.created_at,
    avatar: b.avatar,
  }
}

/** 视图查询 → 后端 query（departmentId → department_id）；仅真实通道使用 */
export function toBackendUserQuery(
  query: PageQuery & {
    keyword?: string
    role?: UserRole
    departmentId?: string
    status?: UserStatus
  },
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20,
  }
  const kw = query.keyword?.trim()
  if (kw) params.keyword = kw
  if (query.role) params.role = query.role
  // 空串是合法输入（Admin Users.vue 在部门列表为空时会传 ''），语义 = 仅未归属部门的用户
  if (query.departmentId !== undefined) params.department_id = query.departmentId
  if (query.status) params.status = query.status
  return params
}

/**
 * 视图层 camelCase 载荷 → 后端 snake_case 请求体（仅映射传入的字段）。
 *
 * `status` 需转数值：后端 kh_user.status 是 smallint（0/1），而视图层用 'active' | 'disabled'。
 * `departmentId` 传空串时后端会规范化为 null（清空归属）。
 */
export function toBackendUserBody(payload: {
  displayName?: string
  role?: UserRole
  departmentId?: string
  status?: UserStatus
  password?: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.displayName !== undefined) body.real_name = payload.displayName
  if (payload.role !== undefined) body.role = payload.role
  if (payload.departmentId !== undefined) body.department_id = payload.departmentId
  if (payload.status !== undefined) body.status = payload.status === 'active' ? 1 : 0
  if (payload.password !== undefined) body.password = payload.password
  return body
}
