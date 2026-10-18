import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  OPERATION_ACTIONS,
  OPERATION_TARGET_TYPES,
  type OperationAction,
  type OperationTargetType,
} from './create-operation-log.dto';

/** 操作日志查询参数（GET /operation，URL 参数均为字符串，需 @Type 转换） */
export class QueryOperationLogDto {
  /** 动作筛选（白名单校验：非法 action 直接 400，而不是静默返回空页） */
  @IsOptional()
  @IsIn(OPERATION_ACTIONS)
  action?: OperationAction;

  /** 操作人筛选（雪花 ID 字符串） */
  @IsOptional()
  @IsString()
  user_id?: string;

  /** 目标类型筛选 */
  @IsOptional()
  @IsIn(OPERATION_TARGET_TYPES)
  target_type?: OperationTargetType;

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
