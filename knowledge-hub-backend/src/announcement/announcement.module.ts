import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { KhAnnouncement } from './entities/kh-announcement.entity';
import { OperationModule } from '../operation/operation.module';

/**
 * 公告模块（21 号工单）。
 *
 * 只依赖自身仓库 + OperationModule（审计埋点）—— 不依赖 UserModule，
 * 创建人 `create_by` 直接取 `@CurrentUser()` 的 userId，避免为拿用户名引入模块环。
 */
@Module({
    imports: [TypeOrmModule.forFeature([KhAnnouncement]), OperationModule],
    controllers: [AnnouncementController],
    providers: [AnnouncementService],
})
export class AnnouncementModule {}
