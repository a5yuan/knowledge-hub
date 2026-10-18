import { Controller, Get, Query } from '@nestjs/common';
import { StatsService } from './stats.service';
import { QueryStatsDto } from './dto/query-stats.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 大盘统计接口（/stats，注意前缀是复数 stats，不是 stat）。
 *
 * 两个固定段路由（`dashboard` / `mine`），**没有 `@Get(':id')`**，无路由吞并风险；
 * 若将来新增 `:id`，这两个必须声明在前。
 *
 * 权限：仅需登录。大盘对全员可见（spec §5.4）；`mine` 天然只能看自己（userId 取自 token）。
 */
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /** 首页大盘：4 个总数 + 趋势（range=today/7d/30d）+ 分类分布 */
  @Get('dashboard')
  dashboard(@Query() query: QueryStatsDto) {
    return this.statsService.dashboard(query);
  }

  /** 个人中心：本人未归档文档数与总体积（口径与「我的文档」列表一致） */
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.statsService.mine(user);
  }
}
