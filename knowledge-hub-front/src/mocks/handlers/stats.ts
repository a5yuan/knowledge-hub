import { http } from 'msw'
import type { DashboardStats } from '@/types/api'
import { db, getViewer, todayNewCount } from '../db'
import { daysAgoIso } from '../seed'
import { ok, unauthorized, withLatency } from './utils'

export type TrendRange = 'today' | '7d' | '30d'

/** 确定性伪随机序列，保证同一 range 的曲线形态稳定可演示 */
function pseudoValue(i: number): number {
  return 40 + ((i * 37) % 53) + ((i * 13) % 17)
}

function buildTrend(range: TrendRange): DashboardStats['trend'] {
  const points: { label: string; value: number }[] = []
  if (range === 'today') {
    const hour = new Date().getHours()
    for (let h = 0; h < 24; h++) {
      points.push({ label: `${String(h).padStart(2, '0')}时`, value: h <= hour ? pseudoValue(h) : 0 })
    }
  } else {
    const days = range === '7d' ? 7 : 30
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const label = range === '7d'
        ? `${d.getMonth() + 1}/${d.getDate()}`
        : `${d.getMonth() + 1}/${d.getDate()}`
      points.push({ label, value: pseudoValue(days - i) })
    }
  }
  return { range, points }
}

export const statsHandlers = [
  http.get('/api/stats/dashboard', async ({ request }) => {
    await withLatency(150)
    const url = new URL(request.url)
    const range = (url.searchParams.get('range') ?? '7d') as TrendRange

    const activeUsers = new Set(
      db.operations
        .filter((op) => op.action === 'login' && op.createdAt.slice(0, 10) === daysAgoIso(0).slice(0, 10))
        .map((op) => op.userId),
    ).size
    const searchCount = db.hotSearch.reduce((sum, h) => sum + h.count, 0)

    const active = db.documents.filter((d) => d.archivedAt == null)
    const categoryRatio = db.categories.map((c) => ({
      key: c.key,
      name: c.name,
      count: active.filter((d) => d.categoryId === c.id).length,
    }))

    const stats: DashboardStats = {
      totals: {
        docTotal: active.length,
        todayNew: todayNewCount(),
        searchCount,
        activeUsers,
      },
      trend: buildTrend(range),
      categoryRatio,
    }
    return ok(stats)
  }),

  // 个人中心-我的上传统计（口径与「我的文档」分区一致：本人未归档文档；存储量按文件字节聚合）
  http.get('/api/stats/mine', async ({ request }) => {
    await withLatency(80)
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const mine = db.documents.filter((d) => d.ownerId === viewer.id && d.archivedAt == null)
    return ok({
      docCount: mine.length,
      totalSize: mine.reduce((sum, d) => sum + (d.fileSize ?? 0), 0),
    })
  }),
]
