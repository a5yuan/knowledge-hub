import { delay, http, HttpResponse } from 'msw'
import type { DocumentBatchPayload, DocumentCreatePayload, DocumentItem } from '@/types/api'
import {
  canManageDocument,
  canSeeDocument,
  db,
  filterDocuments,
  getViewer,
  logOperation,
  nextId,
  paginate,
} from '../db'
import { fail, forbidden, numParam, ok, unauthorized, withLatency } from './utils'
import { zoneOfFolder } from './folders'
import { scheduleParse } from '../parse'
import { getMockContent } from '../content'

const NOT_FOUND = 1300

/** 从 TipTap JSON 提取纯文本摘要（在线文档创建/编辑时调用） */
export function extractSummary(contentJson: Record<string, unknown>, maxLen = 100): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; text?: string; content?: unknown[] }
    if (n.text) out.push(n.text)
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(contentJson)
  const text = out.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

function extToFileType(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  return ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt'].includes(ext) ? ext : 'txt'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export const documentHandlers = [
  http.get('/api/documents', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const url = new URL(request.url)
    const pageResult = paginate(
      filterDocuments(
        {
          zone: (url.searchParams.get('zone') ?? undefined) as DocumentItem['zone'] | undefined,
          folderId: url.searchParams.get('folderId') ?? undefined,
          type: (url.searchParams.get('type') ?? undefined) as DocumentItem['type'] | undefined,
          fileType: (url.searchParams.get('fileType') ?? undefined) as DocumentItem['fileType'] | undefined,
          categoryId: url.searchParams.get('categoryId') ?? undefined,
          tagId: url.searchParams.get('tagId') ?? undefined,
          visibility: (url.searchParams.get('visibility') ?? undefined) as DocumentItem['visibility'] | undefined,
          parseStatus: (url.searchParams.get('parseStatus') ?? undefined) as DocumentItem['parseStatus'] | undefined,
          keyword: url.searchParams.get('keyword') ?? undefined,
          sort: (url.searchParams.get('sort') ?? undefined) as 'createdAt' | 'updatedAt' | undefined,
          order: (url.searchParams.get('order') ?? undefined) as 'asc' | 'desc' | undefined,
        },
        viewer,
      ),
      { page: numParam(url, 'page', 1), pageSize: numParam(url, 'pageSize', 10) },
    )
    // 附带上传人姓名，省去前端二次查询
    const list = pageResult.list.map((d) => enrich(d))
    return ok({ ...pageResult, list })
  }),

  http.post('/api/documents', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const body = (await request.json()) as DocumentCreatePayload
    if (!body.title?.trim()) return fail(1310, '文档标题不能为空')
    if (!body.categoryId) return fail(1311, '请选择文档分类')
    const now = new Date().toISOString()
    const doc: DocumentItem = {
      id: nextId('d'),
      title: body.title.trim(),
      type: 'online',
      contentJson: body.contentJson ?? { type: 'doc', content: [] },
      summary: body.summary?.trim() || extractSummary(body.contentJson ?? {}) || '（暂无内容）',
      categoryId: body.categoryId,
      tagIds: body.tagIds ?? [],
      visibility: body.visibility,
      zone: body.zone,
      folderId: body.folderId ?? null,
      ownerId: viewer.id,
      parseStatus: 'done',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    db.documents.unshift(doc)
    logOperation({ userId: viewer.id, action: 'upload', targetId: doc.id, targetTitle: doc.title, detail: '创建在线文档' })
    return ok(enrich(doc))
  }),

  http.post('/api/documents/upload', async ({ request }) => {
    await withLatency(400)
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const form = await request.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (files.length === 0) return fail(1312, '未接收到文件')
    const metaRaw = form.get('meta')
    const meta = metaRaw ? (JSON.parse(metaRaw as string) as Partial<DocumentCreatePayload>) : {}
    const now = new Date().toISOString()
    const created = files.map((file) => {
      const doc: DocumentItem = {
        id: nextId('d'),
        title: file.name,
        type: 'file',
        fileType: extToFileType(file.name) as DocumentItem['fileType'],
        summary: `${humanSize(file.size)} · 待解析内容摘要将在解析完成后生成`,
        categoryId: meta.categoryId ?? 'cat-product',
        tagIds: meta.tagIds ?? [],
        visibility: meta.visibility ?? 'private',
        zone: meta.zone ?? zoneOfFolder(meta.folderId ?? null),
        folderId: meta.folderId ?? null,
        ownerId: viewer.id,
        parseStatus: 'pending',
        fileSize: file.size,
        fileUrl: `/mock-files/${encodeURIComponent(file.name)}`,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      }
      db.documents.unshift(doc)
      return doc
    })
    // 每个文件独立调度解析流转（pending → processing → done/failed）
    created.forEach((d) => scheduleParse(d.id))
    logOperation({
      userId: viewer.id,
      action: 'upload',
      targetId: created[0]?.id,
      targetTitle: created[0]?.title,
      detail: `批量上传 ${created.length} 个文件`,
    })
    return ok(created.map(enrich))
  }),

  http.get('/api/documents/:id', async ({ request, params }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const doc = db.documents.find((d) => d.id === params.id)
    if (!doc || !canSeeDocument(doc, viewer, db.users)) return fail(NOT_FOUND, '文档不存在或无权访问')
    // 详情是解析状态的唯一读取点（列表不含，等价后端：仅 findOne 带 document_content）：
    // 停在中途的种子文档在这里续跑，否则预览页的轮询只能等到有界超时。
    scheduleParse(doc.id)
    const parsed = getMockContent(doc.id)
    return ok({ ...enrich(doc), content: parsed?.content ?? null, parseError: parsed?.parseError ?? null })
  }),

  http.patch('/api/documents/:id', async ({ request, params }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const doc = db.documents.find((d) => d.id === params.id)
    if (!doc) return fail(NOT_FOUND, '文档不存在')
    if (!canManageDocument(doc, viewer)) return forbidden()
    const body = (await request.json()) as Partial<DocumentCreatePayload> & { contentJson?: Record<string, unknown> }
    if (body.title?.trim()) doc.title = body.title.trim()
    if (body.categoryId) doc.categoryId = body.categoryId
    if (body.tagIds) doc.tagIds = body.tagIds
    if (body.visibility) doc.visibility = body.visibility
    if (body.folderId !== undefined) {
      doc.folderId = body.folderId
      doc.zone = zoneOfFolder(body.folderId)
    }
    if (body.contentJson) {
      doc.contentJson = body.contentJson
      doc.summary = extractSummary(body.contentJson) || doc.summary
    }
    doc.updatedAt = new Date().toISOString()
    logOperation({ userId: viewer.id, action: 'update', targetId: doc.id, targetTitle: doc.title, detail: '更新文档' })
    return ok(enrich(doc))
  }),

  http.delete('/api/documents/:id', async ({ request, params }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const doc = db.documents.find((d) => d.id === params.id)
    if (!doc) return fail(NOT_FOUND, '文档不存在')
    if (!canManageDocument(doc, viewer)) return forbidden()
    db.documents = db.documents.filter((d) => d.id !== doc.id)
    logOperation({ userId: viewer.id, action: 'delete', targetId: doc.id, targetTitle: doc.title, detail: '删除文档' })
    return ok({ id: doc.id })
  }),

  http.post('/api/documents/batch', async ({ request }) => {
    await withLatency(200)
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const body = (await request.json()) as DocumentBatchPayload
    const targets = db.documents.filter((d) => body.ids.includes(d.id))
    const manageable = targets.filter((d) => canManageDocument(d, viewer))
    if (manageable.length === 0) return forbidden()
    const now = new Date().toISOString()
    switch (body.action) {
      case 'delete':
        db.documents = db.documents.filter((d) => !manageable.includes(d))
        break
      case 'archive':
        manageable.forEach((d) => {
          d.archivedAt = now
          d.zone = 'archive'
        })
        break
      case 'restore':
        manageable.forEach((d) => {
          d.archivedAt = null
          d.zone = zoneOfFolder(d.folderId)
        })
        break
      case 'move':
        manageable.forEach((d) => {
          d.folderId = body.folderId ?? d.folderId
          d.zone = zoneOfFolder(d.folderId)
        })
        break
    }
    logOperation({
      userId: viewer.id,
      action: 'update',
      targetId: manageable[0]?.id,
      targetTitle: manageable[0]?.title,
      detail: `批量${body.action} ${manageable.length} 个文档`,
    })
    return ok({ affected: manageable.length })
  }),

  // mock 文件服务：为 fileUrl 提供可下载内容（工单 05 下载动作 / 工单 07 pdf 内嵌预览）
  http.get('/mock-files/:name', async ({ params }) => {
    await delay(150)
    const name = decodeURIComponent(params.name as string)
    // pdf 返回极简合法 PDF（inline），支撑浏览器原生内嵌预览；其余格式为文本占位（attachment 下载）
    if (name.toLowerCase().endsWith('.pdf')) {
      return new HttpResponse(buildMockPdf(), {
        headers: { 'Content-Type': 'application/pdf' },
      })
    }
    return new HttpResponse(`【mock 文件】${name}\n这是知识库 mock 文件服务生成的占位内容。`, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    })
  }),
]

/**
 * 极简合法 PDF（单页 Helvetica 英文占位，运行时计算 xref 偏移）。
 * 内容仅 ASCII——中文需嵌入字体，超出 mock 需求；验收点是浏览器内嵌渲染本身。
 */
function buildMockPdf(): string {
  const stream =
    'BT /F1 20 Tf 72 760 Td (Mock PDF Preview) Tj 0 -36 Td (Generated by knowledge-hub mock file service.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => {
    const offset = body.length
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
    return offset
  })
  const xrefOffset = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return body
}

type WithOwner = DocumentItem & { ownerName: string }

function enrich(doc: DocumentItem): WithOwner {
  return { ...doc, ownerName: db.users.find((u) => u.id === doc.ownerId)?.displayName ?? '未知' }
}
