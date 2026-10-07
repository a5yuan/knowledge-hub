/** 与 spec §6 数据模型一一对应；mock 与未来真实后端共用此契约（ADR-0003） */

export type UserRole = 'admin' | 'member'
export type UserStatus = 'active' | 'disabled'
export type Visibility = 'private' | 'department' | 'company'
/** 分区：我的文档 / 公共文档 / 部门文档 / 文档归档 */
export type DocZone = 'mine' | 'public' | 'department' | 'archive'
export type ParseStatus = 'pending' | 'processing' | 'done' | 'failed'
/** 后端文档生命周期阶段（spec §4.2） */
export type DocStatus = 0 | 1 | 2 | 3
/** 文档类型：文件文档 / 在线文档（注意与"文件类型"区分，见 spec §12 术语表） */
export type DocumentType = 'file' | 'online'
export type FileType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'txt'
export type OperationAction = 'upload' | 'update' | 'delete' | 'login' | 'ai-ask'

export interface Department {
  id: string
  name: string
}

export interface User {
  id: string
  username: string
  /** mock 直接存明文占位，真实后端必须哈希 */
  password: string
  displayName: string
  role: UserRole
  departmentId: string
  status: UserStatus
  createdAt: string
}

/** 展示用公共用户视图（不含密码）；roles/avatar 为真实后端追加的可选字段（工单 01，纯追加不破坏 Mock） */
export type PublicUser = Omit<User, 'password'> & {
  /** 后端角色编码列表（如 ['ROLE_ADMIN','ROLE_USER']）；Mock 会话无此字段 */
  roles?: string[]
  avatar?: string | null
}

export interface Category {
  id: string
  key: string
  name: string
  enabled: boolean
  sort: number
}

export interface Tag {
  id: string
  name: string
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  zone: DocZone
  /** mine 分区：归属用户 */
  ownerId: string | null
  /** department 分区：归属部门 */
  departmentId: string | null
}

export interface DocumentItem {
  id: string
  title: string
  type: DocumentType
  /** type=file 时存在 */
  fileType?: FileType
  /** type=online 时存在（TipTap JSON） */
  contentJson?: Record<string, unknown>
  /** 搜索摘要：在线文档自动提取，文件文档取元信息 */
  summary: string
  categoryId: string
  tagIds: string[]
  visibility: Visibility
  zone: DocZone
  folderId: string | null
  ownerId: string
  /** 二期解析管道入口：Mock 恒有值流转（ADR-0004）；真实列表无 parse_state，仅近期上传行经详情合并获得 */
  parseStatus?: ParseStatus
  fileSize?: number
  fileUrl?: string
  /** 原始文件名（真实通道由 source_file_name 归一；下载时用它而非 title，title 已被后端去掉扩展名） */
  fileName?: string
  /** 解析失败原因（ADR-0006：预览页在解析态可见）。成功时后端写空串，故允许空串 */
  parseError?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  /** 后端文档状态（真实通道新增，0 草稿 / 1 已发布 / 2 待审核 / 3 已归档） */
  docStatus?: DocStatus
}

export interface OperationLog {
  id: string
  userId: string
  action: OperationAction
  targetId?: string
  targetTitle?: string
  detail?: string
  createdAt: string
}

export interface Announcement {
  id: string
  title: string
  content: string
  enabled: boolean
  createdAt: string
}

// ---------- 请求/响应通用结构 ----------

export interface PageQuery {
  page?: number
  pageSize?: number
}

export interface PageResult<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

/** 统一响应包络：code=0 成功，非 0 业务错误 */
export interface ApiResponse<T> {
  code: number
  data: T
  message: string
}

// ---------- 接口级 DTO ----------

export interface LoginResult {
  token: string
  user: PublicUser
}

export interface DocumentListQuery extends PageQuery {
  zone?: DocZone
  folderId?: string
  type?: DocumentType
  fileType?: FileType
  categoryId?: string
  tagId?: string
  visibility?: Visibility
  parseStatus?: ParseStatus
  /** 名称/内容摘要/上传人关键词 */
  keyword?: string
  sort?: 'createdAt' | 'updatedAt'
  order?: 'asc' | 'desc'
}

export interface DocumentCreatePayload {
  title: string
  type: DocumentType
  fileType?: FileType
  contentJson?: Record<string, unknown>
  summary?: string
  categoryId: string
  tagIds?: string[]
  visibility: Visibility
  zone: DocZone
  folderId?: string | null
}

export interface DocumentBatchPayload {
  action: 'delete' | 'archive' | 'restore' | 'move'
  ids: string[]
  folderId?: string
}

export interface SearchResultItem {
  id: string
  title: string
  summary: string
  categoryId: string
  categoryName: string
  fileType?: FileType
  tags: string[]
  /** 真实搜索结果不含权限数据（spec §4.3 不可能项），Mock 恒有值 */
  visibility?: Visibility
  updatedAt: string
}

export interface SearchQuery extends PageQuery {
  q: string
  fileType?: FileType
  categoryId?: string
  visibility?: Visibility
  dateFrom?: string
  dateTo?: string
}

export interface DashboardStats {
  totals: {
    docTotal: number
    todayNew: number
    searchCount: number
    activeUsers: number
  }
  trend: {
    range: 'today' | '7d' | '30d'
    points: { label: string; value: number }[]
  }
  categoryRatio: { key: string; name: string; count: number }[]
}

/** 个人中心-我的上传统计（口径与「我的文档」分区一致：本人未归档文档） */
export interface MyStats {
  docCount: number
  totalSize: number
}
