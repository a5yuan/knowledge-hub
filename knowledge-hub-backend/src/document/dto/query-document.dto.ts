import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from 'class-validator';

/**
 * 文档分区（18 号工单）：mine / public / department / archive。
 *
 * 注意：**只有 `department` 由后端解析**（依赖当前登录用户的 department_id，见 document.service.findAll）。
 * 其余三值历史上一直由前端翻译成 author_id / is_public / status（见 src/api/adapters/document.ts
 * toBackendListQuery），后端接受但忽略，仅为契约完整性与不 400 保留。
 */
export const DOCUMENT_ZONES = ['mine', 'public', 'department', 'archive'] as const;
export type DocumentZone = (typeof DOCUMENT_ZONES)[number];

/**
 * 查询文档列表的过滤与分页参数（GET query，URL 参数均为字符串，需 @Type 转换）
 */
export class QueryDocumentDto {
  /** 文档ID（雪花ID） */
  @IsOptional()
  @IsString()
  id?: string;

  /** 标题（模糊匹配） */
  @IsOptional()
  @IsString()
  title?: string;

  /** 分类ID（雪花ID） */
  @IsOptional()
  @IsString()
  category_id?: string;

  /** 目录ID（雪花ID；16 号工单按目录筛选） */
  @IsOptional()
  @IsString()
  folder_id?: string;

  /** 团队ID（雪花ID） */
  @IsOptional()
  @IsString()
  team_id?: string;

  /** 作者ID（雪花ID） */
  @IsOptional()
  @IsString()
  author_id?: string;

  /** 标签 */
  @IsOptional()
  @IsString()
  tags?: string;

  /** 分区（18 号工单）：仅 `department` 生效 —— 按「文档作者所属部门 = 当前用户所属部门」过滤 */
  @IsOptional()
  @IsIn(DOCUMENT_ZONES)
  zone?: DocumentZone;

  /** 状态：0=草稿, 1=已发布, 2=已归档 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  status?: number;

  /** 是否公开（显式转换：@Type(()=>Boolean) 对 'false' 字符串会误判为 true，故不用） */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  is_public?: boolean;

  /**
   * 排除已归档（20 号工单验收补齐）。
   *
   * 为什么需要它：`status` 只能表达「等于某值」，无法表达「不等于归档」。
   * 前端 `mine` / `public` 分区历史上只能发 `author_id` / `is_public`，于是已归档行会混进结果，
   * 后端 `total` 把它们算进去，而 `GET /stats/mine` 的 `docCount` 按工单口径排除归档 ——
   * 两处数字对不上，用户会以为掉数据。
   *
   * 前端在 `toBackendListQuery` 里对 mine/public 恒传 `exclude_archived=true`，
   * 让 `total` 与展示行数、与 `docCount` 三者一致。
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' ? true : value === false || value === 'false' ? false : value,
  )
  @IsBoolean()
  exclude_archived?: boolean;

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
