import { Transform, Type } from 'class-transformer';
import { IsString, IsOptional, IsInt, Min, Max, Length, IsBoolean, IsIn } from 'class-validator';

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

  /**
   * 检索消融开关（对照实验用，默认 hybrid = 生产行为）：
   * hybrid=双路+RRF / hybrid_weighted=双路+分数归一化加权求和（对照臂） / bm25=仅关键词路 / knn=仅向量路
   */
  @IsOptional()
  @IsIn(['hybrid', 'hybrid_weighted', 'bm25', 'knn'])
  mode: 'hybrid' | 'hybrid_weighted' | 'bm25' | 'knn' = 'hybrid';
}
