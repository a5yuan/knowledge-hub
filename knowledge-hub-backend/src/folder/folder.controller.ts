import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { FolderService } from './folder.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { QueryFolderDto } from './dto/query-folder.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 目录模块接口（/folder，遵循现有单数前缀约定）：
 * - 目录 CRUD（树形，软删）
 * - 仅需登录：目录操作属文档域常规能力，不进入 RBAC 收敛范围（16 号工单决策）
 * - 四路由无路径冲突（无 @Get(':id')），不需要顺序处理
 */
@Controller('folder')
export class FolderController {
    constructor(private readonly folderService: FolderService) {}

    /** 目录列表：zone 必填，parent_id 可选（不传返回该分区全部未删目录） */
    @Get()
    findAll(@Query() query: QueryFolderDto) {
        return this.folderService.findAll(query);
    }

    /** 创建目录：parent_id 缺省 0（根）；mine 分区自动归属当前登录用户 */
    @Post()
    create(@Body() dto: CreateFolderDto, @CurrentUser() user: AuthUser) {
        return this.folderService.create(dto, user);
    }

    /** 更新目录（改名 / 改排序） */
    @Patch(':id')
    update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @CurrentUser() user: AuthUser) {
        return this.folderService.update(id, dto, user);
    }

    /** 删除目录（软删）：有子目录或有文档挂载返回 400 */
    @Delete(':id')
    remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
        return this.folderService.remove(id, user);
    }
}
