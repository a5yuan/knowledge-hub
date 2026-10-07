import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthUser } from '../interfaces/auth-user.interface';

/**
 * 全局角色 Guard：@Roles 标记的接口校验用户角色（无交集 403），未标记的接口仅要求登录
 * 注册为 APP_GUARD（在 JwtAuthGuard 之后执行，request.user 已挂载）
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    const user = context.switchToHttp().getRequest().user as AuthUser;
    const userRoles = user?.roles ?? [];
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException(
        `无权限访问，需要角色之一：${requiredRoles.join(' / ')}`,
      );
    }
    return true;
  }
}
