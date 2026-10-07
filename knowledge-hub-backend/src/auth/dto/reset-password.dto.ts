import { IsEmail, IsString, Length, Matches } from 'class-validator';

/**
 * 重置密码请求体（对齐修改密码流程图：邮箱 + 验证码 + 新密码，验证码一次性）
 */
export class ResetPasswordDto {
  /** 注册时填写的邮箱 */
  @IsEmail({}, { message: '邮箱格式不合法' })
  email: string;

  /** 6 位数字验证码（send-code 发送，10 分钟有效） */
  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码为 6 位数字' })
  code: string;

  /** 新密码（至少 6 位） */
  @IsString()
  @Length(6, 50, { message: '密码至少 6 位' })
  newPassword: string;
}
