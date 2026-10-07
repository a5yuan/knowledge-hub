import { SetMetadata } from '@nestjs/common';

/** @RequirePermission 装饰器元数据 key */
export const PERMISSION_KEY = 'permissions';

/**
 * 标记接口所需权限码（如 'document:create'），由全局 PermissionsGuard 校验（图3 接口级 / 图4 第三步）
 * - 未标注的接口不校验权限（仅过登录 + 角色两层）
 * - any-of 语义：命中任一所需权限码即放行
 * - ROLE_ADMIN 旁路（Admin 拥有所有权限）
 * - 可与 @Roles 叠加（如文档审核接口：先验角色再验权限码）
 */
export const RequirePermission = (...codes: string[]) =>
  SetMetadata(PERMISSION_KEY, codes);
