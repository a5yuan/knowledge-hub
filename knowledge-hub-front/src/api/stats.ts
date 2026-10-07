import { request } from './http'
import type { DashboardStats, MyStats } from '@/types/api'

export function fetchDashboardStats(range: 'today' | '7d' | '30d' = '7d'): Promise<DashboardStats> {
  return request<DashboardStats>({ url: '/stats/dashboard', method: 'get', params: { range } })
}

/** 个人中心-我的上传统计（文档数/存储量） */
export function fetchMyStats(): Promise<MyStats> {
  return request<MyStats>({ url: '/stats/mine', method: 'get' })
}
