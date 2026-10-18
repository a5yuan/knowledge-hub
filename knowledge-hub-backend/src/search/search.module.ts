import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { TeamModule } from '../team/team.module';
import { OperationModule } from '../operation/operation.module';

/**
 * 全文检索模块：DocIndexService 由全局 EsModule 提供；TeamModule 供可见性作用域派生（09 号工单）；
 * OperationModule 供 search 审计埋点（20 号工单：大盘 searchCount 的数据源）。
 */
@Module({
  imports: [TeamModule, OperationModule],
  controllers: [SearchController],
})
export class SearchModule {}
