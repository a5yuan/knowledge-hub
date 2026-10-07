import type { DocStatus, ParseStatus } from '@/types/api'

/**
 * 文档视图共用的状态展示口径（列表 / 预览 / 审核工作台）。
 * 此前 `DOC_STATUS_META` 在 Index.vue 与 Reviews.vue 各存一份、解析状态文案在两处硬编码，
 * 同一状态三处文案可以对不上；收口到这里，图标等视图私有物仍留在各自页面。
 */

/** el-tag 的 type 取值（项目用到的四种） */
type TagType = 'success' | 'warning' | 'danger' | 'info'

export const PARSE_STATUS_META: Record<ParseStatus, { label: string; tag: TagType }> = {
  done: { label: '解析完成', tag: 'success' },
  processing: { label: '解析中', tag: 'warning' },
  failed: { label: '解析失败', tag: 'danger' },
  pending: { label: '待解析', tag: 'info' },
}

/** 后端文档生命周期（spec 工单 03）：0 草稿 / 1 已发布 / 2 待审核 / 3 已归档 */
export const DOC_STATUS_META: Record<DocStatus, { label: string; tag: TagType }> = {
  0: { label: '草稿', tag: 'info' },
  1: { label: '已发布', tag: 'success' },
  2: { label: '待审核', tag: 'warning' },
  3: { label: '已归档', tag: 'danger' },
}
