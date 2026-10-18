import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import {
  mapOperationLog,
  toBackendOperationQuery,
  type BackendOperationPage,
} from './adapters/operation'
import type { OperationAction, PageQuery, PageResult } from '@/types/api'

/**
 * 操作日志 API（19 号工单）。
 * 双通道：Mock 保持既有 camelCase 契约不动；真实通道经 adapter 转 snake_case。
 * 所有函数一律经 endpoint('operations') 取路径，不写字面量。
 */

/** 操作日志视图行（视图层唯一形状，Mock 与真实通道共用） */
export type OperationLogView = {
  id: string
  userId: string
  /** 后端写入时的用户名快照；系统动作为「系统」 */
  userName: string
  action: OperationAction
  targetId?: string
  targetTitle?: string
  detail?: string
  createdAt: string
}

export interface OperationListQuery extends PageQuery {
  action?: OperationAction
  /** 按操作人筛选（雪花 ID 字符串） */
  userId?: string
}

/**
 * 操作日志分页（created_at DESC）。
 *
 * 大盘只取前 10 条（`page:1, pageSize:10`）；管理端如需全量审计，复用同端点加筛选即可。
 * 后端**不提供写接口** —— 日志只能由各域内部埋点产生（允许外部 POST 等于允许伪造审计）。
 */
export async function fetchOperations(query: OperationListQuery): Promise<PageResult<OperationLogView>> {
  const { baseURL, url } = endpoint('operations')
  const config = {
    baseURL,
    url,
    method: 'get' as const,
    params: isReal({ baseURL }) ? toBackendOperationQuery(query) : query,
  }
  const raw = await request<BackendOperationPage | PageResult<OperationLogView>>(config)
  return adapt<PageResult<OperationLogView>, BackendOperationPage>(config, raw, (page) => ({
    list: (page.list ?? []).map(mapOperationLog),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  }))
}
