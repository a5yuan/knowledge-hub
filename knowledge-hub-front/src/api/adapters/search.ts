/**
 * 搜索域字段映射（spec §4.3 权威定义）。
 * 后端 ES 检索返回文档级字段：doc_id/title/summary/word_count/publish_time/score；
 * 17 号工单起额外返回 category_id 与 tags（标签名数组）。
 *
 * 仍属「不可能」项的是：fileType（ES 未索引文件类型）、visibility（后端不返回权限数据）。
 * categoryName 由视图层用已加载的分类字典解析 —— 不把分类名冗余进 ES 索引。
 */
import type { SearchResultItem } from '@/types/api'

/** 后端搜索结果行（doc-index.service.search 返回的 DocSearchItem） */
export interface BackendSearchItem {
  doc_id: string
  title: string
  summary: string | null
  word_count: number
  publish_time: string | null
  score: number | null
  /** 17 号工单：分类ID（可能为 null） */
  category_id?: string | null
  /** 17 号工单：标签名数组（ES keyword 数组；旧索引可能是逗号串，后端已归一） */
  tags?: string[] | null
  highlight?: Record<string, string[]>
}

export function mapSearchItem(raw: BackendSearchItem): SearchResultItem {
  return {
    id: String(raw.doc_id),
    title: raw.title,
    summary: raw.summary ?? '',
    categoryId: raw.category_id != null ? String(raw.category_id) : '',
    // 名称留空：由 search/Index.vue 用 fetchCategories() 的结果就地解析（同一份字典，避免二次请求）
    categoryName: '',
    fileType: undefined,
    tags: (raw.tags ?? []).map(String).filter(Boolean),
    visibility: undefined,
    updatedAt: raw.publish_time ? new Date(raw.publish_time).toISOString() : '',
  }
}
