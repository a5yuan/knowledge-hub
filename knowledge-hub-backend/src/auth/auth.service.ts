import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { UserService } from './user.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { KhUser } from './entities/kh-user.entity';
import type { AuthUser, JwtPayload } from './interfaces/auth-user.interface';

/** 登录/refresh 统一返回结构 */
export interface TokenPairResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** accessToken 有效期（秒） */
  expiresIn: number;
  userInfo: AuthUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) { }

  /**
   * 登录（对齐登录流程图）：
   * 用户不存在或密码错误 → 统一 401（防用户枚举）
   * 邮箱未激活（email_verified=0）/ 禁用（status=0）→ 403 明确提示
   * 通过后更新 lastLoginAt → 签发双 token
   */
  async login(dto: LoginDto): Promise<TokenPairResult> {
    const user = await this.userService.findByUsername(dto.username);
    const passwordOk = user
      ? await bcrypt.compare(dto.password, user.password)
      : false;
    if (!user || !passwordOk) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.email_verified !== 1) {
      throw new ForbiddenException('邮箱未激活，请查收激活邮件完成激活后再登录');
    }
    if (user.status !== 1) {
      throw new ForbiddenException('用户已被禁用');
    }
    const roles = await this.userService.getRoleCodes(user.id);
    await this.userService.updateLastLogin(user.id);
    this.logger.log(`用户登录成功 userId=${user.id} username=${user.username}`);

    return this.buildTokenPairResult(user, roles);
  }

  /**
   * 刷新 token：校验 refreshToken（签名/过期/type=refresh）→ 按 userId 重查用户 → 轮换签发新双 token
   * 旧 refreshToken 未做服务端吊销（无状态 JWT），泄露窗口 = 有效期 7d
   */
  async refresh(dto: RefreshTokenDto): Promise<TokenPairResult> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(dto.refreshToken);
    } catch {
      throw new UnauthorizedException('refreshToken 无效或已过期');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('refreshToken 无效或已过期');
    }
    // 按 userId 重查用户（禁用/删除 → 401），角色实时新鲜
    const user = await this.userService.getUserWithRoles(payload.sub);
    this.logger.log(`token 刷新成功 userId=${user.userId}`);

    return {
      accessToken: this.jwt.sign({ sub: user.userId, username: user.username, type: 'access' }),
      refreshToken: this.signRefreshToken(user.userId, user.username),
      tokenType: 'Bearer',
      expiresIn: this.accessExpiresInSeconds(),
      userInfo: user,
    };
  }

  /** kh_user 实体 + 角色编码 → 双 token 结果（login 用） */
  private async buildTokenPairResult(
    user: KhUser,
    roles: string[],
  ): Promise<TokenPairResult> {
    const userInfo: AuthUser = {
      userId: user.id,
      username: user.username,
      realName: user.real_name,
      email: user.email,
      avatar: user.avatar,
      roles,
    };
    return {
      accessToken: this.jwt.sign({ sub: user.id, username: user.username, type: 'access' }),
      refreshToken: this.signRefreshToken(user.id, user.username),
      tokenType: 'Bearer',
      expiresIn: this.accessExpiresInSeconds(),
      userInfo,
    };
  }

  /** 签发 refreshToken（默认 signOptions 为 access 的 2h，此处单点覆盖为 7d） */
  private signRefreshToken(userId: string, username: string): string {
    return this.jwt.sign(
      { sub: userId, username, type: 'refresh' },
      { expiresIn: this.config.get('JWT_REFRESH_EXPIRES', '7d') },
    );
  }

  /** 解析 JWT_ACCESS_EXPIRES 为秒数（'2h' → 7200；'7200' → 7200），返回给前端展示用 */
  private accessExpiresInSeconds(): number {
    const raw = this.config.get<string>('JWT_ACCESS_EXPIRES', '2h').trim();
    const hours = /^(\d+)\s*h$/i.exec(raw);
    const seconds = hours ? Number(hours[1]) * 3600 : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 7200;
  }
}
