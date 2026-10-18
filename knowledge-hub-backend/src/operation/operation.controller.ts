import { Controller, Get, Query } from '@nestjs/common';
import { OperationService } from './operation.service';
import { QueryOperationLogDto } from './dto/query-operation-log.dto';

/**
 * 操作日志接口（/operation，单数前缀）。
 *
 * ★ **只读**：不提供 POST / PATCH / DELETE。
 * 允许外部 POST 日志 = 允许伪造审计记录 —— 日志只能由 service 内部埋点产生。
 *
 * 权限：仅需登录（大盘对全员可见，spec §5.4）。
 */
@Controller('operation')
export class OperationController {
  constructor(private readonly operationService: OperationService) {}

  /** 操作日志分页（created_at DESC），支持 action / user_id / target_type 三筛选 */
  @Get()
  findAll(@Query() query: QueryOperationLogDto) {
    return this.operationService.findAll(query);
  }
}
