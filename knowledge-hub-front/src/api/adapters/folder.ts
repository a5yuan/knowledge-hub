/**
 * 目录域字段映射（16 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 */
import type { DocFolderZone, Folder } from '@/types/api'

/** 目录分区白名单：archive 是文档状态不是分区，目录表只认这三值 */
export const FOLDER_ZONES: readonly DocFolderZone[] = ['mine', 'public', 'department']

export function isFolderZone(zone: string): zone is DocFolderZone {
  return (FOLDER_ZONES as readonly string[]).includes(zone)
}

/** 后端 kh_folder 列表行（folder.service.findAll 返回的原始实体） */
export interface BackendFolder {
  id: string
  /** → name */
  folder_name: string
  /** → parentId（'0' 是后端根哨兵 → null） */
  parent_id: string
  zone: DocFolderZone
  /** → ownerId */
  owner_id: string | null
  /** → departmentId */
  department_id: string | null
  sort: number
  created_at: string
  updated_at: string
}

/**
 * 后端 → 视图归一。
 *
 * `parent_id: '0' → null` 的转换必须收敛在此处：一旦泄漏到视图层，
 * `buildFolderTree` 会把 '0' 当成真实父节点 ID 去查，查不到就归入根数组 ——
 * 结果是节点静默错位（不报错、不缺失，只是层级不对），极难排查。
 */
export function mapFolder(b: BackendFolder): Folder {
  return {
    id: String(b.id),
    name: b.folder_name,
    parentId: b.parent_id === '0' ? null : String(b.parent_id),
    zone: b.zone,
    ownerId: b.owner_id != null ? String(b.owner_id) : null,
    departmentId: b.department_id != null ? String(b.department_id) : null,
  }
}

/** 视图查询 → 后端 query（parentId → parent_id），仅真实通道使用 */
export function toBackendFolderQuery(params: {
  zone: string
  parentId?: string
}): Record<string, string> {
  const q: Record<string, string> = { zone: params.zone }
  if (params.parentId) q.parent_id = params.parentId
  return q
}

/** 视图创建载荷 → 后端 body（name → folder_name，parentId → parent_id） */
export function toBackendCreateBody(payload: {
  name: string
  zone: string
  parentId?: string | null
}): Record<string, string> {
  const body: Record<string, string> = { folder_name: payload.name, zone: payload.zone }
  if (payload.parentId) body.parent_id = payload.parentId
  return body
}

/** 视图重命名 → 后端 body（name → folder_name） */
export function toBackendRenameBody(name: string): Record<string, string> {
  return { folder_name: name }
}
