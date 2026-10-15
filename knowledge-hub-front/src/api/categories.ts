import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import { mapCategory, toBackendCategoryBody, type BackendCategory } from './adapters/doc-meta'
import type { Category } from '@/types/api'

/**
 * 分类字典 API（17 号工单）。
 * 双通道：Mock 保持既有 camelCase 契约不动；真实通道经 adapter 转 snake_case。
 * 所有函数一律经 endpoint('categories', ...) 取路径，不写字面量。
 */

/** 分类列表。后端默认只返回启用分类；{ all: true } 取全部（后台管理用） */
export async function fetchCategories(params?: { all?: boolean }): Promise<Category[]> {
  const { baseURL, url } = endpoint('categories')
  const config = { baseURL, url, method: 'get' as const, params }
  const raw = await request<BackendCategory[] | Category[]>(config)
  return adapt<Category[], BackendCategory[]>(config, raw, (list) => (list ?? []).map(mapCategory))
}

/** 新建分类（载荷为视图层 camelCase：key → category_code、name → category_name） */
export async function createCategory(payload: {
  key: string
  name: string
  sort?: number
}): Promise<Category> {
  const { baseURL, url } = endpoint('categories')
  const config = { baseURL, url, method: 'post' as const }
  const raw = await request<BackendCategory | Category>({
    ...config,
    data: isReal({ baseURL }) ? toBackendCategoryBody(payload) : payload,
  })
  return adapt<Category, BackendCategory>(config, raw, mapCategory)
}

/** 更新分类（重名后端返回 400，中文提示由 http 层包装为 ApiError） */
export async function updateCategory(
  id: string,
  payload: { key?: string; name?: string; sort?: number; enabled?: boolean },
): Promise<Category> {
  const { baseURL, url } = endpoint('categories', `/${id}`)
  const config = { baseURL, url, method: 'patch' as const }
  const raw = await request<BackendCategory | Category>({
    ...config,
    data: isReal({ baseURL }) ? toBackendCategoryBody(payload) : payload,
  })
  return adapt<Category, BackendCategory>(config, raw, mapCategory)
}

/** 删除分类（软删）：有文档引用时后端返回 400 */
export async function deleteCategory(id: string): Promise<{ id: string }> {
  const { baseURL, url } = endpoint('categories', `/${id}`)
  const raw = await request<{ id: string }>({ baseURL, url, method: 'delete' })
  return { id: raw?.id ?? id }
}
