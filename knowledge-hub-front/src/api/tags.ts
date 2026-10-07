import { request } from './http'
import type { Tag } from '@/types/api'

export function fetchTags(): Promise<Tag[]> {
  return request<Tag[]>({ url: '/tags', method: 'get' })
}

/** 不存在则创建（幂等），供新建文档时自由添加标签 */
export function createTag(name: string): Promise<Tag> {
  return request<Tag>({ url: '/tags', method: 'post', data: { name } })
}
