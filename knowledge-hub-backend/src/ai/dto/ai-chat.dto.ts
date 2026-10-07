import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** 会话式 AI 对话（POST /ai/sessions/messages，SSE 流式，二期工单 08） */
export class AiChatStreamDto {
  /** 用户问题（本轮输入） */
  @IsString()
  @Length(1, 500)
  content!: string;

  /** 会话 ID（不传 = 自动创建新会话，标题取首问前 20 字） */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** 模型选择（模型配置面板，随请求携带不落库） */
  @IsOptional()
  @IsIn(['qwen-plus', 'qwen-max', 'qwen-turbo'])
  model?: string;

  /** 采样温度 0-1（模型配置面板） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  temperature?: number;

  /** 深度思考：true 时切 qwen-plus-latest + enable_thinking，输出 reasoning 思考流（v2 协议） */
  @IsOptional()
  @Type(() => Boolean)
  @IsIn([true, false])
  enableThinking?: boolean;
}

/** 新建会话（显式创建；前端"新建对话"默认延迟到首条消息自动创建） */
export class AiSessionCreateDto {
  @IsString()
  @Length(1, 80)
  title!: string;
}
