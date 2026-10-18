import { request } from './http'
import { endpoint } from './endpoint'
import type { DashboardStats, MyStats } from '@/types/api'

/**
 * 大盘 / 个人统计 API（20 号工单）。
 *
 * ⚠️ **本模块是全批唯一不需要 adapter 的**：后端 `StatsService` 直接按前端 `DashboardStats` /
 * `MyStats` 的形状出参（camelCase、无 snake_case），因为这两个类型本来就是照着 Mock 的口径定的。
 * 一旦后端要改字段名，说明契约变了 —— 那时再补 adapter，不要提前造一层空映射。
 */

export type TrendRange = 'today' | '7d' | '30d'

/** 首页大盘：4 个总数 + 趋势分桶 + 分类占比（range 缺省近 7 日） */
export function fetchDashboardStats(range: TrendRange = '7d'): Promise<DashboardStats> {
  const { baseURL, url } = endpoint('stats', '/dashboard')
  return request<DashboardStats>({ baseURL, url, method: 'get', params: { range } })
}

/** 个人中心-我的上传统计（口径与「我的文档」列表一致：本人未归档文档） */
export function fetchMyStats(): Promise<MyStats> {
  const { baseURL, url } = endpoint('stats', '/mine')
  return request<MyStats>({ baseURL, url, method: 'get' })
}
