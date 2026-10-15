import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 管理端可设置的角色（前端语义；service 内转 ROLE_ADMIN / ROLE_USER） */
export const MANAGED_ROLES = ['admin', 'member'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

/** 创建用户参数（管理端 /user，对齐前端 admin/Users.vue 新建弹窗） */
export class CreateUserDto {
  /** 登录用户名（必填，未删用户唯一） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  username: string;

  /** 真实姓名 / 显示名（前端 displayName） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  real_name?: string;

  /** 邮箱（可选；管理端代建账号不走邮件激活，无需邮箱即可登录） */
  @IsOptional()
  @IsEmail()
  @MaxLength(100)
  email?: string;

  /**
   * 初始密码（可选，≥6 位）。缺省时 service 落 DEFAULT_INITIAL_PASSWORD 并 WARN 记日志
   * —— 与前端 UserCreatePayload.password?: string 的可选语义保持一致
   */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  /**
   * 角色（前端语义，非后端角色码）：
   * 后端 DTO 直接接受 'admin' | 'member'，service 内转 ROLE_ADMIN / ROLE_USER，
   * 避免 `ROLE_` 命名泄漏进视图层（见 18 号工单的取舍说明）
   */
  @IsIn(MANAGED_ROLES)
  role: ManagedRole;

  /** 归属部门 ID（可选；空串 / 缺省 = 不归属部门） */
  @IsOptional()
  @IsString()
  department_id?: string;

  /** 账号状态：0 禁用 1 启用（缺省 1） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
