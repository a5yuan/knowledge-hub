import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, QueryCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 分类字典接口（/category，遵循现有单数前缀约定）
 * - 读接口仅需登录（文档编辑弹窗/搜索页筛选器都要拉分类列表）
 * - 写接口需权限码 doc:meta:category（Admin 旁路）
 */
@Controller('category')
export class CategoryController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /** 分类列表（需登录）：默认仅启用；?all=true 返回全部（后台管理） */
  @Get()
  findAll(@Query() query: QueryCategoryDto) {
    return this.categoriesService.findAll(query);
  }

  /** 创建分类（需权限码 doc:meta:category）：重名 → 400 */
  @RequirePermission('doc:meta:category')
  @Post()
  create(@Body() dto: CreateCategoryDto, @CurrentUser() user: AuthUser) {
    return this.categoriesService.create(dto, user);
  }

  /** 更新分类（需权限码 doc:meta:category）：改名 / 改编码 / 启停 / 排序 */
  @RequirePermission('doc:meta:category')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @CurrentUser() user: AuthUser) {
    return this.categoriesService.update(id, dto, user);
  }

  /** 删除分类（需权限码 doc:meta:category，软删）：有文档引用时拒绝 */
  @RequirePermission('doc:meta:category')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
