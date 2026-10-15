import { IsIn, IsOptional, IsString } from 'class-validator';
import { FOLDER_ZONES, type FolderZone } from './create-folder.dto';

/** 查询目录列表的过滤参数（GET query，URL 参数均为字符串） */
export class QueryFolderDto {
  /** 分区（必填，仅三值） */
  @IsIn(FOLDER_ZONES)
  zone: FolderZone;

  /**
   * 父目录ID（可选）。
   * 不传 → 返回该分区下全部未删目录（前端 buildFolderTree 一次拉全量建树）；
   * 传值 → 仅返回该父级的直接子节点。
   * 注意：即便传 '0'（根），也必须走字符串比较，不能依赖真值判断。
   */
  @IsOptional()
  @IsString()
  parent_id?: string;
}
