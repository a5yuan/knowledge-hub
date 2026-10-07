import { http } from 'msw'
import { canSeeDocument, db, getViewer, paginate, relevanceScore, toSearchResult } from '../db'
import { numParam, ok, unauthorized, withLatency } from './utils'

export const searchHandlers = [
  // 搜索历史走前端 localStorage（spec §8），无 /search/history 端点——对 §7 的偏差已在工单 Comments 记录
  http.get('/api/search', async ({ request }) => {
    await withLatency(200)
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const fileType = url.searchParams.get('fileType') ?? undefined
    const categoryId = url.searchParams.get('categoryId') ?? undefined
    const visibility = url.searchParams.get('visibility') ?? undefined
    const dateFrom = url.searchParams.get('dateFrom') ?? undefined
    const dateTo = url.searchParams.get('dateTo') ?? undefined

    if (!q) {
      return ok({ list: [], total: 0, page: 1, pageSize: numParam(url, 'pageSize', 10) })
    }

    const scored = db.documents
      .filter((doc) => {
        if (doc.archivedAt != null) return false
        if (!canSeeDocument(doc, viewer, db.users)) return false
        if (fileType && doc.fileType !== fileType) return false
        if (categoryId && doc.categoryId !== categoryId) return false
        if (visibility && doc.visibility !== visibility) return false
        if (dateFrom && doc.updatedAt < dateFrom) return false
        if (dateTo && doc.updatedAt > `${dateTo}T23:59:59.999Z`) return false
        return relevanceScore(doc, q) > 0
      })
      .sort((a, b) => {
        const diff = relevanceScore(b, q) - relevanceScore(a, q)
        return diff !== 0 ? diff : b.updatedAt.localeCompare(a.updatedAt)
      })

    // 热门搜索计数聚合
    const hot = db.hotSearch.find((h) => h.keyword === q)
    if (hot) hot.count += 1
    else db.hotSearch.push({ keyword: q, count: 1 })

    const page = paginate(scored, { page: numParam(url, 'page', 1), pageSize: numParam(url, 'pageSize', 10) })
    return ok({ ...page, list: page.list.map(toSearchResult) })
  }),

  http.get('/api/search/hot', async () => {
    await withLatency(80)
    const top = [...db.hotSearch].sort((a, b) => b.count - a.count).slice(0, 10)
    return ok(top)
  }),
]
