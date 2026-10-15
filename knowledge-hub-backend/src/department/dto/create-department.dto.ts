import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** 创建部门参数（kh_department；dept_name 必填，其余可选） */
export class CreateDepartmentDto {
  /** 部门名称（必填，未删部门内唯一） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  dept_name: string;

  /** 部门编码（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dept_code?: string;

  /** 父部门ID（可选，缺省 '0' 为根） */
  @IsOptional()
  @IsString()
  parent_id?: string;

  /** 排序号（可选，默认 0） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;

  /** 状态（可选，默认 1 启用） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
