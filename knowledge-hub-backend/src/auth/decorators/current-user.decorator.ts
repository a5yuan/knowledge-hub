import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../interfaces/auth-user.interface';

/**
 * 从 request.user 中获取当前登录用户（由全局 JwtAuthGuard + JwtStrategy 挂载）
 * 用法：@CurrentUser() user: AuthUser
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
