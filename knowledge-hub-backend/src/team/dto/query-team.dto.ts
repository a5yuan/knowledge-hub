import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 查询团队列表的过滤与分页参数（GET query，URL 参数均为字符串，需 @Type 转换） */
export class QueryTeamDto {
  /** 团队名称（模糊匹配） */
  @IsOptional()
  @IsString()
  team_name?: string;

  /** 团队编码（精确匹配） */
  @IsOptional()
  @IsString()
  team_code?: string;

  /** 负责人用户ID */
  @IsOptional()
  @IsString()
  leader_id?: string;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;

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
