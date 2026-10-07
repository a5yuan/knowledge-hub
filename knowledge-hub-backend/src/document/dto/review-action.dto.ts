import { IsOptional, IsString } from 'class-validator';

/**
 * 审核动作请求体（approve / reject 共用）
 * 审核人身份由全局 JwtAuthGuard 从 token 注入（@CurrentUser），不再信任请求体；
 * reject 时 comment 必填（service 层校验）
 */
export class ReviewActionDto {
  /** 审核意见（驳回必填） */
  @IsOptional()
  @IsString()
  comment?: string;
}
