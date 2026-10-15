/**
 * 用户状态的前端语义取值（管理端接口的入参/出参统一用它）。
 *
 * 后端 kh_user.status 是 smallint（0 禁用 / 1 启用），转前端 'active' | 'disabled'
 * 的映射只应发生在两处：DTO 入参解析（QueryUserDto）与 service 出参组装（UserAdminService）。
 */
export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatusFilter = (typeof USER_STATUSES)[number];

/** 'active' → 1 / 'disabled' → 0 */
export function toStatusCode(status: UserStatusFilter): number {
  return status === 'active' ? 1 : 0;
}
