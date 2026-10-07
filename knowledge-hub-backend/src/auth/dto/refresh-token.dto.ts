import { IsJWT } from 'class-validator';

/**
 * 刷新 token 请求体：传入 refreshToken 换取新的双 token
 */
export class RefreshTokenDto {
  /** 刷新令牌（登录时签发，type=refresh） */
  @IsJWT({ message: 'refreshToken 格式不合法' })
  refreshToken: string;
}
