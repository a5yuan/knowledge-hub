import { SetMetadata } from '@nestjs/common';

/** @Roles 装饰器元数据 key */
export const ROLES_KEY = 'roles';

/**
 * 标记接口所需角色编码（如 'ROLE_ADMIN'、'ROLE_REVIEWER'），由全局 RolesGuard 校验
 * 未标记 @Roles 的接口不校验角色，仅需登录
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
