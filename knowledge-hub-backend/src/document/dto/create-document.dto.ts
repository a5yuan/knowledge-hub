import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsDateString,
  IsArray,
  Min,
} from 'class-validator';

/**
 * 创建文档请求体（对应 kh_document 元数据；正文字段后续由服务层写 MongoDB document_content）
 * 雪花ID字段（category_id/team_id/author_id）必须为字符串，避免 JS Number 精度丢失
 */
export class CreateDocumentDto {
  /** 文档标题 */
  @IsString()
  title: string;

  /** 文档摘要 */
  @IsOptional()
  @IsString()
  summary?: string;

  /** 所属分类ID（雪花ID） */
  @IsOptional()
  @IsString()
  category_id?: string;

  /**
   * 所属目录ID（雪花ID；16 号工单）
   * 显式允许 null：PATCH 传 null 表示「移回根目录」（@IsOptional 对 null 跳过 @IsString 校验）
   */
  @IsOptional()
  @IsString()
  folder_id?: string | null;

  /** 所属团队ID（雪花ID） */
  @IsOptional()
  @IsString()
  team_id?: string;

  /** 作者ID（雪花ID） */
  @IsOptional()
  @IsString()
  author_id?: string;

  /** 创建人ID（雪花ID） */
  @IsOptional()
  @IsString()
  create_by?: string;

  /** 封面图 URL */
  @IsOptional()
  @IsString()
  cover_image?: string;

  /**
   * 标签（逗号分隔或 JSON 字符串）
   * @deprecated 17 号工单 D 方案：该列降级为**派生只读字段**（由关联表同步）。
   * 写侧已忽略本字段，请改用 `tag_ids`。字段保留仅为不破坏既有调用方的请求体校验。
   */
  @IsOptional()
  @IsString()
  tags?: string;

  /**
   * 标签ID列表（雪花ID；17 号工单）
   * 写侧唯一真相源是 kh_document_tag 关联表 —— 传本字段即**整体替换**该文档的标签关联；
   * 不传（undefined）表示「不改动标签」，传空数组表示「清空标签」。
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tag_ids?: string[];

  /** 文档状态：0=草稿, 1=已发布, 2=待审核, 3=已归档（审核开启时携带 1 会被拒绝，发布走 /publish 提审） */
  @IsOptional()
  @IsInt()
  @Min(0)
  status?: number;

  /** 备注 */
  @IsOptional()
  @IsString()
  remark?: string;

  /** 发布时间（ISO 8601 字符串） */
  @IsOptional()
  @IsDateString()
  publish_time?: string;

  /** 是否公开 */
  @IsOptional()
  @IsBoolean()
  is_public?: boolean;
}
