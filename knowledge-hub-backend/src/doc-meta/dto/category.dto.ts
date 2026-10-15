import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
  MaxLength,
  Min,
  IsIn,
} from 'class-validator';

/**
 * 分类字典 DTO（17 号工单）
 * 字段命名对齐 kh_team.team_name / team_code 的表名前缀式风格
 */
export class CreateCategoryDto {
  /** 分类名称（未删行唯一，重名 → 400） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category_name: string;

  /** 分类编码（slug，供前端 Category.key；未删行唯一） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category_code?: string;

  /** 排序（升序） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category_code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class QueryCategoryDto {
  /**
   * 是否返回全部（含已禁用）。
   * 显式转换：@Type(() => Boolean) 对 'false' 字符串会误判为 true，与 query-document.dto 同因
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  all?: boolean;

  /** 按状态过滤（与 all 互斥时以 status 为准） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
