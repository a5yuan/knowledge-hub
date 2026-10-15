import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * 更新部门参数（全可选，仅传需改字段）。
 *
 * ⚠️ 刻意**不支持改 parent_id**：移动子树涉及「新父深度校验 + 环检测 + 子树整体深度重算」，
 * 与「改名 / 改排序」不是一个风险量级，需要时另开工单（本工单 create 已严格限深 ≤ 3）。
 */
export class UpdateDepartmentDto {
  /** 部门名称 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dept_name?: string;

  /** 部门编码 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dept_code?: string;

  /** 排序号 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
