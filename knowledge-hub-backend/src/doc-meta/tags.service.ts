import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsOrder, FindOptionsWhere, In, Like, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhTag } from './entities/kh-tag.entity';
import { KhDocumentTag } from './entities/kh-document-tag.entity';
import { KhDocument } from '../document/entities/document.entity';
import { CreateTagDto, QueryTagDto, UpdateTagDto } from './dto/tag.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 标签字典服务（17 号工单）
 *
 * ⚠️ 铁律（D 方案）：kh_document_tag 是标签归属的唯一真相源。
 * 任何读标签的代码路径都不允许解析 kh_document.tags 串 —— 那只是写侧同步出来的派生值，
 * 仅供 ES / RAG 文本匹配与向后兼容。一旦某处图省事 split(','), 双写就失去意义。
 */
@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhTag)
    private readonly tagRepo: Repository<KhTag>,
    @InjectRepository(KhDocumentTag)
    private readonly docTagRepo: Repository<KhDocumentTag>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 标签列表：默认按热度（use_count DESC）；?q= 前缀匹配名称；?sort= 切换排序
   * 标签总量小，默认一次给足（limit 上限 500），避免选择器分页
   */
  async findAll(query: QueryTagDto) {
    const where: FindOptionsWhere<KhTag> = { deleted: false };
    const kw = query.q?.trim();
    if (kw) where.tag_name = Like(`${kw}%`);
    if (query.status !== undefined) where.status = query.status;

    const sort = query.sort ?? 'use_count';
    const order: FindOptionsOrder<KhTag> =
      sort === 'tag_name'
        ? { tag_name: 'ASC' }
        : sort === 'created_at'
          ? { created_at: 'DESC' }
          : { use_count: 'DESC', tag_name: 'ASC' };

    return this.tagRepo.find({ where, order, take: query.limit ?? 200 });
  }

  /** 标签详情（未删），404 兜底 */
  async findOne(id: string) {
    return this.findByIdOrFail(id);
  }

  /**
   * 幂等的「按名 get-or-create」：已存在直接返回（不报错）。
   * 这是 DocMetaFields.vue 的 allow-create 自由输入所依赖的行为 —— 该接口必须对外幂等。
   * 并发同名会撞 uk_kh_tag_name（23505），捕获后重查返回，避免 500。
   */
  async createOrGet(dto: CreateTagDto, user?: AuthUser): Promise<KhTag> {
    const name = dto.tag_name.trim();
    const existing = await this.tagRepo.findOne({ where: { tag_name: name, deleted: false } });
    if (existing) return existing;

    const id = this.snowflake.generate();
    try {
      const created = await this.tagRepo.save(
        this.tagRepo.create({
          id,
          tag_name: name,
          use_count: 0,
          create_by: user?.userId ?? null,
          update_by: user?.userId ?? null,
        }),
      );
      this.logger.log(`标签创建成功 tagId=${id} name=${name}`);
      return created;
    } catch (err) {
      // 并发同名：唯一索引冲突后重查 —— 幂等接口的标准写法
      if ((err as { code?: string })?.code === '23505') {
        const raced = await this.tagRepo.findOne({ where: { tag_name: name, deleted: false } });
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** 更新标签（改名 / 启停），重名（23505）→ 400 */
  async update(id: string, dto: UpdateTagDto, user?: AuthUser) {
    const tag = await this.findByIdOrFail(id);
    if (dto.tag_name !== undefined) tag.tag_name = dto.tag_name.trim();
    if (dto.status !== undefined) tag.status = dto.status;
    tag.update_by = user?.userId ?? null;
    try {
      await this.tagRepo.save(tag);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new BadRequestException('标签名称已存在');
      }
      throw err;
    }
    this.logger.log(`标签更新成功 tagId=${tag.id}`);
    return this.findByIdOrFail(tag.id);
  }

  /**
   * 删除标签（软删）：关联行保留。
   * 理由：历史文档仍能保留标签归属与名称（kh_document.tags 串同步保留），
   * 且软删让名字可被重新创建。use_count 不做处理 —— 它统计的是关联表实际行数。
   */
  async remove(id: string) {
    const tag = await this.findByIdOrFail(id);
    await this.tagRepo.update({ id: tag.id }, { deleted: true });
    this.logger.log(`标签已删除（软删）tagId=${tag.id}`);
    return { id: tag.id, message: '标签已删除' };
  }

  /**
   * 替换某文档的全部标签关联（写侧唯一真相源），单事务内完成四件事：
   * 1) 删旧关联  2) 建新关联（去重 + 校验标签存在）  3) 重算受影响标签的 use_count
   * 4) 同步 kh_document.tags 派生串（保持与关联表一致）
   *
   * 事务保证「串与关联表」不会漂移到不同步的中间态。
   */
  async replaceDocumentTags(documentId: string, tagIds: string[]): Promise<void> {
    const docId = normalizeSnowflakeId(documentId, 'document_id');
    const unique = [...new Set(tagIds.map((t) => normalizeSnowflakeId(t, 'tag_id')))];

    await this.dataSource.transaction(async (manager) => {
      const oldRows = await manager.find(KhDocumentTag, { where: { document_id: docId } });
      const oldTagIds = oldRows.map((r) => String(r.tag_id));

      await manager.delete(KhDocumentTag, { document_id: docId });

      let validIds: string[] = [];
      if (unique.length > 0) {
        // 标签必须存在且未删：否则 FK 悬空（或插入了指向软删标签的关联）
        const tags = await manager.find(KhTag, { where: { id: In(unique), deleted: false } });
        validIds = tags.map((t) => String(t.id));
        if (validIds.length !== unique.length) {
          const missing = unique.filter((u) => !validIds.includes(u));
          throw new BadRequestException(`标签不存在：${missing.join(', ')}`);
        }
        await manager.insert(
          KhDocumentTag,
          validIds.map((tagId) => ({
            id: this.snowflake.generate(),
            document_id: docId,
            tag_id: tagId,
          })),
        );
      }

      await this.recalcUseCount(manager, [...oldTagIds, ...validIds]);

      // 4) D 方案：同步派生串（顺序按关联表重建，保证可重算）
      const names = validIds.length
        ? (await manager.find(KhTag, { where: { id: In(validIds) } })).map((t) => t.tag_name)
        : [];
      await manager.update(
        KhDocument,
        { id: docId },
        { tags: names.length ? names.join(',') : null },
      );
    });
    this.logger.log(`文档标签已替换 docId=${docId} tagCount=${unique.length}`);
  }

  /**
   * 批量取「文档 → 标签ID列表」映射（列表场景用）。
   * 一次 SQL 覆盖整页文档，避免逐条查询标签造成 N+1（20 条列表 21 次查询）。
   */
  async getTagIdsByDocuments(documentIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const ids = [...new Set(documentIds.map((d) => String(d)))];
    if (ids.length === 0) return map;

    const rows = await this.docTagRepo.find({ where: { document_id: In(ids) } });
    for (const row of rows) {
      const key = String(row.document_id);
      const list = map.get(key);
      if (list) {
        list.push(String(row.tag_id));
      } else {
        map.set(key, [String(row.tag_id)]);
      }
    }
    return map;
  }

  /**
   * 取某文档的标签名列表（ES 全文索引快照用）。
   * 读侧只认关联表 —— 不解析 kh_document.tags 串。软删标签仍计入索引，
   * 以免历史文档的标签检索突然消失。
   */
  async getTagNamesByDocument(documentId: string): Promise<string[]> {
    const docId = normalizeSnowflakeId(documentId, 'document_id');
    const rows = await this.docTagRepo.find({ where: { document_id: docId } });
    if (rows.length === 0) return [];
    const tags = await this.tagRepo.find({
      where: { id: In(rows.map((r) => String(r.tag_id))) },
      order: { tag_name: 'ASC' },
    });
    return tags.map((t) => t.tag_name);
  }

  /** 全量重算引用计数（管理端「重算」入口；幂等，可随时跑） */
  async recalcAllUseCount(): Promise<{ updated: number }> {
    const updated = await this.recalcUseCount(this.dataSource.manager);
    return { updated };
  }
  /** 按关联表实际行数重算 use_count（幂等）；不传 tagIds 则全量重算 */
  private async recalcUseCount(manager: EntityManager, tagIds?: string[]): Promise<number> {
    if (tagIds && tagIds.length === 0) return 0;
    const params: unknown[] = [];
    let scope = '';
    if (tagIds) {
      params.push([...new Set(tagIds.map((t) => String(t)))]);
      scope = ' WHERE id = ANY($1::bigint[])';
    }
    const result = await manager.query<unknown[]>(
      `UPDATE kh_tag SET use_count = (
         SELECT COUNT(*) FROM kh_document_tag WHERE tag_id = kh_tag.id
       )${scope}`,
      params,
    );
    // UPDATE ... 返回影响行数数组（pg driver rowCount 数组形式），仅用于日志
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }

  /** 依据 id 定位未删标签，不存在 → 404 */
  private async findByIdOrFail(id: string): Promise<KhTag> {
    const tagId = normalizeSnowflakeId(id, 'id');
    const tag = await this.tagRepo.findOne({ where: { id: tagId, deleted: false } });
    if (!tag) {
      throw new NotFoundException(`标签 ${tagId} 不存在`);
    }
    return tag;
  }
}
