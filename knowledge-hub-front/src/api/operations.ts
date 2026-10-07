import { request } from './http'
import type { OperationAction, PageQuery, PageResult } from '@/types/api'

export type OperationLogView = {
  id: string
  userId: string
  userName: string
  action: OperationAction
  targetId?: string
  targetTitle?: string
  detail?: string
  createdAt: string
}

export function fetchOperations(query: PageQuery): Promise<PageResult<OperationLogView>> {
  return request<PageResult<OperationLogView>>({ url: '/operations', method: 'get', params: query })
}
