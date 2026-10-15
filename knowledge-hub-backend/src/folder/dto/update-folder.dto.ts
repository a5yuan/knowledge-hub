import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** 更新目录参数（改名 / 改排序；父目录不可改，移动目录另开工单） */
export class UpdateFolderDto {
  /** 目录名称（可选） */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  folder_name?: string;

  /** 排序号（可选） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort?: number;
}
