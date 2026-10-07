import { IsString, Length } from 'class-validator';

/**
 * 登录请求体（对齐登录流程图：username + password）
 */
export class LoginDto {
  /** 登录用户名 */
  @IsString()
  @Length(1, 50)
  username: string;

  /** 登录密码 */
  @IsString()
  @Length(1, 50)
  password: string;
}
