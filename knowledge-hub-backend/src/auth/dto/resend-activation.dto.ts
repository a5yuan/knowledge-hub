import { IsEmail } from 'class-validator';

/**
 * 重发激活邮件请求体（防枚举：无论邮箱是否存在均返回统一提示）
 */
export class ResendActivationDto {
  /** 注册时填写的邮箱 */
  @IsEmail({}, { message: '邮箱格式不合法' })
  email: string;
}
