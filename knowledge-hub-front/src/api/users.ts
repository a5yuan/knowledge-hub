import { request } from './http'
import type { PageQuery, PageResult, PublicUser, UserRole, UserStatus } from '@/types/api'

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
  departmentId: string
}

export interface UserUpdatePayload {
  displayName?: string
  role?: UserRole
  departmentId?: string
  status?: UserStatus
  /** 重置密码 */
  password?: string
}

export function fetchUsers(query: UserListQuery): Promise<PageResult<UserView>> {
  return request<PageResult<UserView>>({ url: '/users', method: 'get', params: query })
}

export function createUser(payload: UserCreatePayload): Promise<PublicUser> {
  return request<PublicUser>({ url: '/users', method: 'post', data: payload })
}

export function updateUser(id: string, payload: UserUpdatePayload): Promise<PublicUser> {
  return request<PublicUser>({ url: `/users/${id}`, method: 'patch', data: payload })
}

export function deleteUser(id: string): Promise<{ id: string }> {
  return request<{ id: string }>({ url: `/users/${id}`, method: 'delete' })
}
