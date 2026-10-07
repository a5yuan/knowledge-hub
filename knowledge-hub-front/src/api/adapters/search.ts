/**
 * 搜索域字段映射（spec §4.3 权威定义）。
 * 后端 ES 检索仅返回文档级字段：doc_id/title/summary/word_count/publish_time/score；
 * 分类/标签/权限/fileType 均为「不可能」项（spec §4.4），UI 层显式降级隐藏。
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
  highlight?: Record<string, string[]>
}

export function mapSearchItem(raw: BackendSearchItem): SearchResultItem {
  return {
    id: String(raw.doc_id),
    title: raw.title,
    summary: raw.summary ?? '',
    // 后端搜索结果无分类/标签/权限/fileType（spec §4.3 不可能项），渲染端按空值隐藏
    categoryId: '',
    categoryName: '',
    fileType: undefined,
    tags: [],
    visibility: undefined,
    updatedAt: raw.publish_time ? new Date(raw.publish_time).toISOString() : '',
  }
}
