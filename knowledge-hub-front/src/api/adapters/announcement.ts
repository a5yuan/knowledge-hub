/**
 * 公告域字段映射（21 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 */
import type { Announcement } from '@/types/api'

/** 后端 kh_announcement 行（announcement.service 返回的原始实体） */
export interface BackendAnnouncement {
  id: string
  title: string
  content: string
  /** → enabled（0 停用 / 1 启用，与 kh_category.status 同约定） */
  status: number
  /** → publishTime（null = 未发布） */
  publish_time: string | null
  /** → expireTime（null = 长期有效） */
  expire_time: string | null
  sort: number
  /** → createdAt */
  created_at: string
  updated_at: string
}

/** 后端 GET /announcement 的分页外壳 */
export interface BackendAnnouncementPage {
  items: BackendAnnouncement[]
  total: number
  page: number
  pageSize: number
}

/**
 * 行 → 视图对象。
 *
 * ⚠️ 时间一律走 `new Date(x).toISOString()`，与其余 adapter 保持一致 ——
 * 全站 `created_at` 的展示存在「早 8 小时」的既有偏差（后端 timestamp 无时区，
 * pg 按本地解析后再 toISOString），本模块**不单独修**：只修一处会让公告时间与
 * 文档/操作日志的时间对不上，反而更困惑。统一修需要单开「时间语义统一」工单。
 */
export function mapAnnouncement(b: BackendAnnouncement): Announcement {
  return {
    id: b.id,
    title: b.title,
    content: b.content,
    enabled: b.status === 1,
    createdAt: new Date(b.created_at).toISOString(),
    publishTime: b.publish_time ? new Date(b.publish_time).toISOString() : undefined,
    expireTime: b.expire_time ? new Date(b.expire_time).toISOString() : undefined,
    sort: b.sort,
  }
}
