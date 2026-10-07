import type {
  DocumentItem,
  DocZone,
  OperationAction,
  PageQuery,
  PageResult,
  PublicUser,
  SearchResultItem,
  User,
} from '@/types/api'
import {
  buildSeedDocuments,
  daysAgoIso,
  seedAnnouncements,
  seedCategories,
  seedDepartments,
  seedFolders,
  seedHotSearch,
  seedOperations,
  seedTags,
  seedUsers,
} from './seed'
import { buildSeedContents } from './content'

/**
 * 内存数据库：MSW handler 直接读写。
 * 重启页面即重置（location reload 不重置——模块级单例随 HMR 存活，刷新页面重置）。
 */

let seq = 1000
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

export const db = {
  departments: [...seedDepartments],
  users: [...seedUsers],
  categories: [...seedCategories],
  tags: [...seedTags],
  folders: [...seedFolders],
  documents: buildSeedDocuments(),
  operations: [...seedOperations],
  announcements: [...seedAnnouncements],
  hotSearch: [...seedHotSearch],
}

// 种子正文：为终态的 type=file 文档预置 markdown 正文 / 失败原因（等价后端已写好的 document_content）。
// 必须放在 db 声明之后 —— 本模块是它的数据来源，而 content.ts 不反向依赖本模块（循环依赖会让 MSW 拿到 undefined）。
buildSeedContents(db.documents)

// ---------- 用户与身份 ----------

export function toPublicUser(u: User): PublicUser {
  const { password: _password, ...rest } = u
  return rest
}

/**
 * 从 Authorization: Bearer <token> 解析当前用户；无有效 token 返回 null（handler 侧负责 401）。
 * mock token 为自包含格式 mock_<userId>_<ts>，模拟无状态 JWT：内存库随页面刷新重置，
 * 但 token 自包含故会话仍可恢复；签名校验属真实后端职责（spec §5.1 JWT 鉴权）。
 */
export function getViewer(request: Request): User | null {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token.startsWith('mock_')) return null
  const userId = token.slice(5).split('_')[0]
  return db.users.find((u) => u.id === userId) ?? null
}

// ---------- 纯函数：权限与筛选（工单 04 将对其补测试，迁移后端时同源复用） ----------

/** spec §9：无权限文档默认隐藏；admin 全量可见；本人文档始终可见 */
export function canSeeDocument(doc: DocumentItem, viewer: User, users: User[]): boolean {
  if (viewer.role === 'admin') return true
  if (doc.ownerId === viewer.id) return true
  if (doc.visibility === 'company') return true
  if (doc.visibility === 'department') {
    const owner = users.find((u) => u.id === doc.ownerId)
    return owner?.departmentId === viewer.departmentId
  }
  return false
}

export function canManageDocument(doc: DocumentItem, viewer: User): boolean {
  return viewer.role === 'admin' || doc.ownerId === viewer.id
}

/** 分区语义（spec §5.2）：归档独立；我的=本人所有；部门=同部门成员的文档；公共=全公司可见 */
export function inZone(doc: DocumentItem, zone: DocZone, viewer: User, users: User[]): boolean {
  if (zone === 'archive') return doc.archivedAt != null
  if (doc.archivedAt != null) return false
  switch (zone) {
    case 'mine':
      return doc.ownerId === viewer.id
    case 'public':
      return doc.visibility === 'company'
    case 'department': {
      const owner = users.find((u) => u.id === doc.ownerId)
      return owner?.departmentId === viewer.departmentId
    }
    default:
      return false
  }
}

export interface DocumentFilter {
  zone?: DocZone
  folderId?: string
  type?: 'file' | 'online'
  fileType?: DocumentItem['fileType']
  categoryId?: string
  tagId?: string
  visibility?: DocumentItem['visibility']
  parseStatus?: DocumentItem['parseStatus']
  keyword?: string
  sort?: 'createdAt' | 'updatedAt'
  order?: 'asc' | 'desc'
}

/** 列表查询：权限 → 分区 → 字段筛选 → 关键词 → 排序 */
export function filterDocuments(query: DocumentFilter, viewer: User): DocumentItem[] {
  const kw = query.keyword?.trim().toLowerCase()
  const result = db.documents.filter((doc) => {
    if (!canSeeDocument(doc, viewer, db.users)) return false
    if (query.zone && !inZone(doc, query.zone, viewer, db.users)) return false
    if (query.folderId && doc.folderId !== query.folderId) return false
    if (query.type && doc.type !== query.type) return false
    if (query.fileType && doc.fileType !== query.fileType) return false
    if (query.categoryId && doc.categoryId !== query.categoryId) return false
    if (query.tagId && !doc.tagIds.includes(query.tagId)) return false
    if (query.visibility && doc.visibility !== query.visibility) return false
    if (query.parseStatus && doc.parseStatus !== query.parseStatus) return false
    if (kw) {
      const owner = db.users.find((u) => u.id === doc.ownerId)
      const haystack = `${doc.title} ${doc.summary} ${owner?.displayName ?? ''}`.toLowerCase()
      if (!haystack.includes(kw)) return false
    }
    return true
  })
  const sortField = query.sort ?? 'createdAt'
  const dir = query.order === 'asc' ? 1 : -1
  return result.sort((a, b) => dir * a[sortField].localeCompare(b[sortField]))
}

export function paginate<T>(list: T[], query: PageQuery): PageResult<T> {
  const page = Math.max(query.page ?? 1, 1)
  const pageSize = Math.min(Math.max(query.pageSize ?? 10, 1), 100)
  const start = (page - 1) * pageSize
  return { list: list.slice(start, start + pageSize), total: list.length, page, pageSize }
}

export function toSearchResult(doc: DocumentItem): SearchResultItem {
  const category = db.categories.find((c) => c.id === doc.categoryId)
  return {
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    categoryId: doc.categoryId,
    categoryName: category?.name ?? '',
    fileType: doc.fileType,
    tags: doc.tagIds.map((id) => db.tags.find((t) => t.id === id)?.name ?? id),
    visibility: doc.visibility,
    updatedAt: doc.updatedAt,
  }
}

/** 相关度：标题命中 > 标签命中 > 摘要命中 */
export function relevanceScore(doc: DocumentItem, q: string): number {
  const kw = q.toLowerCase()
  if (doc.title.toLowerCase().includes(kw)) return 3
  const tagNames = doc.tagIds.map((id) => db.tags.find((t) => t.id === id)?.name ?? '').join(' ')
  if (tagNames.toLowerCase().includes(kw)) return 2
  if (doc.summary.toLowerCase().includes(kw)) return 1
  return 0
}

// ---------- 写操作辅助 ----------

export function logOperation(entry: {
  userId: string
  action: OperationAction
  targetId?: string
  targetTitle?: string
  detail?: string
}): void {
  db.operations.unshift({ id: nextId('op'), createdAt: new Date().toISOString(), ...entry })
}

export function todayNewCount(): number {
  const today = daysAgoIso(0).slice(0, 10)
  return db.documents.filter((d) => d.createdAt.slice(0, 10) === today).length
}
