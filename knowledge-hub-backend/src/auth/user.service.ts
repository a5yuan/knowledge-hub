import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import SnowflakeId from 'snowflake-id';
import { KhUser } from './entities/kh-user.entity';
import { KhRole } from './entities/kh-role.entity';
import { KhUserRole } from './entities/kh-user-role.entity';
import { RegisterDto } from './dto/register.dto';
import { RedisService } from './redis.service';
import { MailService } from './mail.service';
import type { AuthUser } from './interfaces/auth-user.interface';

/** 默认角色编码（注册时绑定，见 init.sql 预置数据） */
export const DEFAULT_ROLE_CODE = 'ROLE_USER';
/** 审批员角色编码 */
export const REVIEWER_ROLE_CODE = 'ROLE_REVIEWER';
const BCRYPT_COST = 10;
/** 激活 token Redis key 前缀 / 有效期 */
const ACTIVATION_KEY = (token: string) => `email:activation:${token}`;
const ACTIVATION_TTL_SECONDS = 24 * 60 * 60; // 24h
/** 重置验证码 Redis key 前缀 / 有效期 */
const RESET_KEY = (email: string) => `email:reset:${email.toLowerCase()}`;
const RESET_TTL_SECONDS = 10 * 60; // 10 分钟

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  /** 应用侧雪花ID生成器（generate() 返回字符串，精度安全） */
  private readonly snowflake = new SnowflakeId();
  /** 是否开启邮箱验证（.env REQUIRE_EMAIL_VERIFICATION，true 时注册需激活才能登录） */
  private readonly requireEmailVerification: boolean;

  constructor(
    @InjectRepository(KhUser)
    private readonly userRepo: Repository<KhUser>,
    @InjectRepository(KhRole)
    private readonly roleRepo: Repository<KhRole>,
    @InjectRepository(KhUserRole)
    private readonly userRoleRepo: Repository<KhUserRole>,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.requireEmailVerification = config.get('REQUIRE_EMAIL_VERIFICATION') === 'true';
  }

  /**
   * 注册（对齐注册流程图）：查重 → 雪花ID + bcrypt(cost=10) → 写 kh_user → 绑定默认角色 ROLE_USER
   * REQUIRE_EMAIL_VERIFICATION=false：写 email_verified=1/status=1，可立即登录（现状行为）
   * REQUIRE_EMAIL_VERIFICATION=true：写 email_verified=0/status=0，发激活邮件，激活后才能登录
   */
  async register(dto: RegisterDto) {
    if (this.requireEmailVerification && !dto.email) {
      throw new BadRequestException('开启邮箱验证时，邮箱必填');
    }
    const email = dto.email ? dto.email.toLowerCase() : null;

    // 查重：username 与 email 均需唯一（仅 email 非空时校验）
    const usernameExists = await this.userRepo.findOne({
      where: { username: dto.username, deleted: false },
    });
    if (usernameExists) {
      throw new ConflictException('用户名已存在');
    }
    const emailExists = email
      ? await this.userRepo.findOne({ where: { email, deleted: false } })
      : null;
    if (emailExists) {
      throw new ConflictException('邮箱已被注册');
    }

    const id = this.snowflake.generate();
    const password = await bcrypt.hash(dto.password, BCRYPT_COST);
    try {
      await this.userRepo.save(
        this.userRepo.create({
          id,
          username: dto.username,
          password,
          email,
          real_name: dto.realName ?? null,
          // 邮箱验证开启时置为未激活；关闭时保持默认启用(1/1)
          email_verified: this.requireEmailVerification ? 0 : 1,
          status: this.requireEmailVerification ? 0 : 1,
        }),
      );
    } catch (err) {
      // 并发兜底：命中部分唯一索引（23505）按冲突返回
      if (err?.code === '23505') {
        throw new ConflictException('用户名或邮箱已被使用');
      }
      throw err;
    }

    await this.bindDefaultRole(id);
    this.logger.log(`用户注册成功 userId=${id} username=${dto.username}`);

    // 关闭邮箱验证：立即可登录
    if (!this.requireEmailVerification) {
      return { userId: id, message: '注册成功，请登录' };
    }

    // 开启邮箱验证：生成激活 token → 发激活邮件；失败则回滚刚插入的用户，避免账号永远无法激活
    try {
      const token = crypto.randomBytes(24).toString('hex');
      await this.redis.setex(ACTIVATION_KEY(token), ACTIVATION_TTL_SECONDS, id);
      await this.mail.sendActivationMail(email!, token);
    } catch (err) {
      await this.userRepo.delete({ id });
      await this.userRoleRepo.delete({ user_id: id });
      this.logger.error(`激活邮件发送失败，已回滚用户 userId=${id} err=${(err as Error).message}`);
      throw new InternalServerErrorException('激活邮件发送失败，请稍后重试');
    }
    return { userId: id, message: '注册成功，请查收激活邮件并完成激活后再登录' };
  }

  /**
   * 邮箱激活（GET /auth/verify-email?token=）：校验并消费 Redis 激活 token → 双字段(email_verified/status)置 1
   * 激活后立即删除 token，链接一次性；重复点击/过期/伪造 → 失败结果
   */
  async verifyEmail(token: string): Promise<{ ok: boolean; message: string }> {
    const key = ACTIVATION_KEY(token);
    const userId = await this.redis.get(key);
    if (!userId) {
      return { ok: false, message: '激活链接无效或已过期，请重新发送激活邮件' };
    }
    const user = await this.userRepo.findOne({ where: { id: userId, deleted: false } });
    if (!user) {
      return { ok: false, message: '激活链接无效或已过期，请重新发送激活邮件' };
    }
    // 激活成功即消费 token（链接一次性）；已激活账号重复点击幂等提示
    await this.redis.del(key);
    if (user.email_verified === 1) {
      return { ok: true, message: '邮箱已激活，请直接登录' };
    }
    user.email_verified = 1;
    user.status = 1;
    await this.userRepo.save(user);
    this.logger.log(`邮箱激活成功 userId=${user.id} email=${user.email}`);
    return { ok: true, message: '邮箱激活成功，请直接登录' };
  }

  /**
   * 重发激活邮件（防枚举）：只对未激活账号（email_verified=0 + status=0）重发，统一返回模糊提示
   * 图外补充，防 24h 过期/邮件丢失导致的账号死锁
   */
  async resendActivation(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const user = await this.userRepo.findOne({
      where: { email: normalized, email_verified: 0, status: 0, deleted: false },
    });
    if (user) {
      const token = crypto.randomBytes(24).toString('hex');
      await this.redis.setex(ACTIVATION_KEY(token), ACTIVATION_TTL_SECONDS, user.id);
      await this.mail.sendActivationMail(normalized, token);
      this.logger.log(`重发激活邮件 userId=${user.id} email=${normalized}`);
    }
    return { message: '若该邮箱存在未激活账号，激活邮件已重新发送' };
  }

  /** 发送密码重置验证码（未登录找回场景，防枚举）：仅对已激活账号发码，统一返回模糊提示 */
  async sendResetCode(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const user = await this.userRepo.findOne({
      where: { email: normalized, email_verified: 1, deleted: false },
    });
    if (user) {
      const code = crypto.randomInt(100000, 1000000).toString();
      await this.redis.setex(RESET_KEY(normalized), RESET_TTL_SECONDS, code);
      await this.mail.sendResetCodeMail(normalized, code);
      this.logger.log(`密码重置验证码已发送 userId=${user.id} email=${normalized}`);
    }
    return { message: '若该邮箱已注册，验证码已发送，10 分钟内有效' };
  }

  /**
   * 重置密码：校验验证码（一次性，校验通过即删除）→ 新密码 bcrypt 写库
   * 验证码错误/过期/已使用 → 400；错码不消耗正确码
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const key = RESET_KEY(normalized);
    const stored = await this.redis.get(key);
    if (!stored || stored !== code) {
      throw new BadRequestException('验证码错误或已过期');
    }
    // 一次性消费：重置成功后验证码立即失效（图 3 第 5 步）
    await this.redis.del(key);
    const password = await bcrypt.hash(newPassword, BCRYPT_COST);
    await this.userRepo.update({ email: normalized, deleted: false }, { password });
    this.logger.log(`密码重置成功 email=${normalized}`);
    return { message: '密码重置成功，请使用新密码登录' };
  }

  /** 按用户名查询（未删除），登录用 */
  findByUsername(username: string): Promise<KhUser | null> {
    return this.userRepo.findOne({ where: { username, deleted: false } });
  }

  /**
   * 按用户ID重查用户 + 启用角色（JwtStrategy / refresh 用）
   * 用户不存在 / 已删除 / 已禁用 → 401
   */
  async getUserWithRoles(userId: string): Promise<AuthUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, deleted: false },
    });
    if (!user || user.status !== 1) {
      throw new UnauthorizedException('用户不存在或已被禁用');
    }
    const roles = await this.getRoleCodes(user.id);
    return this.toAuthUser(user, roles);
  }

  /** 查询用户启用状态的角编码列表 */
  async getRoleCodes(userId: string): Promise<string[]> {
    const links = await this.userRoleRepo.find({ where: { user_id: userId } });
    if (links.length === 0) return [];
    const roles = await this.roleRepo.find({
      where: { id: In(links.map((l) => l.role_id)) },
    });
    return roles
      .filter((r) => r.status === 1)
      .map((r) => r.role_code);
  }

  /**
   * 审批员列表（reviewer-ids 接口数据源）：
   * ROLE_REVIEWER → kh_user_role → kh_user（仅启用、未删除）
   */
  async findReviewers(): Promise<
    { userId: string; username: string; realName: string | null }[]
  > {
    const role = await this.roleRepo.findOne({
      where: { role_code: REVIEWER_ROLE_CODE },
    });
    if (!role) return [];
    const links = await this.userRoleRepo.find({
      where: { role_id: role.id },
    });
    if (links.length === 0) return [];
    const users = await this.userRepo.find({
      where: {
        id: In(links.map((l) => l.user_id)),
        status: 1,
        deleted: false,
      },
      order: { created_at: 'ASC' },
    });
    return users.map((u) => ({
      userId: u.id,
      username: u.username,
      realName: u.real_name,
    }));
  }

  /** 更新最后登录时间 */
  async updateLastLogin(userId: string): Promise<void> {
    await this.userRepo.update({ id: userId }, { last_login_at: new Date() });
  }

  /** 绑定默认角色 ROLE_USER（写入用户-角色关联表） */
  private async bindDefaultRole(userId: string): Promise<void> {
    const role = await this.roleRepo.findOne({
      where: { role_code: DEFAULT_ROLE_CODE },
    });
    if (!role) {
      throw new ConflictException('默认角色未初始化，请检查 kh_role 预置数据');
    }
    await this.userRoleRepo.save(
      this.userRoleRepo.create({
        id: this.snowflake.generate(),
        user_id: userId,
        role_id: role.id,
      }),
    );
  }

  /** kh_user 实体 → request.user 形状 */
  private toAuthUser(user: KhUser, roles: string[]): AuthUser {
    return {
      userId: user.id,
      username: user.username,
      realName: user.real_name,
      email: user.email,
      avatar: user.avatar,
      roles,
    };
  }
}
