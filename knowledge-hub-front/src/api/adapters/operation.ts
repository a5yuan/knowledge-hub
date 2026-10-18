/**
 * 操作日志域字段映射（19 号工单）。
 * snake_case 红线（ADR-0005）：后端字段名只允许出现在 src/api/adapters/ 内。
 *
 * ⚠️ `import type { OperationLogView } from '../operations'` 必须是 **type-only**：
 * operations.ts 会 import 本文件，用 `import type` 保证这条边在编译后被完全擦除，
 * 不会形成运行时循环依赖。
 */
import type { OperationAction, PageQuery } from '@/types/api'
import type { OperationLogView } from '../operations'

/** 后端 /operation 列表行（OperationService.findAll 的 toView 输出，snake_case 原样） */
export interface BackendOperationLog {
  id: string
  /** → userId（系统动作为 null → ''） */
  user_id: string | null
  /** → userName（冗余快照；系统动作为 null → '系统'） */
  user_name: string | null
  /** 后端 action 为 varchar 自由串 → OperationAction（见 mapOperationLog 的风险说明） */
  action: string
  target_type: string | null
  /** → targetId（null → undefined） */
  target_id: string | null
  /** → targetTitle（冗余快照，目标删除后仍可读） */
  target_title: string | null
  detail: string | null
  /** → createdAt */
  created_at: string
}

/** 后端 /operation 分页响应（list 而非 items，与其他资源不同） */
export interface BackendOperationPage {
  list: BackendOperationLog[]
  total: number
  page: number
  pageSize: number
}

/**
 * 后端 → 视图归一。
 *
 * `user_name` / `target_title` 是后端写入时的**冗余快照**，不是关联查出来的：
 * 用户改名或目标被删后，日志仍显示「当时是谁、当时叫什么」——这是审计的正确行为。
 *
 * `action` 用断言而非白名单校验：后端 action 列是自由 varchar，前端穷举清单必然滞后。
 * 真正的防线在 `views/dashboard/Index.vue` 的 `actionMeta()` 兜底 —— 未知 action 显示原始串，
 * 不抛 TypeError、不白屏。
 */
export function mapOperationLog(b: BackendOperationLog): OperationLogView {
  return {
    id: String(b.id),
    userId: b.user_id ?? '',
    userName: b.user_name ?? '系统',
    action: b.action as OperationAction,
    targetId: b.target_id ?? undefined,
    targetTitle: b.target_title ?? undefined,
    detail: b.detail ?? undefined,
    createdAt: b.created_at,
  }
}

/** 视图查询 → 后端 query（camelCase → snake_case）；仅真实通道使用 */
export function toBackendOperationQuery(
  query: PageQuery & { action?: OperationAction; userId?: string },
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20,
  }
  if (query.action !== undefined) params.action = query.action
  if (query.userId !== undefined) params.user_id = query.userId
  return params
}
