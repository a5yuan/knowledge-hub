import { Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Length,
    Max,
    Min,
} from 'class-validator';

/**
 * 创建公告入参（21 号工单）。
 *
 * ⚠️ 刻意**不暴露** `publish_time` / `expire_time`：
 * - 时间列必须由 DB 侧写入（`NOW()`）才能与本库其它 `created_at` 保持同一时钟基准，
 *   若允许前端传 ISO 字符串，node-postgres 会按本地字段序列化，混入本地字面（8 小时坑）。
 * - 「立即发布 / 长期有效」已经是默认行为，前端没有设置它们的真实需求；
 *   需要定时发布或过期时，走 SQL 维护（验收标准就要求手工设 `expire_time` 验证过滤）。
 */
export class CreateAnnouncementDto {
    /** 标题 */
    @IsString()
    @Length(1, 200)
    title: string;

    /** 正文（纯文本；富文本渲染不在本工单范围） */
    @IsString()
    @Length(1, 20000)
    content: string;

    /** 状态：0 停用 / 1 启用，缺省 1 */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn([0, 1])
    status?: number;

    /** 排序（升序，越小越靠前），缺省 0 */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(9999)
    sort?: number;
}
