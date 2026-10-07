import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { CreateTeamDto } from './create-team.dto';

/** 更新团队参数：创建参数全部可选 + 状态启停 */
export class UpdateTeamDto extends PartialType(CreateTeamDto) {
  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
