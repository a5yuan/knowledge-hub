import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';

/**
 * 查询文档列表的过滤与分页参数（GET query，URL 参数均为字符串，需 @Type 转换）
 */
export class QueryDocumentDto {
  /** 文档ID（雪花ID） */
  @IsOptional()
  @IsString()
  id?: string;

  /** 标题（模糊匹配） */
  @IsOptional()
  @IsString()
  title?: string;

  /** 分类ID（雪花ID） */
  @IsOptional()
  @IsString()
  category_id?: string;

  /** 团队ID（雪花ID） */
  @IsOptional()
  @IsString()
  team_id?: string;

  /** 作者ID（雪花ID） */
  @IsOptional()
  @IsString()
  author_id?: string;

  /** 标签 */
  @IsOptional()
  @IsString()
  tags?: string;

  /** 状态：0=草稿, 1=已发布, 2=已归档 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  status?: number;

  /** 是否公开（显式转换：@Type(()=>Boolean) 对 'false' 字符串会误判为 true，故不用） */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  is_public?: boolean;

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
