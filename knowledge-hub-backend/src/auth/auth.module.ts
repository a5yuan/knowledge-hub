import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailerModule } from '@nestjs-modules/mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { RedisService } from './redis.service';
import { MailService } from './mail.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { PermissionService } from './permission.service';
import { KhUser } from './entities/kh-user.entity';
import { KhRole } from './entities/kh-role.entity';
import { KhUserRole } from './entities/kh-user-role.entity';
import { KhPermission } from './entities/kh-permission.entity';
import { KhRolePermission } from './entities/kh-role-permission.entity';
import { KhUserPermission } from './entities/kh-user-permission.entity';

/**
 * 用户鉴权模块：
 * - APP_GUARD 全局注册 JwtAuthGuard（验登录）→ RolesGuard（验角色）→ PermissionsGuard（验权限码），作用于所有接口
 * - @Public 跳过登录校验；@Roles 校验角色（无 @Roles 仅需登录）；@RequirePermission 校验权限码（Admin 旁路）
 * - Redis（激活 token / 重置验证码）+ Mailer（激活邮件 / 验证码邮件）
 * - exports UserService 供其他模块复用（如文档模块展示审核人信息）
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      KhUser,
      KhRole,
      KhUserRole,
      KhPermission,
      KhRolePermission,
      KhUserPermission,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // access token 默认有效期（refresh token 签发时单点覆盖）
        signOptions: {
          expiresIn: config.get<string>('JWT_ACCESS_EXPIRES', '2h'),
        },
      }),
    }),
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        transport: {
          host: config.get<string>('MAIL_HOST'),
          port: Number(config.get('MAIL_PORT', 587)),
          secure: config.get('MAIL_SECURE') === 'true',
          auth: {
            user: config.get<string>('MAIL_USER'),
            pass: config.get<string>('MAIL_PASS'),
          },
        },
        defaults: { from: config.get<string>('MAIL_FROM') },
      }),
    }),
  ],
  controllers: [AuthController, RoleController],
  providers: [
    UserService,
    PermissionService,
    RoleService,
    AuthService,
    RedisService,
    MailService,
    JwtStrategy,
    // 全局 Guard，顺序：先验登录（401）→ 验角色（403）→ 验权限码（403）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [UserService, RedisService],
})
export class AuthModule { }
