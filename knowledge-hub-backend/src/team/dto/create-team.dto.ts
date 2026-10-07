import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/** 创建团队参数（kh_team；team_name 必填，其余可选） */
export class CreateTeamDto {
  /** 团队名称（必填） */
  @IsString()
  team_name: string;

  /** 团队编码（可选） */
  @IsOptional()
  @IsString()
  team_code?: string;

  /** 描述（可选） */
  @IsOptional()
  @IsString()
  description?: string;

  /** 负责人用户ID（可选，缺省为当前登录用户） */
  @IsOptional()
  @IsString()
  leader_id?: string;

  /** 父团队ID（可选，0 为根） */
  @IsOptional()
  @IsString()
  parent_id?: string;

  /** 排序号（可选，默认 0） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;
}
