import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 查询公告列表的过滤与分页参数（21 号工单）。
 *
 * `enabled` 是三态的信号：
 * - 不传        → 返回全部（含停用、过期），管理页用
 * - `true`      → 仅启用 + 未过期 + 已到发布时间，前台大盘用
 * - `false`     → 仅停用
 *
 * 布尔转换必须手写：`@Type(() => Boolean)` 会把字符串 `'false'` 判成 `true`。
 */
export class QueryAnnouncementDto {
    /** 是否启用（见类注释的三态语义） */
    @IsOptional()
    @Transform(({ value }) =>
        value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
    )
    @IsBoolean()
    enabled?: boolean;

    /** 标题模糊匹配（管理页搜索用） */
    @IsOptional()
    @IsString()
    title?: string;

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
