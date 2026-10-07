import { Transform, Type } from 'class-transformer';
import { IsString, IsOptional, IsInt, Min, Max, Length, IsBoolean } from 'class-validator';

/** RAG 混合检索请求参数（GET /rag/search?q=，URL 参数均为字符串，需转换） */
export class RagSearchDto {
  /** 检索关键词 */
  @IsString()
  @Length(1, 100)
  q!: string;

  /** 返回的上下文片段数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  top_k: number = 5;

  /** 是否启用重排模型精排（显式转换：@Type(()=>Boolean) 对 'false' 字符串会误判为 true，故不用） */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  rerank: boolean = true;
}
