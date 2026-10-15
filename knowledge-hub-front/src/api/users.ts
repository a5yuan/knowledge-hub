import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import {
  mapUser,
  toBackendUserBody,
  toBackendUserQuery,
  type BackendUserPage,
  type BackendUserView,
} from './adapters/user'
import type { PageQuery, PageResult, PublicUser, UserRole, UserStatus } from '@/types/api'

/**
 * 用户管理 API（18 号工单，管理端 /user）。
 * 双通道：Mock 保持既有 camelCase 契约不动；真实通道经 adapter 转 snake_case。
 * 所有函数一律经 endpoint('users', ...) 取路径，不写字面量。
 */

/** 用户列表行：PublicUser + 部门名（视图层唯一形状，Mock 与真实通道共用） */
export type UserView = PublicUser & { departmentName: string }

export interface UserListQuery extends PageQuery {
  keyword?: string
  role?: UserRole
  departmentId?: string
  status?: UserStatus
}

export interface UserCreatePayload {
  username: string
  displayName: string
  password?: string
  role: UserRole
  departmentId?: string
}

export interface UserUpdatePayload {
  displayName?: string
  role?: UserRole
  departmentId?: string
  status?: UserStatus
  /** 重置密码 */
  password?: string
}

/** 用户分页列表（四筛选：keyword / role / departmentId / status） */
export async function fetchUsers(query: UserListQuery): Promise<PageResult<UserView>> {
  const { baseURL, url } = endpoint('users')
  const config = {
    baseURL,
    url,
    method: 'get' as const,
    params: isReal({ baseURL }) ? toBackendUserQuery(query) : query,
  }
  const raw = await request<BackendUserPage | PageResult<UserView>>(config)
  return adapt<PageResult<UserView>, BackendUserPage>(config, raw, (page) => ({
    list: (page.items ?? []).map(mapUser),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  }))
}

/** 创建用户（管理端代建，不走邮件激活，可直接登录） */
export async function createUser(payload: UserCreatePayload): Promise<UserView> {
  const { baseURL, url } = endpoint('users')
  const config = { baseURL, url, method: 'post' as const }
  const raw = await request<BackendUserView | UserView>({
    ...config,
    data: isReal({ baseURL }) ? toBackendUserBody(payload) : payload,
  })
  return adapt<UserView, BackendUserView>(config, raw, mapUser)
}

/** 更新用户（资料 / 角色 / 部门 / 状态 / 重置密码） */
export async function updateUser(id: string, payload: UserUpdatePayload): Promise<UserView> {
  const { baseURL, url } = endpoint('users', `/${id}`)
  const config = { baseURL, url, method: 'patch' as const }
  const raw = await request<BackendUserView | UserView>({
    ...config,
    data: isReal({ baseURL }) ? toBackendUserBody(payload) : payload,
  })
  return adapt<UserView, BackendUserView>(config, raw, mapUser)
}

/** 删除用户（软删）：不允许删自己、不允许删内置 admin（后端 400 + 中文提示） */
export function deleteUser(id: string): Promise<{ id: string; message?: string }> {
  const { baseURL, url } = endpoint('users', `/${id}`)
  return request<{ id: string; message?: string }>({ baseURL, url, method: 'delete' })
}
