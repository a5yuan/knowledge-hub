import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import SnowflakeId from 'snowflake-id';
import { KhDocument } from './entities/document.entity';
import { KhDocumentReview } from './entities/document-review.entity';
import {
    DocumentContent,
    DocumentContentDocument,
} from './schemas/document-content.schema';
import { CreateDocumentDto } from './dto/create-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { ReviewActionDto } from './dto/review-action.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import { FileService } from '../file/file.service';
import { RustfsService } from '../storage/rustfs.service';
import {
    MqService,
    ROUTING_KEYS,
    ROUTING_KEY_DOC_INDEX,
    SEARCH_EXCHANGE,
    type DocumentIndexPayload,
    type RoutingKey,
} from '../mq/mq.service';
import { VectorIndexService } from '../es/vector-index.service';
import { DocIndexService } from '../es/doc-index.service';
import { isDocVisible, type VisibilityScope } from '../es/visibility-scope';
import { KgService } from '../kg/kg.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/** 文档状态机：仅 1=已发布 参与三套索引（kh_chunk / kh_document / Neo4j） */
export const STATUS_DRAFT = 0;
export const STATUS_PUBLISHED = 1;
export const STATUS_PENDING_REVIEW = 2;
export const STATUS_ARCHIVED = 3;

@Injectable()
export class DocumentService {
    private readonly logger = new Logger(DocumentService.name);
    /** 应用侧雪花ID生成器（generate() 返回字符串，精度安全） */
    private readonly snowflake = new SnowflakeId();
    /** 审核开关（REVIEW_ENABLED=true: /publish=提审，需 /approve 通过才发布） */
    private readonly reviewEnabled: boolean;

    constructor(
        @InjectRepository(KhDocument)
        private readonly documentRepo: Repository<KhDocument>,
        @InjectRepository(KhDocumentReview)
        private readonly reviewRepo: Repository<KhDocumentReview>,
        @InjectModel(DocumentContent.name)
        private readonly contentModel: Model<DocumentContentDocument>,
        private readonly fileService: FileService,
        private readonly rustfs: RustfsService,
        private readonly mq: MqService,
        private readonly vectorIndex: VectorIndexService,
        private readonly docIndex: DocIndexService,
        private readonly kg: KgService,
        private readonly config: ConfigService,
    ) {
        this.reviewEnabled = this.config.get('REVIEW_ENABLED') === 'true';
    }

    /**
     * 上传文件并提交异步解析（对应流程图：上传 → RustFS 原文件 → PG 草稿 → 后台解析）
     * 立即返回草稿摘要 JSON，前端轮询 GET /document/:id 拿状态与正文
     */
    async upload(file: Express.Multer.File, dto?: UploadDocumentDto, user?: AuthUser) {
        // multer 在 Windows 下把 originalname 按 latin1 解码，中文文件名需转回 UTF-8
        const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');

        const id = this.snowflake.generate();
        const objectKey = `documents/${id}/${filename}`;

        // 1. RustFS 存原文件
        await this.rustfs.upload(objectKey, file.buffer, file.mimetype || 'application/octet-stream');

        // 2. Mongo 写正文记录（空正文 + parse_state=pending）
        const content = await this.contentModel.create({
            documentId: id,
            parse_state: 'pending',
            source_file_name: filename,
            source_file_key: objectKey,
        });

        // 3. PG 写草稿元数据（title = 文件名去扩展名）
        const title = filename.replace(/\.[^.]+$/, '') || filename;
        const doc = this.documentRepo.create({
            id,
            title,
            content_id: content._id.toString(),
            status: 0, // 草稿
            // 09 号工单：作者缺省取当前登录用户（否则 author_id 为空的文档对上传者本人也不可见）
            author_id: dto?.authorId ?? user?.userId ?? null,
            create_by: dto?.createBy ?? user?.userId ?? null,
        });
        await this.documentRepo.save(doc);
        this.logger.log(`文件上传完成 docId=${id} filename=${filename} size=${file.size} bytes`);

        // 4. 后台解析，不阻塞请求
        void this.processParse(id, file.buffer, filename);

        // 5. 返回草稿摘要 JSON
        return {
            id,
            title,
            parse_state: 'pending',
            poll_url: `/document/${id}`,
            source_file_url: this.rustfs.publicUrl(objectKey),
        };
    }

    /** 后台解析：FileService 分发 → markdown 落 Mongo → summary/word_count 更新 PG */
    private async processParse(docId: string, buffer: Buffer, filename: string): Promise<void> {
        await this.contentModel
            .updateOne({ documentId: docId }, { parse_state: 'running' })
            .catch(() => undefined);
        try {
            const { markdown } = await this.fileService.dispatch(buffer, filename, docId);
            const summary = markdown
                .replace(/[#>*`~\[\]()!|>-]/g, '')
                .trim()
                .slice(0, 200);
            const wordCount = markdown.replace(/\s/g, '').length;

            await this.contentModel.updateOne(
                { documentId: docId },
                { content: markdown, format: 'markdown', parse_state: 'success', parse_error: '' },
            );
            await this.documentRepo.update({ id: docId }, { summary, word_count: wordCount });
        } catch (err) {
            const message = (err as Error).message?.slice(0, 500) ?? '未知解析错误';
            await this.contentModel
                .updateOne({ documentId: docId }, { parse_state: 'failed', parse_error: message })
                .catch(() => undefined);
        }
    }

    /** 创建文档：先写正文（Mongo）取 _id 作为 content_id，再写元数据（PG）；作者缺省取当前登录用户（09 号工单） */
    async create(dto: CreateDocumentDto, user?: AuthUser) {
        // 堵绕审口子：审核开启时禁止直发（状态机唯一发布入口 = /publish 提审 → /approve）
        if (this.reviewEnabled && dto.status === STATUS_PUBLISHED) {
            throw new BadRequestException('审核已开启，请创建草稿后走 /publish 提审流程');
        }
        const id = this.snowflake.generate();
        const content = await this.contentModel.create({ documentId: id });
        const doc = this.documentRepo.create({
            ...dto,
            id,
            content_id: content._id.toString(),
            author_id: dto.author_id ?? user?.userId ?? null,
            create_by: dto.create_by ?? user?.userId ?? null,
        });
        return this.documentRepo.save(doc);
    }

    /**
     * 分页查询文档元数据列表（09 号工单：非 admin 按可见性三规则过滤——
     * 本人任何状态 ∪ 已发布+公开 ∪ 已发布+本团队；审核人另可见待审核）
     * 客户端 filter 与可见性 AND 求交（只能收紧不能放宽）
     */
    async findAll(query: QueryDocumentDto, scope?: VisibilityScope) {
        const {
            page = 1,
            pageSize = 20,
            id,
            title,
            category_id,
            team_id,
            author_id,
            tags,
            status,
            is_public,
        } = query;
        const qb = this.documentRepo
            .createQueryBuilder('d')
            .where('d.deleted = :deleted', { deleted: false });
        if (id !== undefined) qb.andWhere('d.id = :id', { id });
        if (category_id !== undefined) qb.andWhere('d.category_id = :category_id', { category_id });
        if (team_id !== undefined) qb.andWhere('d.team_id = :team_id', { team_id });
        if (author_id !== undefined) qb.andWhere('d.author_id = :author_id', { author_id });
        if (status !== undefined) qb.andWhere('d.status = :status', { status });
        if (is_public !== undefined) qb.andWhere('d.is_public = :is_public', { is_public });
        if (title !== undefined) qb.andWhere('d.title LIKE :title', { title: `%${title}%` });
        if (tags !== undefined) qb.andWhere('d.tags LIKE :tags', { tags: `%${tags}%` });
        if (scope && !scope.isAdmin) {
            // 语义与 es/visibility-scope.ts 的 buildVisibilityFilter 一一对应
            qb.andWhere(
                new Brackets((inner) => {
                    // 规则 1：本人文档（任何状态）
                    inner.where('d.author_id = :visUid', { visUid: scope.userId });
                    // 规则 2：已发布 + 公开
                    inner.orWhere('d.status = :visPub AND d.is_public = true', {
                        visPub: STATUS_PUBLISHED,
                    });
                    // 规则 3：已发布 + 本团队（无团队时该分支恒不命中）
                    inner.orWhere(
                        new Brackets((team) => {
                            team.where('d.status = :visPub2', { visPub2: STATUS_PUBLISHED });
                            if (scope.teamIds.length > 0) {
                                team.andWhere('d.team_id IN (:...visTeamIds)', {
                                    visTeamIds: scope.teamIds,
                                });
                            } else {
                                team.andWhere('1 = 0');
                            }
                        }),
                    );
                    // 审核人可见待审核（审核工作台依赖）
                    if (scope.canReview) {
                        inner.orWhere('d.status = :visPending', { visPending: STATUS_PENDING_REVIEW });
                    }
                }),
            );
        }
        const [items, total] = await qb
            .orderBy('d.created_at', 'DESC')
            .skip((page - 1) * pageSize)
            .take(pageSize)
            .getManyAndCount();
        return { items, total, page, pageSize };
    }

    /**
     * 查询文档详情（元数据 + MongoDB 正文 + 解析状态），供前端轮询（09 号工单：按可见性判定，不可见与不存在同为 404 不暴露存在性）
     */
    async findOne(id: string, scope?: VisibilityScope) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (scope && !isDocVisible(doc, scope)) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        const content = await this.contentModel.findOne({
            documentId: docId,
            deleted: false,
        });
        return {
            ...doc,
            content: content?.content ?? null,
            parse_state: content?.parse_state ?? 'pending',
            parse_error: content?.parse_error ?? null,
            source_file_name: content?.source_file_name ?? null,
            source_file_url: content?.source_file_key
                ? this.rustfs.publicUrl(content.source_file_key)
                : null,
        };
    }

    /**
     * 发布入口（按 REVIEW_ENABLED 分叉）：
     * false → 直接发布：status=1 + publish_time + 投递 RAG/KG 队列 + Search 快照索引消息（现状行为）
     * true  → 提审：status=2 + 写审核记录（before_status），需 /approve 通过才发布；
     *         已发布文档重复提审会先清三套索引（离开 Published 即无索引）
     */
    async publish(id: string) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (doc.status === STATUS_ARCHIVED) {
            throw new BadRequestException('文档已归档，不可再发布');
        }
        if (doc.status === STATUS_PENDING_REVIEW) {
            throw new BadRequestException('文档已在待审核中，请等待审核结果');
        }
        if (!this.reviewEnabled) {
            // 开关关闭：直发（重复发布幂等）
            doc.status = STATUS_PUBLISHED;
            doc.publish_time = new Date();
            await this.documentRepo.save(doc);
            await this.dispatchPublish(doc);
            await this.dispatchIndex(doc);
            return {
                id: doc.id,
                status: doc.status,
                publish_time: doc.publish_time,
                queues: [...ROUTING_KEYS],
                indexExchange: SEARCH_EXCHANGE,
            };
        }
        // 开关开启：提审
        const beforeStatus = doc.status;
        if (beforeStatus === STATUS_PUBLISHED) {
            await this.clearThreeIndexes(docId);
        }
        doc.status = STATUS_PENDING_REVIEW;
        await this.documentRepo.save(doc);
        await this.reviewRepo.insert({
            id: this.snowflake.generate(),
            document_id: docId,
            before_status: beforeStatus,
        });
        this.logger.log(`文档提审 docId=${docId} before_status=${beforeStatus}`);
        return {
            id: doc.id,
            status: doc.status,
            before_status: beforeStatus,
            review: 'submitted',
            next: 'POST /document/:id/approve | POST /document/:id/reject',
        };
    }

    /**
     * 审核通过（仅待审核）：回填审核记录 → status=1 → 投递 MQ 重建三套索引
     * 审核人身份取自当前登录用户（token 注入），不再信任请求体
     */
    async approve(id: string, dto: ReviewActionDto, user?: AuthUser) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (doc.status !== STATUS_PENDING_REVIEW) {
            throw new BadRequestException('仅待审核状态的文档可通过审核');
        }
        await this.settleReview(docId, 1, user, dto?.comment?.trim() || null);
        doc.status = STATUS_PUBLISHED;
        // 首审通过写入发布时间，复审（1→2→1）保留首次发布时间
        if (!doc.publish_time) {
            doc.publish_time = new Date();
        }
        await this.documentRepo.save(doc);
        await this.dispatchPublish(doc);
        await this.dispatchIndex(doc);
        return {
            id: doc.id,
            status: doc.status,
            publish_time: doc.publish_time,
            queues: [...ROUTING_KEYS],
            indexExchange: SEARCH_EXCHANGE,
        };
    }

    /**
     * 驳回（仅待审核，comment 必填）：回填审核记录 → status=0 回草稿（待审核本就无索引，无需清理）
     * 审核人身份取自当前登录用户（token 注入），不再信任请求体
     */
    async reject(id: string, dto: ReviewActionDto, user?: AuthUser) {
        const docId = normalizeSnowflakeId(id, 'id');
        const comment = dto?.comment?.trim();
        if (!comment) {
            throw new BadRequestException('驳回意见 comment 必填');
        }
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (doc.status !== STATUS_PENDING_REVIEW) {
            throw new BadRequestException('仅待审核状态的文档可驳回');
        }
        await this.settleReview(docId, 2, user, comment);
        doc.status = STATUS_DRAFT;
        await this.documentRepo.save(doc);
        return { id: doc.id, status: doc.status, review: 'rejected' };
    }

    /** 回填该文档最新一条待审记录（review_result / 审核人取自登录用户 / 意见 / 时间） */
    private async settleReview(
        docId: string,
        result: 1 | 2,
        user: AuthUser | undefined,
        comment: string | null,
    ): Promise<void> {
        const pending = await this.reviewRepo.findOne({
            where: { document_id: docId, review_result: IsNull() },
            order: { created_at: 'DESC' },
        });
        if (!pending) return;
        pending.review_result = result;
        pending.reviewer_id = user?.userId ?? null;
        pending.reviewer_name = user?.realName ?? null;
        pending.review_comment = comment;
        pending.reviewed_at = new Date();
        await this.reviewRepo.save(pending);
    }

    /** 下架编辑（仅已发布）：同步清三套索引后 status=0 回草稿；清理失败即抛错不落库，避免下架后检索残留 */
    async saveDraft(id: string) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (doc.status !== STATUS_PUBLISHED) {
            throw new BadRequestException('仅已发布状态的文档可下架编辑');
        }
        const failed = await this.clearThreeIndexes(docId);
        if (failed.length > 0) {
            throw new InternalServerErrorException(
                `索引清理失败(${failed.join(',')})，文档仍为已发布状态，请重试`,
            );
        }
        doc.status = STATUS_DRAFT;
        await this.documentRepo.save(doc);
        return { id: doc.id, status: doc.status, publish_time: doc.publish_time };
    }

    /** 归档（仅已发布）：status=3 先落库，三套索引异步清理（fire-and-forget）；归档为终态，正文与原文件保留 */
    async archive(id: string) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        if (doc.status !== STATUS_PUBLISHED) {
            throw new BadRequestException('仅已发布状态的文档可归档');
        }
        doc.status = STATUS_ARCHIVED;
        await this.documentRepo.save(doc);
        void this.clearThreeIndexes(docId);
        return { id: doc.id, status: doc.status };
    }

    /** 待审核数量（前端角标轮询；命中 idx_kh_document_review_pending 部分索引） */
    async pendingReviewCount() {
        const count = await this.reviewRepo.count({
            where: { review_result: IsNull() },
        });
        return { count };
    }

    /** 审核待办列表（review_result IS NULL，附带文档标题/状态） */
    async pendingReviews() {
        return this.reviewRepo
            .createQueryBuilder('r')
            .leftJoin(KhDocument, 'd', 'd.id = r.document_id')
            .where('r.review_result IS NULL')
            .orderBy('r.created_at', 'DESC')
            .addSelect('r.id', 'id')
            .addSelect('r.document_id', 'document_id')
            .addSelect('d.title', 'title')
            .addSelect('d.status', 'doc_status')
            .addSelect('r.before_status', 'before_status')
            .addSelect('r.created_at', 'created_at')
            .getRawMany();
    }

    /** 单文档审核历史（含通过/驳回，按提审时间倒序） */
    async reviewHistory(id: string) {
        const docId = normalizeSnowflakeId(id, 'id');
        return this.reviewRepo.find({
            where: { document_id: docId },
            order: { created_at: 'DESC' },
        });
    }

    /** 投递发布消息到 RAG/KG 队列（09 号工单：携带可见性字段，kh_chunk 写入用）；单队列失败仅记日志，不阻断发布 */
    private async dispatchPublish(doc: KhDocument): Promise<void> {
        const payload = {
            docId: doc.id,
            title: doc.title,
            publishedAt: new Date().toISOString(),
            authorId: doc.author_id,
            teamId: doc.team_id,
            status: doc.status,
            isPublic: doc.is_public,
        };
        for (const key of ROUTING_KEYS as readonly RoutingKey[]) {
            try {
                await this.mq.publish(key, payload);
            } catch (err) {
                this.logger.error(
                    `发布消息投递失败 docId=${doc.id} routingKey=${key}: ${(err as Error).message}`,
                );
            }
        }
    }

    /**
     * 构建文档快照（整篇元数据 + 正文）并投递全文检索索引消息（routing key document.index）
     * 失败仅记日志，不阻断发布
     */
    private async dispatchIndex(doc: KhDocument): Promise<void> {
        try {
            const content = await this.contentModel.findOne({
                documentId: doc.id,
                deleted: false,
            });
            const snapshot: DocumentIndexPayload = {
                docId: doc.id,
                title: doc.title,
                summary: doc.summary,
                content: content?.content ?? '',
                tags: doc.tags,
                authorId: doc.author_id,
                categoryId: doc.category_id,
                teamId: doc.team_id,
                status: doc.status,
                isPublic: doc.is_public,
                wordCount: doc.word_count,
                publishTime: doc.publish_time ? new Date(doc.publish_time).toISOString() : null,
                publishedAt: new Date().toISOString(),
            };
            await this.mq.publish(ROUTING_KEY_DOC_INDEX, snapshot);
        } catch (err) {
            this.logger.error(
                `全文检索快照投递失败 docId=${doc.id}: ${(err as Error).message}`,
            );
        }
    }

    /** 更新文档元数据（仅更新传入字段）；status 0→1 跳变视为发布并触发投递 */
    async update(id: string, dto: UpdateDocumentDto) {
        const docId = normalizeSnowflakeId(id, 'id');
        // 堵绕审口子：审核开启时 PATCH 不可直发
        if (this.reviewEnabled && dto.status === STATUS_PUBLISHED) {
            throw new BadRequestException('审核已开启，发布请走 /publish 提审与 /approve');
        }
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        const prevStatus = doc.status;
        Object.assign(doc, dto);
        // PATCH 触发的发布同样补齐 publish_time，与 publish 接口行为一致
        if (doc.status === 1 && prevStatus !== 1 && !doc.publish_time) {
            doc.publish_time = new Date();
        }
        const saved = await this.documentRepo.save(doc);
        if (saved.status === 1 && prevStatus !== 1) {
            void this.dispatchPublish(saved);
            void this.dispatchIndex(saved);
        }
        return saved;
    }

    /** 删除文档：PG 与 Mongo 均逻辑删除（deleted = true），并清理 ES 中 kh_chunk/kh_document 数据 */
    async remove(id: string) {
        const docId = normalizeSnowflakeId(id, 'id');
        const doc = await this.documentRepo.findOne({
            where: { id: docId, deleted: false },
        });
        if (!doc) {
            throw new NotFoundException(`文档 ${docId} 不存在`);
        }
        doc.deleted = true;
        await this.documentRepo.save(doc);
        await this.contentModel.updateOne(
            { documentId: docId },
            { $set: { deleted: true } },
        );
        // 清理三套索引（kh_chunk/kh_document/Neo4j）；失败仅记日志，不阻断删除
        await this.clearThreeIndexes(docId);
        return { success: true };
    }

    /**
     * 清理三套索引（kh_chunk 向量 / kh_document 全文 / Neo4j 图谱）
     * 各自独立 try/catch：失败仅记日志（含 docId），返回失败项列表供调用方决定是否阻断
     */
    private async clearThreeIndexes(docId: string): Promise<string[]> {
        const failed: string[] = [];
        try {
            await this.vectorIndex.removeDocChunks(docId);
        } catch (err) {
            failed.push('kh_chunk');
            this.logger.error(`清理 kh_chunk 失败 docId=${docId}: ${(err as Error).message}`);
        }
        try {
            await this.docIndex.removeDoc(docId);
        } catch (err) {
            failed.push('kh_document');
            this.logger.error(`清理 kh_document 失败 docId=${docId}: ${(err as Error).message}`);
        }
        try {
            await this.kg.removeDocGraph(docId);
        } catch (err) {
            failed.push('neo4j');
            this.logger.error(`清理 Neo4j 图谱失败 docId=${docId}: ${(err as Error).message}`);
        }
        return failed;
    }
}
