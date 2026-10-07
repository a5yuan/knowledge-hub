import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  Length,
  IsIn,
  IsBoolean,
  IsArray,
} from 'class-validator';

/** 全文检索请求参数（GET /search?q=，URL 参数均为字符串，需 @Type 转换） */
export class SearchQueryDto {
  /** 检索关键词（对 title/summary/content 做中文分词检索） */
  @IsString()
  @Length(1, 100)
  q!: string;

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
  @Max(50)
  pageSize: number = 10;

  /** 多词匹配方式：or=任一命中（默认），and=全部命中 */
  @IsOptional()
  @IsIn(['or', 'and'])
  operator: 'or' | 'and' = 'or';

  /** filter：文档状态 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  status?: number;

  /** filter：可见性（显式转换：@Type(()=>Boolean) 对 'false' 字符串会误判为 true，故不用） */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  is_public?: boolean;

  /** filter：分类 */
  @IsOptional()
  @IsString()
  category_id?: string;

  /** filter：团队 */
  @IsOptional()
  @IsString()
  team_id?: string;

  /** filter：作者 */
  @IsOptional()
  @IsString()
  author_id?: string;

  /** filter：标签（多 tag 取交集）；支持 ?tags=A,B 逗号分隔与 ?tags=A&tags=B 重复参数 */
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
