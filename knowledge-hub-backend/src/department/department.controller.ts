import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DepartmentService } from './department.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { QueryDepartmentDto } from './dto/query-department.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 部门模块接口（/department，遵循现有单数前缀约定）：
 * - 读接口仅需登录：部门名是全站下拉/文档分区/个人中心的数据源，属组织公开信息
 * - 写接口挂 @RequirePermission('org:manage')（Admin 经 PermissionsGuard 旁路）
 *
 * ⚠️ 路由顺序陷阱：`@Get('tree')` 必须声明在 `@Get(':id')` **之前**，
 *    否则 'tree' 会被当成 id 吞进 findOne（AGENTS.md 硬约定，/document/reviews/* 踩过同一个坑）
 */
@Controller('department')
export class DepartmentController {
    constructor(private readonly departmentService: DepartmentService) {}

    /** 部门平铺列表：缺省只返启用（下拉用）；?all=true 返全部（管理页用） */
    @Get()
    findAll(@Query() query: QueryDepartmentDto) {
        return this.departmentService.findAll(query);
    }

    /** 部门树（三层嵌套）。★ 声明顺序必须在 @Get(':id') 之前 */
    @Get('tree')
    findTree(@Query() query: QueryDepartmentDto) {
        return this.departmentService.findTree(query);
    }

    /** 部门详情 */
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.departmentService.findOne(id);
    }

    /** 创建部门：parent_id 缺省 0（根）；第 4 层返回 400 */
    @RequirePermission('org:manage')
    @Post()
    create(@Body() dto: CreateDepartmentDto, @CurrentUser() user: AuthUser) {
        return this.departmentService.create(dto, user);
    }

    /** 更新部门（改名 / 改编码 / 改排序 / 改状态） */
    @RequirePermission('org:manage')
    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() dto: UpdateDepartmentDto,
        @CurrentUser() user: AuthUser,
    ) {
        return this.departmentService.update(id, dto, user);
    }

    /** 删除部门（软删）：有子部门或有用户归属返回 400 */
    @RequirePermission('org:manage')
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.departmentService.remove(id);
    }
}
