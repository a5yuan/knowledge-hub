import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** 目录分区（仅三值；archive 是文档状态不是分区，见 16 号工单「与 zone 的关系」） */
export const FOLDER_ZONES = ['mine', 'public', 'department'] as const;
export type FolderZone = (typeof FOLDER_ZONES)[number];

/** 创建目录参数（kh_folder；folder_name + zone 必填，其余可选） */
export class CreateFolderDto {
  /** 目录名称（必填） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  folder_name: string;

  /** 分区（必填，仅三值） */
  @IsIn(FOLDER_ZONES)
  zone: FolderZone;

  /** 父目录ID（可选，缺省 0 为根） */
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
