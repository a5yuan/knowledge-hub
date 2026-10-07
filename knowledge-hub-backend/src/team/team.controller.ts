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
import { TeamService } from './team.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { QueryTeamDto } from './dto/query-team.dto';
import { AddTeamMemberDto, UpdateMemberRoleDto } from './dto/team-member.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 团队模块接口（/team，遵循现有单数前缀约定）：
 * - 团队 CRUD + 成员管理（增删查改）
 * - 读接口仅需登录；写接口标注 @RequirePermission（team:create/edit/delete/member，Admin 旁路）
 */
@Controller('team')
export class TeamController {
    constructor(private readonly teamService: TeamService) {}

    /** 创建团队（需权限码 team:create）：leader_id 缺省为当前登录用户 */
    @RequirePermission('team:create')
    @Post()
    create(@Body() dto: CreateTeamDto, @CurrentUser() user: AuthUser) {
        return this.teamService.create(dto, user);
    }

    /** 分页查询团队（需登录）：team_name 模糊 / team_code / leader_id / status */
    @Get()
    findAll(@Query() query: QueryTeamDto) {
        return this.teamService.findAll(query);
    }

    /** 团队详情（需登录），404 兜底 */
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.teamService.findOne(id);
    }

    /** 更新团队（需权限码 team:edit）：部分更新 + status 启停 */
    @RequirePermission('team:edit')
    @Patch(':id')
    update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
        return this.teamService.update(id, dto);
    }

    /** 删除团队（需权限码 team:delete，种子未授权任何角色，仅 Admin 旁路可删） */
    @RequirePermission('team:delete')
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.teamService.remove(id);
    }

    /** 添加成员（需权限码 team:member）：重复添加 409 */
    @RequirePermission('team:member')
    @Post(':id/members')
    addMember(@Param('id') id: string, @Body() dto: AddTeamMemberDto) {
        return this.teamService.addMember(id, dto);
    }

    /** 成员列表（需登录）：联 kh_user 返回 username/realName */
    @Get(':id/members')
    listMembers(@Param('id') id: string) {
        return this.teamService.listMembers(id);
    }

    /** 调整成员角色（需权限码 team:member）：leader/member 互切 */
    @RequirePermission('team:member')
    @Patch(':id/members/:userId')
    updateMemberRole(
        @Param('id') id: string,
        @Param('userId') userId: string,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        return this.teamService.updateMemberRole(id, userId, dto.member_role);
    }

    /** 移除成员（需权限码 team:member）：关联行硬删 */
    @RequirePermission('team:member')
    @Delete(':id/members/:userId')
    removeMember(@Param('id') id: string, @Param('userId') userId: string) {
        return this.teamService.removeMember(id, userId);
    }
}
