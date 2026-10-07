import { IsString, Length } from 'class-validator';

/**
 * 邮箱激活查询参数（GET /auth/verify-email?token=xxx，浏览器直接打开）
 */
export class VerifyEmailDto {
  /** 激活 token（注册时生成，Redis 24h） */
  @IsString()
  @Length(10, 128, { message: '激活 token 不合法' })
  token: string;
}
