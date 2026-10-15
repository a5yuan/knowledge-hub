import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhCategory } from './entities/kh-category.entity';
import { KhDocument } from '../document/entities/document.entity';
import { CreateCategoryDto, QueryCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 分类字典服务（17 号工单）：扁平字典 CRUD（软删）
 * 雪花ID 应用侧生成；重名兜底：23505 UNIQUE → 400
 */
@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhCategory)
    private readonly categoryRepo: Repository<KhCategory>,
    @InjectRepository(KhDocument)
    private readonly docRepo: Repository<KhDocument>,
  ) {}

  /**
   * 分类列表，按 sort ASC, created_at ASC。
   * 默认仅返回启用分类（status=1）；?all=true 返回全部（后台管理页需要看到已禁用项）
   */
  async findAll(query: QueryCategoryDto) {
    const where: FindOptionsWhere<KhCategory> = { deleted: false };
    if (query.status !== undefined) {
      where.status = query.status;
    } else if (!query.all) {
      where.status = 1;
    }
    return this.categoryRepo.find({ where, order: { sort: 'ASC', created_at: 'ASC' } });
  }

  /** 分类详情（未删），404 兜底 */
  async findOne(id: string) {
    return this.findByIdOrFail(id);
  }

  /** 创建分类：重名/重复编码（23505）→ 400 */
  async create(dto: CreateCategoryDto, user?: AuthUser) {
    const id = this.snowflake.generate();
    try {
      await this.categoryRepo.save(
        this.categoryRepo.create({
          id,
          category_name: dto.category_name.trim(),
          category_code: dto.category_code?.trim() || null,
          sort: dto.sort ?? 0,
          status: dto.status ?? 1,
          create_by: user?.userId ?? null,
          update_by: user?.userId ?? null,
        }),
      );
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new BadRequestException('分类名称或分类编码已存在');
      }
      throw err;
    }
    this.logger.log(`分类创建成功 categoryId=${id} name=${dto.category_name}`);
    return this.findByIdOrFail(id);
  }

  /** 更新分类（部分更新），重名（23505）→ 400 */
  async update(id: string, dto: UpdateCategoryDto, user?: AuthUser) {
    const category = await this.findByIdOrFail(id);
    if (dto.category_name !== undefined) category.category_name = dto.category_name.trim();
    if (dto.category_code !== undefined) category.category_code = dto.category_code.trim() || null;
    if (dto.sort !== undefined) category.sort = dto.sort;
    if (dto.status !== undefined) category.status = dto.status;
    category.update_by = user?.userId ?? null;
    try {
      await this.categoryRepo.save(category);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new BadRequestException('分类名称或分类编码已存在');
      }
      throw err;
    }
    this.logger.log(`分类更新成功 categoryId=${category.id}`);
    return this.findByIdOrFail(category.id);
  }

  /**
   * 删除分类（软删）：有文档引用时拒绝。
   * 与 16 号工单的目录删除同策略 —— 拒绝而非级联置空，避免文档 category_id 悬空。
   */
  async remove(id: string) {
    const category = await this.findByIdOrFail(id);
    const docCount = await this.docRepo.count({
      where: { category_id: category.id, deleted: false },
    });
    if (docCount > 0) {
      throw new BadRequestException(`该分类下还有 ${docCount} 篇文档，请先移出`);
    }
    await this.categoryRepo.update({ id: category.id }, { deleted: true });
    this.logger.log(`分类已删除（软删）categoryId=${category.id}`);
    return { id: category.id, message: '分类已删除' };
  }

  /** 依据 id 定位未删分类，不存在 → 404 */
  private async findByIdOrFail(id: string): Promise<KhCategory> {
    const categoryId = normalizeSnowflakeId(id, 'id');
    const category = await this.categoryRepo.findOne({
      where: { id: categoryId, deleted: false },
    });
    if (!category) {
      throw new NotFoundException(`分类 ${categoryId} 不存在`);
    }
    return category;
  }
}
