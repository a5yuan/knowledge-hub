import { endpoint, isReal } from './endpoint'
import { request } from './http'
import {
  mapAnnouncement,
  type BackendAnnouncement,
  type BackendAnnouncementPage,
} from './adapters/announcement'
import type { Announcement } from '@/types/api'

/**
 * 公告 API（21 号工单：从「死代码」变为真实链路）。
 *
 * 双通道差异都在本文件收敛，调用方只看到 `Announcement`：
 * - Mock `/api/announcements` 返回**数组**，字段是 camelCase（enabled / createdAt）
 * - 真实 `/real/announcement` 返回**分页对象**，字段是 snake_case（status / created_at）
 *
 * 前端语义统一用 `enabled`（与 Category 一致），真实通道在写请求里翻成 `status`。
 */

/** 列表查询参数（`enabled` 三态：不传 = 全部 / true = 启用且未过期 / false = 停用） */
export interface AnnouncementListQuery {
  enabled?: boolean
  title?: string
  page?: number
  pageSize?: number
}

/** 分页结果（管理页用） */
export interface AnnouncementPage {
  list: Announcement[]
  total: number
  page: number
  pageSize: number
}

/** 写请求体（前端语义：enabled 而非 status） */
export interface AnnouncementPayload {
  title?: string
  content?: string
  enabled?: boolean
  sort?: number
}

/**
 * 列表（数组形态）。
 * 大盘公告卡片只需要前几条，用这个；需要 total 的管理页用 `fetchAnnouncementPage`。
 */
export async function fetchAnnouncements(query: AnnouncementListQuery = {}): Promise<Announcement[]> {
  return (await fetchAnnouncementPage(query)).list
}

/** 列表（分页形态） */
export async function fetchAnnouncementPage(
  query: AnnouncementListQuery = {},
): Promise<AnnouncementPage> {
  const { baseURL, url } = endpoint('announcements')
  const config = { baseURL, url, method: 'get' as const, params: query }
  const raw = await request<unknown>(config)

  if (!isReal(config)) {
    // Mock 不分页：原样返回数组，本地补齐分页外壳（数据量小，行为等价）
    const list = raw as Announcement[]
    return { list, total: list.length, page: 1, pageSize: list.length || 20 }
  }

  const page = raw as BackendAnnouncementPage
  return {
    list: page.items.map(mapAnnouncement),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  }
}

/** 新建公告（需 announcement:manage） */
export async function createAnnouncement(payload: AnnouncementPayload): Promise<Announcement> {
  const { baseURL, url } = endpoint('announcements')
  const body = isReal({ baseURL })
    ? toBackendBody(payload)
    : { title: payload.title, content: payload.content }
  const config = { baseURL, url, method: 'post' as const, data: body }
  const raw = await request<unknown>(config)
  return isReal(config) ? mapAnnouncement(raw as BackendAnnouncement) : (raw as Announcement)
}

/** 更新公告（需 announcement:manage）：只传要改的字段 */
export async function updateAnnouncement(
  id: string,
  payload: AnnouncementPayload,
): Promise<Announcement> {
  const { baseURL, url } = endpoint('announcements', `/${id}`)
  const body = isReal({ baseURL })
    ? toBackendBody(payload)
    : {
        title: payload.title,
        content: payload.content,
        enabled: payload.enabled,
      }
  const config = { baseURL, url, method: 'patch' as const, data: body }
  const raw = await request<unknown>(config)
  return isReal(config) ? mapAnnouncement(raw as BackendAnnouncement) : (raw as Announcement)
}

/** 删除公告（软删，需 announcement:manage） */
export async function deleteAnnouncement(id: string): Promise<void> {
  const { baseURL, url } = endpoint('announcements', `/${id}`)
  await request<unknown>({ baseURL, url, method: 'delete' })
}

/**
 * 前端语义 → 后端字段。
 * `enabled` 是布尔，后端列是 `status`（0/1）—— 这层转换只在这里发生，
 * 视图层永远不碰 `status`。
 */
function toBackendBody(payload: AnnouncementPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.title !== undefined) body.title = payload.title
  if (payload.content !== undefined) body.content = payload.content
  if (payload.enabled !== undefined) body.status = payload.enabled ? 1 : 0
  if (payload.sort !== undefined) body.sort = payload.sort
  return body
}
