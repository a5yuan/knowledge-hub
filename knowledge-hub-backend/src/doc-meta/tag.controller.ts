import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto, QueryTagDto, UpdateTagDto } from './dto/tag.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 标签字典接口（/tag，遵循现有单数前缀约定）
 *
 * ⚠️ POST /tag **刻意不挂 @RequirePermission**：
 * 它是文档编写流程的一环（DocMetaFields.vue 的 allow-create 自由输入会即时创建标签），
 * 挂上权限码会让普通用户的新建文档流程直接 403。改/删才是管理动作，挂 doc:meta:tag。
 */
@Controller('tag')
export class TagController {
  constructor(private readonly tagsService: TagsService) {}

  /** 标签列表（需登录）：默认按热度倒序；?q=Nes 前缀匹配；?sort=tag_name 切换排序 */
  @Get()
  findAll(@Query() query: QueryTagDto) {
    return this.tagsService.findAll(query);
  }

  /** 按名 get-or-create（需登录，**幂等**）：已存在原样返回，供自由输入创建标签 */
  @Post()
  createOrGet(@Body() dto: CreateTagDto, @CurrentUser() user: AuthUser) {
    return this.tagsService.createOrGet(dto, user);
  }

  /** 更新标签（需权限码 doc:meta:tag）：改名 / 启停 */
  @RequirePermission('doc:meta:tag')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTagDto, @CurrentUser() user: AuthUser) {
    return this.tagsService.update(id, dto, user);
  }

  /** 删除标签（需权限码 doc:meta:tag，软删）：关联行保留，历史文档仍能解析标签名 */
  @RequirePermission('doc:meta:tag')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tagsService.remove(id);
  }
}
