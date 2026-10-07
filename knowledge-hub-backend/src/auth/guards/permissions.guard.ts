import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { ADMIN_ROLE_CODE, PermissionService } from '../permission.service';
import type { AuthUser } from '../interfaces/auth-user.interface';

/**
 * 全局权限 Guard（图4 第三步）：@RequirePermission 标记的接口校验权限码（未命中 403）
 * - 未标注 → 放行（不触发权限查询，未标注接口零开销）
 * - ROLE_ADMIN → 直接放行（Admin 拥有所有权限）
 * - 校验数据实时查询（角色权限 ∪ 直赋权限），权限变更即时生效
 * 注册为 APP_GUARD（在 JwtAuthGuard、RolesGuard 之后执行：401 → 403 角色 → 403 权限）
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredCodes = this.reflector.getAllAndOverride<string[]>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredCodes || requiredCodes.length === 0) {
      return true;
    }
    const user = context.switchToHttp().getRequest().user as
      | AuthUser
      | undefined;
    if (!user) {
      // 无 user（如 @Public 异常组合）：是否登录归 JwtAuthGuard 管，此处不重复拦截
      return true;
    }
    if (user.roles?.includes(ADMIN_ROLE_CODE)) {
      return true;
    }
    const ownedCodes = await this.permissionService.getUserPermissionCodes(
      user.userId,
    );
    if (requiredCodes.some((code) => ownedCodes.includes(code))) {
      return true;
    }
    throw new ForbiddenException(
      `无权限操作，需要权限之一：${requiredCodes.join(' / ')}`,
    );
  }
}
