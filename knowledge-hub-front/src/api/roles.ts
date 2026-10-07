import { request } from './http'
import { endpoint } from './endpoint'

/** 角色视图（/role/list 与角色 CRUD 返回，见后端 RoleService.RoleView） */
export interface RoleView {
  id: string
  roleName: string
  roleCode: string
  description: string | null
  status: 0 | 1
}

/** 权限树节点（/role/permission-tree，不含 type=3 接口权限） */
export interface PermissionTreeNode {
  id: string
  permissionName: string
  permissionCode: string
  permissionType: number
  children: PermissionTreeNode[]
}

export interface RoleListResult {
  total: number
  list: RoleView[]
}

export interface RoleCreatePayload {
  roleName: string
  description?: string
}

export interface RoleUpdatePayload {
  roleName?: string
  description?: string
  status?: 0 | 1
}

/** 角色分页列表 */
export function fetchRoles(page: number, pageSize: number): Promise<RoleListResult> {
  const { baseURL, url } = endpoint('roles', '/list')
  return request<RoleListResult>({ baseURL, url, method: 'get', params: { page, pageSize } })
}

/** 新建角色（role_code 后端自动生成） */
export function createRole(payload: RoleCreatePayload): Promise<RoleView> {
  const { baseURL, url } = endpoint('roles', '')
  return request<RoleView>({ baseURL, url, method: 'post', data: payload })
}

/** 编辑角色（名称/描述/状态开关） */
export function updateRole(id: string, payload: RoleUpdatePayload): Promise<RoleView> {
  const { baseURL, url } = endpoint('roles', `/${id}`)
  return request<RoleView>({ baseURL, url, method: 'patch', data: payload })
}

/** 删除角色（内置角色后端 400） */
export function deleteRole(id: string): Promise<{ id: string }> {
  const { baseURL, url } = endpoint('roles', `/${id}`)
  return request<{ id: string }>({ baseURL, url, method: 'delete' })
}

/** 全量权限树（权限树弹窗数据源） */
export function fetchPermissionTree(): Promise<PermissionTreeNode[]> {
  const { baseURL, url } = endpoint('roles', '/permission-tree')
  return request<PermissionTreeNode[]>({ baseURL, url, method: 'get' })
}

/** 角色已授权限ID列表（弹窗回显） */
export function fetchRolePermissionIds(id: string): Promise<string[]> {
  const { baseURL, url } = endpoint('roles', `/${id}/permissions`)
  return request<string[]>({ baseURL, url, method: 'get' })
}

/** 保存角色权限（全量覆盖，勾选 ∪ 半选提交） */
export function assignRolePermissions(id: string, permissionIds: string[]): Promise<{ roleId: string; count: number }> {
  const { baseURL, url } = endpoint('roles', `/${id}/permissions`)
  return request<{ roleId: string; count: number }>({ baseURL, url, method: 'put', data: { permissionIds } })
}
