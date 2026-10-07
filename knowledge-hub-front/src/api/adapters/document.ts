/**
 * 文档域字段映射（spec §4.2 权威定义）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 *
 * 已知有损映射（spec §4.4）：visibility=department 读侧永不产生；列表无 parse_state /
 * fileUrl / fileType / fileSize / ownerName（真实列表不可能项）。
 */
import type { DocStatus, DocumentItem, DocumentListQuery, FileType, ParseStatus } from '@/types/api'

/** 后端 kh_document 列表行（document.service.findAll 返回的原始实体） */
export interface BackendDocument {
  id: string
  title: string
  summary: string | null
  category_id: string | null
  team_id: string | null
  author_id: string | null
  create_by: string | null
  tags: string | null
  status: number
  is_public: boolean
  created_at: string
  updated_at: string
  [key: string]: unknown
}

/** 后端文档详情：额外带 Mongo 正文与解析状态（findOne） */
export interface BackendDocumentDetail extends BackendDocument {
  content: string | null
  parse_state: 'pending' | 'running' | 'success' | 'failed' | null
  parse_error: string | null
  source_file_name: string | null
  source_file_url: string | null
}

/** 后端审核待办行（pendingReviews getRawMany，含软删文档 title=null 的已知缺陷） */
export interface BackendPendingReview {
  id: string
  document_id: string
  title: string | null
  doc_status: number | string
  before_status: number | string
  created_at: string
}

/** 后端审核历史行（KhDocumentReview 实体） */
export interface BackendReviewRecord {
  id: string
  document_id: string
  reviewer_id: string | null
  reviewer_name: string | null
  review_result: number | null
  review_comment: string | null
  before_status: number
  reviewed_at: string | null
  created_at: string
}

/** tags 存储：CSV / JSON 数组两种格式，统一还原为 string[] */
function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // 非 JSON，按 CSV 处理
  }
  return raw.split(',').map((t) => t.trim()).filter(Boolean)
}

/** parse_state → 前端 ParseStatus（running→processing、success→done，其余同名） */
function mapParseState(state: BackendDocumentDetail['parse_state']): ParseStatus | undefined {
  if (!state) return undefined
  if (state === 'running') return 'processing'
  if (state === 'success') return 'done'
  return state
}

/** source_file_name 扩展名 → FileType（未知扩展 / 无扩展名返回 undefined） */
export function fileTypeFromName(name: string | null | undefined): FileType | undefined {
  const ext = name?.trim().split('.').pop()?.toLowerCase()
  return ext && ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt'].includes(ext) ? (ext as FileType) : undefined
}

export function mapDocument(raw: BackendDocument): DocumentItem {
  return {
    id: String(raw.id),
    title: raw.title,
    summary: raw.summary ?? '',
    categoryId: raw.category_id != null ? String(raw.category_id) : '',
    tagIds: parseTags(raw.tags),
    visibility: raw.is_public ? 'company' : 'private',
    // 有损（spec §4.4）：后端无部门维度，读侧永不产生 department
    zone: 'mine',
    folderId: null,
    ownerId: String(raw.author_id ?? raw.create_by ?? ''),
    // 真实列表无 parse_state：留空（undefined），仅近期上传行经 mergeDetail 合并，避免「永不停止的轮询」
    parseStatus: undefined,
    type: 'file',
    createdAt: new Date(raw.created_at).toISOString(),
    updatedAt: new Date(raw.updated_at).toISOString(),
    archivedAt: raw.status === 3 ? new Date(raw.updated_at).toISOString() : null,
    docStatus: raw.status as DocStatus,
  }
}

/**
 * 详情字段合并：列表行 + GET /document/:id 详情（parse_state / 文件信息），轮询与预览复用。
 * 各字段都回落到 `doc` 已有值：同一行会被重复 merge（上传当次的本地推导 → 首次详情 → 轮询），
 * 后端字段缺失时不应把已知信息抹成 undefined。
 */
export function mergeDetail(doc: DocumentItem, detail: BackendDocumentDetail): DocumentItem {
  return {
    ...doc,
    parseStatus: mapParseState(detail.parse_state) ?? doc.parseStatus,
    parseError: detail.parse_error ?? doc.parseError,
    fileUrl: toStorageRelative(detail.source_file_url) ?? doc.fileUrl,
    fileType: fileTypeFromName(detail.source_file_name) ?? doc.fileType,
    fileName: detail.source_file_name ?? doc.fileName,
  }
}

/**
 * source_file_url 由后端 publicUrl 生成绝对地址（http://127.0.0.1:9000/<bucket>/<key>），
 * 归一为 /storage 相对路径经 Vite/nginx 代理取流（spec §6：source_file_url 经 /storage 取到 blob）。
 * 上传路径也要用（后端 upload 同样返回绝对地址），故导出。
 */
export function toStorageRelative(url: string | null): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return `/storage${u.pathname}${u.search}`
  } catch {
    return url // 已是相对路径
  }
}

/** 详情响应整体映射（fetchDocument / Reviews 预览用） */
export function mapDocumentDetail(raw: BackendDocumentDetail): DocumentItem {
  return mergeDetail(mapDocument(raw), raw)
}

/** 列表行 + ownerName（后端无任何接口返回作者名，spec §4.2 不可能项，恒空串） */
export function mapDocumentWithOwner(raw: BackendDocument): DocumentItem & { ownerName: string } {
  return { ...mapDocument(raw), ownerName: '' }
}

/** 前端审核待办行（视图层 camelCase 视图） */
export interface PendingReview {
  id: string
  documentId: string
  /** 软删文档 title=null（后端 LEFT JOIN 已知缺陷）：视图隐藏该行并扣减计数 */
  title: string | null
  docStatus: DocStatus
  beforeStatus: DocStatus
  createdAt: string
}

export function mapPendingReview(raw: BackendPendingReview): PendingReview {
  return {
    id: String(raw.id),
    documentId: String(raw.document_id),
    title: raw.title,
    docStatus: Number(raw.doc_status) as DocStatus,
    beforeStatus: Number(raw.before_status) as DocStatus,
    createdAt: new Date(raw.created_at).toISOString(),
  }
}

/** 前端审核历史行 */
export interface ReviewRecord {
  id: string
  reviewerName: string | null
  /** NULL=待审 1=通过 2=驳回 */
  reviewResult: number | null
  reviewComment: string | null
  reviewedAt: string | null
  createdAt: string
}

export function mapReviewRecord(raw: BackendReviewRecord): ReviewRecord {
  return {
    id: String(raw.id),
    reviewerName: raw.reviewer_name,
    reviewResult: raw.review_result,
    reviewComment: raw.review_comment,
    reviewedAt: raw.reviewed_at ? new Date(raw.reviewed_at).toISOString() : null,
    createdAt: new Date(raw.created_at).toISOString(),
  }
}

/**
 * zone → 后端 query 翻译（spec §4.2）：zone 是请求概念（看哪个桶），docStatus 是响应概念，二者不互推。
 * mine → author_id=<me>；public → is_public=true；archive → status=3；department 无对应（工单 05 UI 隐藏）。
 * 禁止发送 is_public=false（后端 DTO 历史缺陷）。keyword 翻译为 title 模糊匹配；排序后端固定 created_at DESC。
 */
export function toBackendListQuery(
  query: DocumentListQuery,
  me: string,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 10,
  }
  switch (query.zone) {
    case 'mine':
      params.author_id = me
      break
    case 'public':
      params.is_public = 'true'
      break
    case 'archive':
      params.status = 3
      break
    default:
      break
  }
  const kw = query.keyword?.trim()
  if (kw) params.title = kw
  return params
}

// ---------- 近期上传 id 集合（解析状态轮询的保真方案，spec 工单 03） ----------
// 列表不含 parse_state：仅对本集合内的 id 并发拉详情合并状态；完成/失败即出集合，零待解析时零额外请求。

const recentUploadIds = new Set<string>()

export function trackUploaded(id: string): void {
  recentUploadIds.add(String(id))
}

export function takePendingUploadIds(pageIds: string[]): string[] {
  return pageIds.filter((id) => recentUploadIds.has(id))
}

/** 解析终态（done/failed）后停止跟踪 */
export function untrackUploaded(id: string): void {
  recentUploadIds.delete(id)
}
