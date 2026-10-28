/**
 * 图谱检索结果适配（`GET /kg/search`）。
 *
 * 硬约束（AGENTS.md 红线 4）：后端 snake_case **只允许出现在 adapters/**。
 * 本文件是 `docs.items` 这一处的唯一转换边界 ——
 * 其余字段（entities / edges / docEdges / nodes）后端本来就是 camelCase，不必过这里。
 */
import type { GraphDocHit } from '../graph'

/** 后端 docs.items 原始形状（ES 文档级字段，snake_case） */
interface RawDocHit {
  doc_id?: string
  title?: string
}

/**
 * 文档命中：只保留画布需要的 docId / title。
 *
 * 其余字段（summary / score / publish_time / highlight…）画布不用，
 * 显式丢弃而不是透传 —— 否则它们会以 snake_case 顺着返回值漂到视图层。
 */
export function adaptDocHits(raw: unknown): GraphDocHit[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r) => r as RawDocHit)
    .filter((r) => typeof r?.doc_id === 'string' && r.doc_id.length > 0)
    .map((r) => ({ docId: r.doc_id as string, title: r.title ?? '' }))
}
