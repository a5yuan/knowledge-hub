import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhAnnouncement } from './entities/kh-announcement.entity';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { QueryAnnouncementDto } from './dto/query-announcement.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import { OperationService } from '../operation/operation.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 公告服务（21 号工单）。
 *
 * **时区说明**：本模块所有时间比较都在 SQL 内完成（`NOW()` 对 `publish_time` / `expire_time`），
 * 因为这两列也由 DB 侧写入 —— 两端同一时钟基准，不存在 `stats.service.ts` 那种
 * 「JS 算本地边界 vs 列存 UTC 字面」的错位。这是本模块**可以**用 `NOW()` 的前提，
 * 换成「拿 JS 的 Date 去比」才会出问题。
 */
@Injectable()
export class AnnouncementService {
    private readonly snowflake = new SnowflakeId();

    constructor(
        @InjectRepository(KhAnnouncement)
        private readonly repo: Repository<KhAnnouncement>,
        // 21 号工单：公告增删改审计埋点（复用 19 号工单的显式埋点体系）
        private readonly operation: OperationService,
    ) {}

    /**
     * 公告列表。
     *
     * `enabled === true` 是**前台语义**：只要启用的、已到发布时间的、未过期的。
     * 三个条件缺一不可 —— 少了 publish 过滤会让「定时公告」提前露出，
     * 少了 expire 过滤会让过期公告一直挂在大盘上。
     */
    async findAll(query: QueryAnnouncementDto) {
        const { enabled, title, page, pageSize } = query;
        const qb = this.repo
            .createQueryBuilder('a')
            .where('a.deleted = false')
            .orderBy('a.sort', 'ASC')
            // NULL 发布时间的排在最后（未发布的沉底，但管理页仍要能看到）
            .addOrderBy('a.publish_time', 'DESC', 'NULLS LAST')
            .addOrderBy('a.id', 'DESC');

        // ★ 显式判 !== undefined（AGENTS.md 硬约定：0 / false 都是合法值）
        if (enabled !== undefined) {
            qb.andWhere('a.status = :status', { status: enabled ? 1 : 0 });
        }
        if (enabled === true) {
            qb.andWhere('(a.expire_time IS NULL OR a.expire_time > NOW())');
            qb.andWhere('(a.publish_time IS NULL OR a.publish_time <= NOW())');
        }
        if (title !== undefined) {
            qb.andWhere('a.title LIKE :title', { title: `%${title}%` });
        }

        const [items, total] = await qb
            .skip((page - 1) * pageSize)
            .take(pageSize)
            .getManyAndCount();

        return { items, total, page, pageSize };
    }

    /** 公告详情，404 兜底 */
    async findOne(id: string) {
        const target = await this.repo.findOne({
            where: { id: normalizeSnowflakeId(id, 'id'), deleted: false },
        });
        if (!target) throw new NotFoundException('公告不存在');
        return target;
    }

    /**
     * 新建公告：`publish_time` 缺省立即发布（`NOW()`）。
     *
     * 用 QueryBuilder 而非 `repo.save()`：需要在 INSERT 里塞 SQL 表达式 `NOW()`，
     * 而 `save()` 只能传 JS 值 —— 传 `new Date()` 会把本地字面写进 UTC 字面基准的列里。
     */
    async create(dto: CreateAnnouncementDto, user?: AuthUser) {
        const id = this.snowflake.generate();
        const status = dto.status ?? 1;

        await this.repo
            .createQueryBuilder()
            .insert()
            .into(KhAnnouncement)
            .values({
                id,
                title: dto.title,
                content: dto.content,
                status,
                sort: dto.sort ?? 0,
                publish_time: () => 'NOW()',
                create_by: user?.userId ?? null,
                update_by: user?.userId ?? null,
                // created_at / updated_at / expire_time / deleted 交给 DDL 默认值
            })
            .execute();

        await this.operation.record({
            action: 'announcement-create',
            target_type: 'announcement',
            target_id: id,
            target_title: dto.title,
            detail: `新建公告：${dto.title}`,
            actor: user ?? null,
        });

        return this.findOne(id);
    }

    /** 更新公告：只改传了的字段；`updated_at` 由 SQL `NOW()` 写入（同基准） */
    async update(id: string, dto: UpdateAnnouncementDto, user?: AuthUser) {
        const target = await this.findOne(id);

        const patch: Partial<KhAnnouncement> = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.content !== undefined) patch.content = dto.content;
        if (dto.status !== undefined) patch.status = dto.status;
        if (dto.sort !== undefined) patch.sort = dto.sort;
        if (user?.userId) patch.update_by = user.userId;

        // updated_at 必须走 SQL，不能由应用写 Date
        await this.repo
            .createQueryBuilder()
            .update(KhAnnouncement)
            .set({ ...patch, updated_at: () => 'NOW()' })
            .where('id = :id', { id: target.id })
            .execute();

        await this.operation.record({
            action: 'announcement-update',
            target_type: 'announcement',
            target_id: target.id,
            target_title: dto.title ?? target.title,
            detail: describeAnnouncementChanges(target, dto),
            actor: user ?? null,
        });

        return this.findOne(target.id);
    }

    /** 软删公告 */
    async remove(id: string, user?: AuthUser) {
        const target = await this.findOne(id);

        // 删前取标题：删后目标已不可查，审计需要快照
        const title = target.title;
        await this.repo.update({ id: target.id }, { deleted: true });

        await this.operation.record({
            action: 'announcement-delete',
            target_type: 'announcement',
            target_id: target.id,
            target_title: title,
            detail: `删除公告：${title}`,
            actor: user ?? null,
        });

        return { id: target.id, deleted: true };
    }
}

/**
 * 生成「改了什么」的可读描述（审计 detail）。
 *
 * 只描述**业务语义**变更，不做字段 diff 的全量罗列 —— 审计要的是人一眼看懂，
 * 不是把 patch 原样抄一遍。
 */
function describeAnnouncementChanges(
    before: KhAnnouncement,
    dto: UpdateAnnouncementDto,
): string {
    const changes: string[] = [];
    if (dto.title !== undefined && dto.title !== before.title) changes.push('修改标题');
    if (dto.content !== undefined && dto.content !== before.content) changes.push('修改正文');
    if (dto.status !== undefined && dto.status !== before.status) {
        changes.push(dto.status === 1 ? '启用公告' : '停用公告');
    }
    if (dto.sort !== undefined && dto.sort !== before.sort) changes.push('调整排序');
    return changes.length > 0 ? changes.join('、') : '无实质变更';
}
