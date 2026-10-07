import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import { ApiError } from './normalize'
import {
  fileTypeFromName,
  mapDocumentDetail,
  mapDocumentWithOwner,
  mapPendingReview,
  mapReviewRecord,
  mergeDetail,
  takePendingUploadIds,
  toStorageRelative,
  trackUploaded,
  untrackUploaded,
  toBackendListQuery,
  type BackendDocumentDetail,
  type BackendPendingReview,
  type BackendReviewRecord,
  type PendingReview,
  type ReviewRecord,
} from './adapters/document'
import type {
  DocumentBatchPayload,
  DocumentCreatePayload,
  DocumentItem,
  DocumentListQuery,
  PageResult,
} from '@/types/api'

export type DocumentWithOwner = DocumentItem & { ownerName: string }

/** 详情视图：真实通道额外携带 Mongo markdown 正文（Editor 只读预览 / 审核工作台） */
export type DocumentDetail = DocumentWithOwner & { content?: string | null }

export interface DocumentPage extends PageResult<DocumentWithOwner> {
  /** mine/public 分区被前端过滤掉的已归档行数（后端无法表达「非归档」，已知偏差，spec 工单 03 备注） */
  removedArchived?: number
}

export interface UploadResult {
  items: DocumentWithOwner[]
  failed: { name: string; message: string }[]
}

/**
 * 分页查询。真实通道：zone 翻译为后端 query（spec §4.2）、items→list 归一、
 * 对近期上传 id 并发拉详情合并解析状态（工单 03 保真方案，无待解析时零额外请求）。
 */
export async function fetchDocuments(
  query: DocumentListQuery,
  me: string,
): Promise<DocumentPage> {
  const { baseURL, url } = endpoint('documents')
  const config = { baseURL, url, method: 'get' as const, params: isReal({ baseURL }) ? toBackendListQuery(query, me) : query }
  const raw = await request<unknown>(config)
  if (!isReal(config)) {
    return raw as PageResult<DocumentWithOwner>
  }

  const page = raw as { items: Record<string, unknown>[]; total: number; page: number; pageSize: number }
  const items = page.items.map((r) => mapDocumentWithOwner(r as never))
  // 已知偏差规避：后端无法表达「非归档」，mine/public 混入已归档行，前端过滤并记录条数
  const visible = query.zone === 'mine' || query.zone === 'public' ? items.filter((d) => d.docStatus !== 3) : items
  const removedArchived = items.length - visible.length

  // 解析状态保真：仅对近期上传的 id 拉详情合并；解析终态后移出跟踪集合
  const tracked = takePendingUploadIds(visible.map((d) => d.id))
  if (tracked.length > 0) {
    const details = await Promise.allSettled(tracked.map((id) => fetchDocumentDetailRaw(id)))
    details.forEach((r) => {
      if (r.status !== 'fulfilled') return
      const detail = r.value
      const target = visible.find((d) => d.id === String(detail.id))
      if (target) Object.assign(target, mergeDetail(target, detail))
      if (detail.parse_state === 'success' || detail.parse_state === 'failed') {
        untrackUploaded(String(detail.id))
      }
    })
  }

  return { list: visible, total: page.total, page: page.page, pageSize: page.pageSize, removedArchived }
}

async function fetchDocumentDetailRaw(id: string): Promise<BackendDocumentDetail> {
  const { baseURL, url } = endpoint('documents', `/${id}`)
  return request<BackendDocumentDetail>({ baseURL, url, method: 'get' })
}

/** 创建在线文档：后端无正文写入接口（contentJson 会被 ValidationPipe 静默剥离），真实模式明确拒绝 */
export function createDocument(payload: DocumentCreatePayload): Promise<DocumentWithOwner> {
  const { baseURL, url } = endpoint('documents')
  if (isReal({ baseURL })) {
    return Promise.reject(new ApiError(-1, '后端暂不支持创建在线文档（无正文写入接口）'))
  }
  return request<DocumentWithOwner>({ baseURL, url, method: 'post', data: payload })
}

/**
 * 批量上传文件。真实通道：N 次单文件 POST（字段 file，附 authorId/createBy）→
 * 补偿 PATCH 补分类/标签/可见性；单文件失败不阻断其余，单独呈现失败项（工单 03 写路径）。
 */
export async function uploadDocuments(
  files: File[],
  meta: Partial<Pick<DocumentCreatePayload, 'categoryId' | 'tagIds' | 'visibility' | 'zone' | 'folderId'>>,
  me: string,
): Promise<UploadResult> {
  const { baseURL, url } = endpoint('documents', '/upload')
  if (!isReal({ baseURL })) {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    form.append('meta', JSON.stringify(meta))
    const items = await request<DocumentWithOwner[]>({ baseURL, url, method: 'post', data: form, timeout: 60000 })
    return { items, failed: [] }
  }

  const snowflake = /^\d+$/.test(me)
  const results = await Promise.allSettled(
    files.map(async (file) => {
      const form = new FormData()
      form.append('file', file)
      if (snowflake) {
        form.append('authorId', me)
        form.append('createBy', me)
      }
      const raw = await request<{ id: string; source_file_url: string | null }>({
        baseURL,
        url,
        method: 'post',
        data: form,
        timeout: 60000,
      })
      trackUploaded(raw.id)
      const doc = uploadedToDocument(raw.id, file, meta, me, raw.source_file_url)
      // 补偿请求：后端 upload 不接收分类/标签/可见性（spec §7 术语表）。
      // category_id 仅在后端为 bigint 列：Mock 分类 id（cat-*）不可表达，静默跳过属有损降级（spec §5.2 建议 10）
      const patch: Record<string, unknown> = {}
      if (meta.categoryId && /^\d+$/.test(meta.categoryId)) patch.category_id = meta.categoryId
      if (meta.tagIds?.length) patch.tags = meta.tagIds.join(',')
      if (meta.visibility && meta.visibility !== 'department') patch.is_public = meta.visibility === 'company'
      if (Object.keys(patch).length > 0) {
        const ep = endpoint('documents', `/${raw.id}`)
        await request({ baseURL: ep.baseURL, url: ep.url, method: 'patch', data: patch }).catch(() => {
          // 补偿失败不吞掉：文档已入库（进入 items），同时以失败项呈现元信息缺失
          throw new Error('文件已上传，但分类/标签/可见性补写失败')
        })
      }
      return doc
    }),
  )
  const items: DocumentWithOwner[] = []
  const failed: { name: string; message: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(r.value)
    else failed.push({ name: files[i].name, message: r.reason instanceof Error ? r.reason.message : '上传失败' })
  })
  return { items, failed }
}

/**
 * 上传响应（仅 id / parse_state / source_file_url）→ DocumentWithOwner 最小构造。
 * 文件信息从本地 File 推导：后端 upload 响应不含 source_file_name 与 file_size，
 * 不推导则上传当次的行没有类型徽标与大小，要等一次详情往返（spec §5.2 字段类缺口的前端规避）。
 */
function uploadedToDocument(
  id: string,
  file: File,
  meta: Partial<Pick<DocumentCreatePayload, 'categoryId' | 'tagIds' | 'visibility'>>,
  me: string,
  fileUrl: string | null,
): DocumentWithOwner {
  const now = new Date().toISOString()
  return {
    id: String(id),
    title: file.name,
    summary: '',
    categoryId: meta.categoryId ?? '',
    tagIds: meta.tagIds ?? [],
    visibility: meta.visibility === 'company' ? 'company' : 'private',
    zone: 'mine',
    folderId: null,
    ownerId: me,
    parseStatus: 'pending',
    type: 'file',
    // 后端 upload 返回的是 RustFS 绝对地址，详情路径返回的是 /storage 相对路径，归一保持二者一致
    fileUrl: toStorageRelative(fileUrl),
    fileType: fileTypeFromName(file.name),
    fileName: file.name,
    fileSize: file.size,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    docStatus: 0,
    ownerName: '',
  }
}

/** 文档详情：真实通道含 Mongo 正文与解析状态（source_file_name/url 等），Mock 原样 */
export async function fetchDocument(id: string): Promise<DocumentDetail> {
  const { baseURL, url } = endpoint('documents', `/${id}`)
  const config = { baseURL, url, method: 'get' as const }
  const raw = await request<BackendDocumentDetail>(config)
  return adapt<DocumentDetail, BackendDocumentDetail>(config, raw, (r) => ({
    ...mapDocumentDetail(r),
    ownerName: '',
    content: r.content ?? undefined,
  }))
}

/**
 * 更新文档。真实通道映射 snake_case：title / category_id / tags(CSV) / is_public
 * （visibility=department 写侧降级为 private，spec §4.4）。正文体真实模式由 Editor 降级保证不发送。
 */
export async function updateDocument(
  id: string,
  payload: Partial<DocumentCreatePayload>,
): Promise<DocumentWithOwner> {
  const { baseURL, url } = endpoint('documents', `/${id}`)
  if (isReal({ baseURL })) {
    const body: Record<string, unknown> = {}
    if (payload.title !== undefined) body.title = payload.title
    // category_id 后端为 bigint 列：Mock 分类 id（cat-*）不可表达，仅透传雪花字符串
    if (payload.categoryId !== undefined && /^\d+$/.test(payload.categoryId)) body.category_id = payload.categoryId
    if (payload.tagIds !== undefined) body.tags = payload.tagIds.join(',')
    if (payload.visibility !== undefined && payload.visibility !== 'department') {
      body.is_public = payload.visibility === 'company'
    }
    const raw = await request<BackendDocumentDetail>({ baseURL, url, method: 'patch', data: body })
    return { ...mapDocumentDetail(raw), ownerName: '' }
  }
  return request<DocumentWithOwner>({ baseURL, url, method: 'patch', data: payload })
}

/** 删除：真实通道 DELETE 返回 { success: true }，归一为 { id } 保持既有调用点不变 */
export async function deleteDocument(id: string): Promise<{ id: string }> {
  const { baseURL, url } = endpoint('documents', `/${id}`)
  if (isReal({ baseURL })) {
    await request<{ success: boolean }>({ baseURL, url, method: 'delete' })
    return { id }
  }
  return request<{ id: string }>({ baseURL, url, method: 'delete' })
}

/**
 * 批量操作。真实通道无 POST /documents/batch：删除前端扇出 N 次 DELETE；
 * 批量归档/恢复明确报错（无接口且归档是终态，视图层已禁用）。
 */
export async function batchDocuments(payload: DocumentBatchPayload): Promise<{ affected: number }> {
  const { baseURL, url } = endpoint('documents')
  if (isReal({ baseURL })) {
    if (payload.action !== 'delete') {
      return Promise.reject(new ApiError(-1, '真实模式不支持批量归档/恢复（后端无对应接口，且归档为终态）'))
    }
    const results = await Promise.allSettled(payload.ids.map((id) => deleteDocument(id)))
    return { affected: results.filter((r) => r.status === 'fulfilled').length }
  }
  return request<{ affected: number }>({ baseURL, url, method: 'post', data: payload })
}

// ---------- 审核工作台（本工单核心新增；后端能力，无 Mock 演示数据） ----------

/** 提交审核：REVIEW_ENABLED=true 提审（status=2）；false 直接发布（status=1），由后端配置决定 */
export async function publishDocument(id: string): Promise<void> {
  const { baseURL, url } = endpoint('documents', `/${id}/publish`)
  await request<unknown>({ baseURL, url, method: 'post' })
}

/** 下架编辑（仅已发布）：status 回草稿 */
export async function saveDraftDocument(id: string): Promise<void> {
  const { baseURL, url } = endpoint('documents', `/${id}/save-draft`)
  await request<unknown>({ baseURL, url, method: 'post' })
}

/** 归档（仅已发布）：status=3 终态，后端无恢复接口 */
export async function archiveDocument(id: string): Promise<void> {
  const { baseURL, url } = endpoint('documents', `/${id}/archive`)
  await request<unknown>({ baseURL, url, method: 'post' })
}

/** 待审列表：裸数组无分页（软删文档 title=null 行由视图隐藏并扣减计数） */
export async function fetchPendingReviews(): Promise<PendingReview[]> {
  const { baseURL, url } = endpoint('documents', '/reviews/pending')
  const raw = await request<BackendPendingReview[]>({ baseURL, url, method: 'get' })
  return raw.map(mapPendingReview)
}

/** 待审数量（角标轮询用）：{ count } → number */
export async function fetchPendingReviewCount(): Promise<number> {
  const { baseURL, url } = endpoint('documents', '/reviews/pending/count')
  const raw = await request<{ count: number }>({ baseURL, url, method: 'get' })
  return raw.count
}

/** 审核通过（comment 可选） */
export async function approveDocument(id: string, comment?: string): Promise<void> {
  const { baseURL, url } = endpoint('documents', `/${id}/approve`)
  await request<unknown>({ baseURL, url, method: 'post', data: { comment } })
}

/** 驳回（comment 后端强制必填，视图层先做非空校验） */
export async function rejectDocument(id: string, comment: string): Promise<void> {
  const { baseURL, url } = endpoint('documents', `/${id}/reject`)
  await request<unknown>({ baseURL, url, method: 'post', data: { comment } })
}

export async function fetchReviewHistory(documentId: string): Promise<ReviewRecord[]> {
  const { baseURL, url } = endpoint('documents', `/${documentId}/reviews`)
  const raw = await request<BackendReviewRecord[]>({ baseURL, url, method: 'get' })
  return raw.map(mapReviewRecord)
}
