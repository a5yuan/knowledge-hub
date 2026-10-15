import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** 部门列表查询参数 */
export class QueryDepartmentDto {
  /**
   * 是否返回禁用部门：缺省只返启用（全站下拉数据源）；
   * 管理页传 all=true 取全部（否则禁用部门在管理页"消失"，无法再启用）
   *
   * 显式转换：@Type(() => Boolean) 对 'false' 字符串会误判为 true，故不用
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  all?: boolean;
}
