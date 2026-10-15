/**
 * 分类与标签域字段映射（17 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 */
import type { Category, Tag } from '@/types/api'

/** 后端 kh_category 行（categories.service 返回的原始实体） */
export interface BackendCategory {
  id: string
  category_name: string
  category_code: string | null
  sort: number
  status: number
}

/**
 * category_name → name、category_code → key、status → enabled。
 * category_code 可空（后端允许），回落空串：它只作 slug 用途，不参与渲染。
 */
export function mapCategory(raw: BackendCategory): Category {
  return {
    id: String(raw.id),
    key: raw.category_code ?? '',
    name: raw.category_name,
    enabled: raw.status === 1,
    sort: raw.sort,
  }
}

/** 后端 kh_tag 行（tags.service 返回的原始实体） */
export interface BackendTag {
  id: string
  tag_name: string
  use_count?: number
  status?: number
}

/** tag_name → name（use_count 仅供管理端排序，前端 Tag 类型不消费） */
export function mapTag(raw: BackendTag): Tag {
  return { id: String(raw.id), name: raw.tag_name }
}

/** 视图层 camelCase 分类载荷 → 后端 snake_case 请求体（仅映射传入的字段） */
export function toBackendCategoryBody(payload: {
  key?: string
  name?: string
  sort?: number
  enabled?: boolean
}): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.name !== undefined) body.category_name = payload.name
  if (payload.key !== undefined) body.category_code = payload.key
  if (payload.sort !== undefined) body.sort = payload.sort
  if (payload.enabled !== undefined) body.status = payload.enabled ? 1 : 0
  return body
}
