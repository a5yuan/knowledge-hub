import { IsIn, IsOptional } from 'class-validator';

/**
 * 趋势时间范围（与前端 `TrendRange` 一一对应）。
 * `today` = 24 个小时桶；`7d` / `30d` = 7 / 30 个天桶（含今天）。
 */
export const TREND_RANGES = ['today', '7d', '30d'] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** 大盘统计查询参数（GET /stats/dashboard） */
export class QueryStatsDto {
  /** 趋势范围，缺省近 7 日 */
  @IsOptional()
  @IsIn(TREND_RANGES)
  range: TrendRange = '7d';
}
