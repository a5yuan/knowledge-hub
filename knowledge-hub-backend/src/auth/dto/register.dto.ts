import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

/**
 * 注册请求体（对齐注册流程图：username 必填、password 至少 6 位、email/realName 可选）
 */
export class RegisterDto {
  /** 登录用户名（2-50 字符，未删除用户唯一） */
  @IsString()
  @Length(2, 50, { message: '用户名长度需在 2-50 字符之间' })
  username: string;

  /** 登录密码（至少 6 位） */
  @IsString()
  @Length(6, 50, { message: '密码至少 6 位' })
  password: string;

  /** 邮箱（可选） */
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不合法' })
  email?: string;

  /** 真实姓名 / 显示名（可选） */
  @IsOptional()
  @IsString()
  @Length(1, 50)
  realName?: string;
}
