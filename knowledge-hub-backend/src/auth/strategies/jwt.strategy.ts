import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserService } from '../user.service';
import type { AuthUser, JwtPayload } from '../interfaces/auth-user.interface';

/**
 * JWT 校验策略：验证签名与过期 → 解析 payload → 按 sub 重查用户挂载到 request.user
 * 每次请求实时重查数据库：角色新鲜，且天然拦截已删除/已禁用用户
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly userService: UserService,
  ) {
    super({
      /** 从 Authorization: Bearer <token> 提取 */
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * 验签通过后回调：refresh token 不能调用业务 API（type 必须为 access）
   * 用户不存在/已删除/已禁用 → 401
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('refreshToken 不能用于访问业务接口');
    }
    return this.userService.getUserWithRoles(payload.sub);
  }
}
