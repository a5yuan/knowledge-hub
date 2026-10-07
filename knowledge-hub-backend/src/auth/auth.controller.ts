import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { PermissionService } from './permission.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ResendActivationDto } from './dto/resend-activation.dto';
import { SendResetCodeDto } from './dto/send-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './interfaces/auth-user.interface';

/** 用户模块接口：注册 / 激活 / 登录 / 刷新 token / 当前用户 / 审批员列表 / 找回密码 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
  ) { }

  /** 注册（公开）：REQUIRE_EMAIL_VERIFICATION=false 立即可登录；true 需邮件激活 */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.userService.register(dto);
  }

  /** 邮箱激活（公开，浏览器直接打开邮件链接）：校验并消费 token → email_verified/status 置 1，返回 HTML 结果页 */
  @Public()
  @Get('verify-email')
  async verifyEmail(@Query() dto: VerifyEmailDto, @Res() res: Response) {
    const result = await this.userService.verifyEmail(dto.token);
    res.type('html').send(renderVerifyPage(result.ok, result.message));
  }

  /** 重发激活邮件（公开，防枚举）：仅对未激活账号重发 */
  @Public()
  @Post('resend-activation')
  resendActivation(@Body() dto: ResendActivationDto) {
    return this.userService.resendActivation(dto.email);
  }

  /** 发送密码重置验证码（公开，防枚举）：6 位数字码写 Redis（10 分钟）并发邮件 */
  @Public()
  @Post('password/send-code')
  sendResetCode(@Body() dto: SendResetCodeDto) {
    return this.userService.sendResetCode(dto.email);
  }

  /** 重置密码（公开）：验证码一次性校验 → 新密码 bcrypt 写库 */
  @Public()
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.userService.resetPassword(dto.email, dto.code, dto.newPassword);
  }

  /** 登录（公开）：校验密码 → 未激活/禁用 403 → 更新 lastLoginAt → 签发双 token + userInfo */
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /** 刷新 token（公开）：校验 refreshToken → 重查用户 → 轮换签发新双 token */
  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  /** 当前登录用户信息（需登录，request.user 由 JwtStrategy 实时重查 DB 组装） */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /**
   * 当前用户三级权限总览（需登录，图3）：角色权限 ∪ 直赋权限
   * codes 全量权限码 / menus 菜单树（含祖先链）/ buttons 按钮码
   * 前端菜单/按钮渲染数据源（permissions 不进 token 与 /auth/me，按需实时查询）
   */
  @Get('permissions')
  permissions(@CurrentUser() user: AuthUser) {
    return this.permissionService.getPermissionOverview(user.userId);
  }

  /** 审批员列表（需登录）：文档审核 approve/reject 的审核人下拉数据源 */
  @Get('reviewer-ids')
  reviewerIds() {
    return this.userService.findReviewers();
  }
}

/** 激活结果 HTML 页（邮件链接在浏览器中直接打开，返回轻量结果页而非 JSON） */
function renderVerifyPage(ok: boolean, message: string): string {
  const color = ok ? '#16a34a' : '#dc2626';
  const icon = ok ? '✅' : '⚠️';
  const title = ok ? '邮箱激活' : '激活失败';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family: Arial, 'Microsoft YaHei', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f3f4f6;">
  <div style="text-align: center; background: #fff; padding: 48px 64px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,.08);">
    <div style="font-size: 48px;">${icon}</div>
    <h1 style="color: ${color}; font-size: 22px; margin: 16px 0 8px;">${title}</h1>
    <p style="color: #4b5563; font-size: 15px; margin: 0 0 24px;">${message}</p>
    <a href="/" style="color: #4f46e5; font-size: 14px; text-decoration: none;">返回首页</a>
  </div>
</body>
</html>`;
}
