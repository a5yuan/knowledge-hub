import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { KhDocument } from '../document/entities/document.entity';
import { KhUser } from '../auth/entities/kh-user.entity';
import { KhOperationLog } from '../operation/entities/kh-operation-log.entity';

/**
 * 大盘聚合模块（20 号工单）。
 *
 * 三张表跨域 `forFeature` 注册（不导入 DocumentModule / UserModule / OperationModule）：
 * 聚合层本来就是跨域只读，直接注入仓库既省依赖也彻底规避循环依赖。
 *
 * `KhOperationLog` 用于 `searchCount`（20 号工单在 `SearchController` 补了 `search` 埋点）；
 * `KhUser.last_login_at` 用于 `activeUsers`（18 号工单在登录成功路径写入）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KhDocument, KhUser, KhOperationLog])],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
