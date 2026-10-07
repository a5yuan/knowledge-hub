import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

/** 新建角色请求体（role_code 由后端自动生成） */
export class CreateRoleDto {
  /** 角色名称（展示用） */
  @IsString()
  @Length(1, 50)
  roleName: string;

  /** 角色描述 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

/** 编辑角色请求体（名称/描述/状态，均可选） */
export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  roleName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @IsIn([0, 1])
  status?: number;
}

/** 保存角色权限请求体（全量覆盖） */
export class AssignRolePermissionsDto {
  /** 权限ID列表（kh_permission.id） */
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}
