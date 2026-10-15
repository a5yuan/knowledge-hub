import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MANAGED_ROLES, type ManagedRole } from './create-user.dto';

/**
 * 更新用户参数（全可选，仅传需改字段）。
 *
 * - `password` 存在即视为「重置密码」（旧密码立即失效）
 * - `department_id` 传空串 → 规范化 null（清空归属），对齐 admin/Users.vue 在部门列表为空时传 '' 的行为
 * - `role` 与当前折叠角色相同时 service 会跳过角色替换，避免误删 ROLE_REVIEWER（详见 service 注释）
 */
export class UpdateUserDto {
  /** 真实姓名 / 显示名 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  real_name?: string;

  /** 邮箱 */
  @IsOptional()
  @IsEmail()
  @MaxLength(100)
  email?: string;

  /** 重置密码（≥6 位） */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  /** 角色（前端语义） */
  @IsOptional()
  @IsIn(MANAGED_ROLES)
  role?: ManagedRole;

  /** 归属部门 ID；空串 = 清空归属 */
  @IsOptional()
  @IsString()
  department_id?: string;

  /** 账号状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
