import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import {
  mapDepartment,
  mapDepartmentNode,
  toBackendDepartmentBody,
  type BackendDepartment,
  type BackendDepartmentNode,
} from './adapters/department'
import type { Department, DepartmentNode } from '@/types/api'

/**
 * 部门 API（18 号工单）。
 * 双通道：Mock 保持既有 camelCase 契约不动；真实通道经 adapter 转 snake_case。
 * 所有函数一律经 endpoint('departments', ...) 取路径，不写字面量。
 */

/** 部门平铺列表。后端缺省只返回启用部门；{ all: true } 取全部（管理页用） */
export async function fetchDepartments(params?: { all?: boolean }): Promise<Department[]> {
  const { baseURL, url } = endpoint('departments')
  const config = { baseURL, url, method: 'get' as const, params }
  const raw = await request<BackendDepartment[] | Department[]>(config)
  return adapt<Department[], BackendDepartment[]>(config, raw, (list) =>
    (list ?? []).map(mapDepartment),
  )
}

/** 部门树（三层嵌套）。★ 后端 /department/tree 声明在 /department/:id 之前，不会被 :id 吞掉 */
export async function fetchDepartmentTree(params?: { all?: boolean }): Promise<DepartmentNode[]> {
  const { baseURL, url } = endpoint('departments', '/tree')
  const config = { baseURL, url, method: 'get' as const, params }
  const raw = await request<BackendDepartmentNode[] | DepartmentNode[]>(config)
  return adapt<DepartmentNode[], BackendDepartmentNode[]>(config, raw, (list) =>
    (list ?? []).map(mapDepartmentNode),
  )
}

/** 新建部门：parentId 缺省不传，由后端落 '0'（根）；第 4 层后端返回 400 */
export async function createDepartment(payload: {
  name: string
  code?: string
  parentId?: string | null
  sort?: number
}): Promise<Department> {
  const { baseURL, url } = endpoint('departments')
  const config = { baseURL, url, method: 'post' as const }
  const raw = await request<BackendDepartment | Department>({
    ...config,
    data: isReal({ baseURL }) ? toBackendDepartmentBody(payload) : payload,
  })
  return adapt<Department, BackendDepartment>(config, raw, mapDepartment)
}

/** 更新部门（改名 / 改编码 / 改排序 / 改状态）；重名后端返回 409 */
export async function updateDepartment(
  id: string,
  payload: { name?: string; code?: string | null; sort?: number; enabled?: boolean },
): Promise<Department> {
  const { baseURL, url } = endpoint('departments', `/${id}`)
  const config = { baseURL, url, method: 'patch' as const }
  const raw = await request<BackendDepartment | Department>({
    ...config,
    data: isReal({ baseURL }) ? toBackendDepartmentBody(payload) : payload,
  })
  return adapt<Department, BackendDepartment>(config, raw, mapDepartment)
}

/** 删除部门（软删）：有子部门 / 有用户归属时后端返回 400 + 中文提示 */
export async function deleteDepartment(id: string): Promise<{ id: string; message: string }> {
  const { baseURL, url } = endpoint('departments', `/${id}`)
  const raw = await request<{ id: string; message?: string }>({ baseURL, url, method: 'delete' })
  return { id: raw?.id ?? id, message: raw?.message ?? '部门已删除' }
}
