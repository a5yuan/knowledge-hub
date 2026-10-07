import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { TeamModule } from '../team/team.module';

/** 全文检索模块：DocIndexService 由全局 EsModule 提供；TeamModule 供可见性作用域派生（09 号工单） */
@Module({
  imports: [TeamModule],
  controllers: [SearchController],
})
export class SearchModule {}
