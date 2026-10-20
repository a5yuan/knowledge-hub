import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** 更新公告入参：全部字段可选，只改传了的（21 号工单） */
export class UpdateAnnouncementDto {
    /** 标题 */
    @IsOptional()
    @IsString()
    @Length(1, 200)
    title?: string;

    /** 正文 */
    @IsOptional()
    @IsString()
    @Length(1, 20000)
    content?: string;

    /** 状态：0 停用 / 1 启用（停用后大盘立即不可见） */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn([0, 1])
    status?: number;

    /** 排序 */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(9999)
    sort?: number;
}
