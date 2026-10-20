import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { AnnouncementService } from './announcement.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { QueryAnnouncementDto } from './dto/query-announcement.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 公告模块接口（`/announcement`，遵循现有单数前缀约定）。
 *
 * - 读接口仅需登录：大盘与公告栏都要能读，不设权限码
 * - 写接口挂 `announcement:manage`（ADMIN 经 PermissionsGuard 旁路）
 */
@Controller('announcement')
export class AnnouncementController {
    constructor(private readonly announcementService: AnnouncementService) {}

    /**
     * 公告列表。
     * `?enabled=true` = 前台语义（启用 + 已到发布时间 + 未过期）；不传 = 全部（管理页用）。
     */
    @Get()
    findAll(@Query() query: QueryAnnouncementDto) {
        return this.announcementService.findAll(query);
    }

    /** 公告详情，404 兜底 */
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.announcementService.findOne(id);
    }

    /** 新建公告（需 announcement:manage）：publish_time 缺省立即发布 */
    @RequirePermission('announcement:manage')
    @Post()
    create(@Body() dto: CreateAnnouncementDto, @CurrentUser() user: AuthUser) {
        return this.announcementService.create(dto, user);
    }

    /** 更新公告（需 announcement:manage）：改标题 / 正文 / 启停 / 排序 */
    @RequirePermission('announcement:manage')
    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() dto: UpdateAnnouncementDto,
        @CurrentUser() user: AuthUser,
    ) {
        return this.announcementService.update(id, dto, user);
    }

    /** 删除公告（需 announcement:manage）：软删 */
    @RequirePermission('announcement:manage')
    @Delete(':id')
    remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
        return this.announcementService.remove(id, user);
    }
}
