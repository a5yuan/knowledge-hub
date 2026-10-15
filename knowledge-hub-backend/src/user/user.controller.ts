import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UserAdminService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 用户管理接口（管理端，/user 单数前缀）。
 *
 * ⚠️ 刻意**不挂到 /auth 下**：`/auth` 承载自助鉴权语义（register / login / refresh / 改自己的密码），
 * 管理端 CRUD 混进去会让前缀语义崩坏，也会让权限装饰器粒度变粗
 * （自助接口应 @Public 或仅登录，管理接口需 @RequirePermission）。
 *
 * 四路由无路径冲突（无 @Get(':id')），不需要顺序处理。
 */
@Controller('user')
export class UserController {
    constructor(private readonly userAdminService: UserAdminService) {}

    /** 用户分页列表（keyword / role / department_id / status 四筛选） */
    @RequirePermission('user:view')
    @Get()
    findAll(@Query() query: QueryUserDto) {
        return this.userAdminService.findAll(query);
    }

    /** 创建用户（密码 bcrypt 哈希；管理端代建不走邮件激活，可直接登录） */
    @RequirePermission('user:create')
    @Post()
    create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser) {
        return this.userAdminService.create(dto, user);
    }

    /** 更新用户（资料 / 角色 / 部门 / 状态 / 重置密码） */
    @RequirePermission('user:edit')
    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() dto: UpdateUserDto,
        @CurrentUser() user: AuthUser,
    ) {
        return this.userAdminService.update(id, dto, user);
    }

    /** 删除用户（软删）：不允许删自己、不允许删内置 admin */
    @RequirePermission('user:delete')
    @Delete(':id')
    remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
        return this.userAdminService.remove(id, user);
    }
}
