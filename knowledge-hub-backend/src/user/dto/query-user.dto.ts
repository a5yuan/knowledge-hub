import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MANAGED_ROLES, type ManagedRole } from './create-user.dto';
import { USER_STATUSES, type UserStatusFilter } from './user-status';

/** 用户列表查询参数（管理端 /user；URL 参数均为字符串，需 @Type 转换） */
export class QueryUserDto {
  /** 关键词（username / real_name 模糊匹配） */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 角色筛选（前端语义：admin = 含 ROLE_ADMIN，member = 不含） */
  @IsOptional()
  @IsIn(MANAGED_ROLES)
  role?: ManagedRole;

  /** 部门筛选（雪花 ID）；空串 = 仅未归属部门的用户 */
  @IsOptional()
  @IsString()
  department_id?: string;

  /** 状态筛选：active / disabled */
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatusFilter;

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** 每页条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
