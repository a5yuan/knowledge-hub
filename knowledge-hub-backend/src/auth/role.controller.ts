import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RoleService } from './role.service';
import {
  AssignRolePermissionsDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/role.dto';

/**
 * 角色管理接口（权限模型控制工单，仅登录校验——接口权限本期不做，不加 @RequirePermission）
 * 注意：permission-tree / list 字面量路由必须声明在 :id 参数路由之前，避免被参数匹配吞掉
 */
@Controller('role')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  /** 全量权限树（角色授权弹窗数据源，不含 type=3 接口权限） */
  @Get('permission-tree')
  permissionTree() {
    return this.roleService.getPermissionTree();
  }

  /** 角色分页列表 */
  @Get('list')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.roleService.findRoles(Number(page) || 1, Number(pageSize) || 10);
  }

  /** 新建角色 */
  @Post()
  create(@Body() dto: CreateRoleDto) {
    return this.roleService.createRole(dto);
  }

  /** 编辑角色（名称/描述/状态开关） */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.updateRole(id, dto);
  }

  /** 删除角色（内置角色 400） */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.roleService.deleteRole(id);
  }

  /** 角色已授权限ID列表（弹窗回显） */
  @Get(':id/permissions')
  rolePermissions(@Param('id') id: string) {
    return this.roleService.getRolePermissionIds(id);
  }

  /** 保存角色权限（全量覆盖） */
  @Put(':id/permissions')
  assignPermissions(
    @Param('id') id: string,
    @Body() dto: AssignRolePermissionsDto,
  ) {
    return this.roleService.assignRolePermissions(id, dto);
  }
}
