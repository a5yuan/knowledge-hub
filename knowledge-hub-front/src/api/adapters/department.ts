/**
 * 部门域字段映射（18 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 */
import type { Department, DepartmentNode } from '@/types/api'

/** 后端 kh_department 行（DepartmentService 返回的原始实体） */
export interface BackendDepartment {
  id: string
  /** → name */
  dept_name: string
  /** → code */
  dept_code: string | null
  /** → parentId（'0' 是后端根哨兵 → null） */
  parent_id: string
  sort: number
  /** → enabled（1 启用 / 0 禁用） */
  status: number
}

/** 后端部门树节点（/department/tree，children 递归同为该形状） */
export interface BackendDepartmentNode extends BackendDepartment {
  children?: BackendDepartmentNode[]
}

/** 后端 → 下拉项（全站只消费 { id, name }） */
export function mapDepartment(b: BackendDepartment): Department {
  return { id: String(b.id), name: b.dept_name }
}

/**
 * 后端树节点 → 视图树节点。
 *
 * `parent_id: '0' → null` 必须在适配层收敛（与 adapters/folder.ts 同一理由）：
 * 哨兵一旦泄漏进视图层，建树 / 判根逻辑会把它当成真实父节点 ID 去查，查不到就静默错位。
 */
export function mapDepartmentNode(b: BackendDepartmentNode): DepartmentNode {
  return {
    id: String(b.id),
    name: b.dept_name,
    code: b.dept_code ?? null,
    parentId: b.parent_id === '0' || b.parent_id == null ? null : String(b.parent_id),
    sort: b.sort,
    enabled: b.status === 1,
    children: (b.children ?? []).map(mapDepartmentNode),
  }
}

/** 视图层 camelCase 载荷 → 后端 snake_case 请求体（仅映射传入的字段） */
export function toBackendDepartmentBody(payload: {
  name?: string
  code?: string | null
  parentId?: string | null
  sort?: number
  enabled?: boolean
}): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.name !== undefined) body.dept_name = payload.name
  if (payload.code !== undefined) body.dept_code = payload.code
  // parentId 为 null / 空 → 不传，由后端落 '0'（根）
  if (payload.parentId) body.parent_id = payload.parentId
  if (payload.sort !== undefined) body.sort = payload.sort
  if (payload.enabled !== undefined) body.status = payload.enabled ? 1 : 0
  return body
}
