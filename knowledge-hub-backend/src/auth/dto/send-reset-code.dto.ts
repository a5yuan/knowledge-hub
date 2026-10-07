import { IsEmail } from 'class-validator';

/**
 * 发送密码重置验证码请求体（防枚举：邮箱不存在时返回统一提示）
 */
export class SendResetCodeDto {
  /** 注册时填写的邮箱 */
  @IsEmail({}, { message: '邮箱格式不合法' })
  email: string;
}
