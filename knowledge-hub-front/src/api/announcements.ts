import { request } from './http'
import type { Announcement } from '@/types/api'

export function fetchAnnouncements(params?: { enabled?: boolean }): Promise<Announcement[]> {
  return request<Announcement[]>({ url: '/announcements', method: 'get', params })
}

export function createAnnouncement(payload: { title: string; content: string }): Promise<Announcement> {
  return request<Announcement>({ url: '/announcements', method: 'post', data: payload })
}

export function updateAnnouncement(
  id: string,
  payload: Partial<Pick<Announcement, 'title' | 'content' | 'enabled'>>,
): Promise<Announcement> {
  return request<Announcement>({ url: `/announcements/${id}`, method: 'patch', data: payload })
}
