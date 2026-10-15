import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

/** 标签排序字段（默认按热度倒序） */
export const TAG_SORTS = ['use_count', 'tag_name', 'created_at'] as const;
export type TagSort = (typeof TAG_SORTS)[number];

/**
 * 标签字典 DTO（17 号工单）
 * POST /tag 为幂等「按名 get-or-create」：已存在直接返回，不报错
 */
export class CreateTagDto {
  /** 标签名称（未删行唯一；已存在则原样返回，不新建） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tag_name: string;
}

export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tag_name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class QueryTagDto {
  /** 名称前缀搜索（如 ?q=Nes 命中 NestJS） */
  @IsOptional()
  @IsString()
  q?: string;

  /** 排序字段：use_count（默认，倒序）/ tag_name / created_at */
  @IsOptional()
  @IsIn(TAG_SORTS)
  sort?: TagSort;

  /** 状态过滤 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;

  /** 返回条数上限（标签总量小，默认一次给足，避免选择器分页） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
