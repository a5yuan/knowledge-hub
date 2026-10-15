import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import { mapTag, type BackendTag } from './adapters/doc-meta'
import type { Tag } from '@/types/api'

/**
 * 标签字典 API（17 号工单）。
 * 所有函数一律经 endpoint('tags', ...) 取路径，不写字面量。
 */

/** 标签列表。真实通道支持 { q: 前缀, sort: use_count|tag_name|created_at, limit } */
export async function fetchTags(params?: {
  q?: string
  sort?: 'use_count' | 'tag_name' | 'created_at'
  limit?: number
}): Promise<Tag[]> {
  const { baseURL, url } = endpoint('tags')
  const config = { baseURL, url, method: 'get' as const, params }
  const raw = await request<BackendTag[] | Tag[]>(config)
  return adapt<Tag[], BackendTag[]>(config, raw, (list) => (list ?? []).map(mapTag))
}

/**
 * 按名创建标签（**后端幂等**：已存在原样返回，不报错）。
 * 供新建文档时自由输入标签使用 —— 该路径必须幂等，否则重复输入会中断保存流程。
 */
export async function createTag(name: string): Promise<Tag> {
  const { baseURL, url } = endpoint('tags')
  const config = { baseURL, url, method: 'post' as const }
  const raw = await request<BackendTag | Tag>({
    ...config,
    data: isReal({ baseURL }) ? { tag_name: name } : { name },
  })
  return adapt<Tag, BackendTag>(config, raw, mapTag)
}

/** 重命名标签（重名后端返回 400） */
export async function updateTag(id: string, name: string): Promise<Tag> {
  const { baseURL, url } = endpoint('tags', `/${id}`)
  const config = { baseURL, url, method: 'patch' as const }
  const raw = await request<BackendTag | Tag>({
    ...config,
    data: isReal({ baseURL }) ? { tag_name: name } : { name },
  })
  return adapt<Tag, BackendTag>(config, raw, mapTag)
}

/** 删除标签（软删）：关联行保留，历史文档仍能解析标签名 */
export async function deleteTag(id: string): Promise<{ id: string }> {
  const { baseURL, url } = endpoint('tags', `/${id}`)
  const raw = await request<{ id: string }>({ baseURL, url, method: 'delete' })
  return { id: raw?.id ?? id }
}
