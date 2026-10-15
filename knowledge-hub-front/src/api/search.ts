import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { mapSearchItem, type BackendSearchItem } from './adapters/search'
import type { PageResult, SearchQuery, SearchResultItem } from '@/types/api'

/**
 * 关键词检索。真实通道透传 q/page/pageSize + category_id（17 号工单）——
 * 后端 SearchQueryDto 支持 category_id/tags/is_public 等 filter，但前端高级面板中
 * 文件类型与日期范围后端仍未支持，由视图层保持禁用以免无声空转。
 */
export async function search(params: SearchQuery): Promise<PageResult<SearchResultItem>> {
  const { baseURL, url } = endpoint('search')
  const real = isReal({ baseURL })
  const realParams: Record<string, string | number> = {
    q: params.q,
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 10,
  }
  // 分类筛选：仅雪花ID可表达（Mock 分类 id 形如 cat-1，真实通道传过去会被后端静默丢掉）
  if (params.categoryId && /^\d+$/.test(params.categoryId)) realParams.category_id = params.categoryId
  const config = {
    baseURL,
    url,
    method: 'get' as const,
    params: real ? realParams : params,
  }
  const raw = await request<unknown>(config)
  if (!real) {
    return raw as PageResult<SearchResultItem>
  }
  const page = raw as { total: number; page: number; pageSize: number; items: BackendSearchItem[] }
  return { list: page.items.map(mapSearchItem), total: page.total, page: page.page, pageSize: page.pageSize }
}

/** 热门搜索：后端无 /search/hot 接口，显式钉在 Mock 通道（工单 04） */
export function fetchHotSearch(): Promise<{ keyword: string; count: number }[]> {
  const { baseURL, url } = endpoint('search', '/hot', 'mock')
  return request<{ keyword: string; count: number }[]>({ baseURL, url, method: 'get' })
}

// ---------- 搜索历史：前端 localStorage（spec §8 约定，无后端端点） ----------

const HISTORY_KEY = 'kh_search_history'
const MAX_HISTORY = 20

export function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function addSearchHistory(keyword: string): void {
  const kw = keyword.trim()
  if (!kw) return
  const next = [kw, ...getSearchHistory().filter((k) => k !== kw)].slice(0, MAX_HISTORY)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

export function clearSearchHistory(): void {
  localStorage.removeItem(HISTORY_KEY)
}
