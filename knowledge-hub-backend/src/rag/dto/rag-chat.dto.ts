import { Type } from 'class-transformer';
import { IsString, IsOptional, IsInt, Min, Max, Length } from 'class-validator';

/** AI 问答请求体（POST /ai/chat，SSE 流式响应） */
export class RagChatDto {
  /** 用户问题 */
  @IsString()
  @Length(1, 500)
  question!: string;

  /** 检索上下文片段数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  top_k: number = 5;
}
