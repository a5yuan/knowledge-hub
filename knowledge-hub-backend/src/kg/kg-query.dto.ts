import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  Max,
  Length,
} from 'class-validator';
import { ENTITY_TYPES } from './extraction.service';

/** 图谱节点标签（通用节点查询） */
export const KG_NODE_LABELS = ['entity', 'document', 'chunk'] as const;

/** 图谱关系类型（通用关系查询，小写入参 → Cypher 大写关系名由 service 映射） */
export const KG_REL_TYPES = ['related_to', 'mentions', 'has_chunk'] as const;

/** 聚合搜索实体类型过滤口径（knowledge = tech/location/term/other 归并；document 仅作用于 docs 侧） */
export const KG_SEARCH_TYPES = ['person', 'org', 'knowledge', 'document'] as const;

/** ① 聚合关键词搜索（GET /kg/search?q=，URL 参数均为字符串，需 @Type 转换） */
export class KgSearchDto {
  /** 检索关键词（同时匹配 ES 文档与 Neo4j 实体/关系属性） */
  @IsString()
  @Length(1, 100)
  q!: string;

  /** 实体类型过滤：person/org 精确，knowledge 归并 tech/location/term/other，document 仅返回文档侧 */
  @IsOptional()
  @IsIn(KG_SEARCH_TYPES)
  type?: string;

  /** 页码，从 1 开始（三路结果共用分页参数） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** 聚合单路返回条数（docs/entities/edges 各取前 N 条） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize: number = 5;
}

/** ② 通用节点查询（GET /kg/nodes） */
export class NodeSearchDto {
  /** 节点标签 */
  @IsIn(KG_NODE_LABELS)
  label!: 'entity' | 'document' | 'chunk';

  /** 关键词（匹配对应节点属性；不传=该 label 全量分页） */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  /** 实体类型过滤（仅 label=entity 生效，其余忽略） */
  @IsOptional()
  @IsIn(ENTITY_TYPES)
  type?: string;

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
  @Max(50)
  pageSize: number = 10;
}

/** ③ 通用关系查询（GET /kg/edges） */
export class EdgeSearchDto {
  /** 关系类型 */
  @IsIn(KG_REL_TYPES)
  rel!: 'related_to' | 'mentions' | 'has_chunk';

  /** 实体名过滤（作用于边两端的 Entity 节点；has_chunk 无 Entity 端，忽略该参数） */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  entity?: string;

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
  @Max(50)
  pageSize: number = 10;
}

/** ④ 全景图谱总览（GET /kg/overview，二期工单 07） */
export class GetOverviewDto {
  /** 全量节点上限保护：超限按文档提及数降序截断实体（文档节点全保留），响应附 truncated */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(5000)
  limit: number = 2000;
}
