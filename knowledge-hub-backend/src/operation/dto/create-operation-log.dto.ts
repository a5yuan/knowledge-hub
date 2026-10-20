import type { AuthUser } from '../../auth/interfaces/auth-user.interface';

/**
 * 动作类型全量表（19 号工单）。
 *
 * 消费方：
 * - 写侧 `OperationService.record()` 的类型约束（写错 action 编译期报错）
 * - 读侧 `QueryOperationLogDto.action` 的 `@IsIn` 校验
 * - 前端 `views/dashboard/Index.vue` 的 `ACTION_META`（两侧必须同步）
 *
 * ⚠️ 新增 action 时**三处一起改**：本常量、前端 `ACTION_META`、`types/api.ts` 的
 * `OperationAction`。前端有 `actionMeta()` 兜底不会白屏，但漏改会退化成显示原始英文串。
 */
export const OPERATION_ACTIONS = [
  // 文档域
  'upload',
  'update',
  'delete',
  'publish',
  'archive',
  'review-approve',
  'review-reject',
  // 认证域
  'login',
  // AI 域
  'ai-ask',
  // 检索域（20 号工单补：大盘 searchCount 的唯一数据源）
  'search',
  // 管理域：用户（18 号工单）
  'user-create',
  'user-edit',
  'user-delete',
  // 管理域：团队（15 号工单）
  'team-create',
  'team-edit',
  'team-delete',
  // 管理域：目录（16 号工单）
  'folder-create',
  'folder-delete',
  // 管理域：公告（21 号工单）
  'announcement-create',
  'announcement-update',
  'announcement-delete',
] as const;

export type OperationAction = (typeof OPERATION_ACTIONS)[number];

/**
 * 目标类型全量表。
 *
 * 认证域（login）与 AI 域（ai-ask）没有业务目标，target_type 落 null，
 * 故不设 `'none'` 之类的哨兵值 —— 语义上「无目标」就该是 NULL。
 */
export const OPERATION_TARGET_TYPES = [
  'document',
  'user',
  'team',
  'folder',
  // 21 号工单：系统公告
  'announcement',
] as const;

export type OperationTargetType = (typeof OPERATION_TARGET_TYPES)[number];

/**
 * `record()` 的入参。
 *
 * 刻意**不用 class-validator 装饰器**：本项目约定「校验用 class-validator」针对的是
 * HTTP 入参，而操作日志**不对外暴露写接口**（允许外部 POST 日志 = 允许伪造审计记录），
 * 本 DTO 只在 service 之间流转，类型约束由 TS 在编译期完成。
 */
export interface CreateOperationLogDto {
  /** 动作类型（枚举约束，防手写拼错） */
  action: OperationAction;

  /** 目标类型；认证域 / AI 域不传 */
  target_type?: OperationTargetType | null;

  /** 目标 ID；删除类埋点必须在删除**前**取值（删后目标已不可查） */
  target_id?: string | null;

  /** 目标标题；超 200 字符会被 `record()` 主动截断而非丢日志 */
  target_title?: string | null;

  /** 明细描述；超 500 字符会被 `record()` 主动截断 */
  detail?: string | null;

  /**
   * 操作人。不传 = 系统动作（`user_id` / `user_name` 均落 NULL）。
   * 由 `AuthUser` 派生快照，调用方不必重复拼 `realName ?? username`。
   */
  actor?: AuthUser | null;
}
