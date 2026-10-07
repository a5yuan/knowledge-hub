import { Injectable, Logger } from '@nestjs/common';
import { EsService } from './es.service';
import type { DocumentIndexPayload } from '../mq/mq.service';
import { buildVisibilityFilter, type VisibilityScope } from './visibility-scope';

/** kh_document：整篇文档快照索引（对应架构图"创建/更新文档索引"，文档级关键词检索） */
export const DOC_INDEX = 'kh_document';

/** 检索结果项（不回传整篇正文，避免响应过大） */
export interface DocSearchItem {
    doc_id: string;
    title: string;
    summary: string | null;
    word_count: number;
    publish_time: string | null;
    score: number | null;
    /** 命中片段高亮（默认 <em> 标签包裹），title/summary 整段、content 为片段数组 */
    highlight?: Record<string, string[]>;
}

export interface DocSearchResult {
    total: number;
    page: number;
    pageSize: number;
    items: DocSearchItem[];
}

/** kh_document 整篇快照（getDoc 返回结构，字段与 ensureIndex mapping 一一对应） */
export interface DocSnapshot {
    doc_id: string;
    title: string;
    summary: string | null;
    content: string;
    tags: string[] | null;
    author_id: string | null;
    category_id: string | null;
    team_id: string | null;
    status: number;
    is_public: boolean;
    word_count: number;
    publish_time: string | null;
    created_at: string;
}

/** 检索过滤条件（term 过滤，不算分不影响排序；未传字段不拼） */
export interface SearchFilters {
    status?: number;
    is_public?: boolean;
    category_id?: string;
    team_id?: string;
    author_id?: string;
    /** 多 tag 取交集（每个 tag 一条 term） */
    tags?: string[];
}

/** 检索可选参数 */
export interface SearchOptions {
    /** 多词匹配方式：or=任一命中（默认），and=全部命中 */
    operator?: 'or' | 'and';
    filters?: SearchFilters;
    /** 09 号工单：登录用户可见性作用域（与客户端 filters 同入 bool.filter，AND 关系——只能收紧不能放宽） */
    visibility?: VisibilityScope;
}

/**
 * DocIndex：kh_document 全文索引管理（创建映射 / 创建更新 / 关键词检索）
 * 与 vector-index.service.ts（kh_chunk 向量索引）平行，共用 EsService 客户端
 */
@Injectable()
export class DocIndexService {
    private readonly logger = new Logger(DocIndexService.name);
    /** 索引确保创建只执行一次（懒执行，规避模块初始化顺序问题） */
    private ready?: Promise<void>;

    constructor(private readonly es: EsService) { }

    /** 索引不存在则创建（幂等），中文正文走 ik 分词 */
    private ensureIndex(): Promise<void> {
        const client = this.es.getClient();
        return (async () => {
            const exists = await client.indices.exists({ index: DOC_INDEX });
            if (exists) {
                this.logger.log(`ES 索引已存在 index=${DOC_INDEX}`);
                return;
            }
            await client.indices.create({
                index: DOC_INDEX,
                settings: { number_of_shards: 1, number_of_replicas: 0 },
                mappings: {
                    properties: {
                        doc_id: { type: 'keyword' },
                        title: { type: 'text', analyzer: 'ik_max_word', search_analyzer: 'ik_smart' },
                        summary: { type: 'text', analyzer: 'ik_max_word', search_analyzer: 'ik_smart' },
                        content: { type: 'text', analyzer: 'ik_max_word', search_analyzer: 'ik_smart' },
                        tags: { type: 'keyword' },
                        author_id: { type: 'keyword' },
                        category_id: { type: 'keyword' },
                        team_id: { type: 'keyword' },
                        status: { type: 'integer' },
                        is_public: { type: 'boolean' },
                        word_count: { type: 'integer' },
                        publish_time: { type: 'date' },
                        created_at: { type: 'date' },
                    },
                },
            });
            this.logger.log(`ES 索引创建完成 index=${DOC_INDEX}`);
        })();
    }

    private async ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.ensureIndex();
        }
        await this.ready;
    }

    /** 创建/更新文档索引：_id=docId，重复发布覆盖写（幂等） */
    async indexDocument(payload: DocumentIndexPayload): Promise<void> {
        await this.ensureReady();
        const client = this.es.getClient();
        await client.index({
            index: DOC_INDEX,
            id: payload.docId,
            document: {
                doc_id: payload.docId,
                title: payload.title,
                summary: payload.summary,
                content: payload.content,
                tags: payload.tags,
                author_id: payload.authorId,
                category_id: payload.categoryId,
                team_id: payload.teamId,
                status: payload.status,
                is_public: payload.isPublic,
                word_count: payload.wordCount,
                publish_time: payload.publishTime,
                created_at: new Date().toISOString(),
            },
            refresh: true,
        });
        this.logger.log(
            `ES 文档索引完成 index=${DOC_INDEX} docId=${payload.docId} contentChars=${payload.content.length}`,
        );
    }

    /** 删除某文档的全文快照（文档删除时调用；不存在则删 0 条，幂等） */
    async removeDoc(docId: string): Promise<void> {
        await this.ensureReady();
        await this.es.getClient().deleteByQuery({
            index: DOC_INDEX,
            query: { term: { doc_id: docId } },
            refresh: true,
        });
        this.logger.log(`ES 文档快照已删除 index=${DOC_INDEX} docId=${docId}`);
    }

    /** ES 详情：按 docId 拉取整篇快照（含 content 正文）；不存在返回 null（ES v8 get 404 抛 ResponseError） */
    async getDoc(docId: string): Promise<DocSnapshot | null> {
        await this.ensureReady();
        try {
            const resp = await this.es.getClient().get<DocSnapshot>({ index: DOC_INDEX, id: docId });
            return resp._source ?? null;
        } catch (err) {
            if ((err as { meta?: { statusCode?: number } }).meta?.statusCode === 404) {
                return null;
            }
            throw err;
        }
    }

    /**
     * 关键词检索：title 加权 multi_match，ik 中文分词；bool.filter 按入参动态拼 term（不算分）；
     * title/summary/content 命中片段高亮；结果不回传 content
     */
    async search(q: string, page: number, pageSize: number, opts?: SearchOptions): Promise<DocSearchResult> {
        await this.ensureReady();
        const client = this.es.getClient();
        const f = opts?.filters;
        const filter: Record<string, unknown>[] = [];
        if (f?.status !== undefined) filter.push({ term: { status: f.status } });
        if (f?.is_public !== undefined) filter.push({ term: { is_public: f.is_public } });
        for (const key of ['category_id', 'team_id', 'author_id'] as const) {
            const val = f?.[key];
            if (val) filter.push({ term: { [key]: val } });
        }
        for (const tag of f?.tags ?? []) filter.push({ term: { tags: tag } });
        // 09 号工单：可见性子句进同一 filter 数组（filter 内天然 AND；admin 时 buildVisibilityFilter 返回 undefined 不拼）
        const visibilityClause = opts?.visibility ? buildVisibilityFilter(opts.visibility) : undefined;
        if (visibilityClause) filter.push(visibilityClause);

        const resp = await client.search({
            index: DOC_INDEX,
            from: (page - 1) * pageSize,
            size: pageSize,
            query: {
                bool: {
                    must: [
                        {
                            multi_match: {
                                query: q,
                                fields: ['title^2', 'summary', 'content'],
                                ...(opts?.operator === 'and' ? { operator: 'and' } : {}),
                            },
                        },
                    ],
                    ...(filter.length ? { filter } : {}),
                },
            },
            _source: { excludes: ['content'] },
            highlight: {
                fields: {
                    title: { number_of_fragments: 0 },
                    summary: { number_of_fragments: 0 },
                    content: { number_of_fragments: 3, fragment_size: 120 },
                },
            },
        });
        const total =
            typeof resp.hits.total === 'number' ? resp.hits.total : (resp.hits.total?.value ?? 0);
        const items: DocSearchItem[] = resp.hits.hits.map((hit) => {
            const src = (hit._source ?? {}) as Partial<DocSearchItem>;
            return {
                doc_id: (hit._id as string) ?? src.doc_id ?? '',
                title: src.title ?? '',
                summary: src.summary ?? null,
                word_count: src.word_count ?? 0,
                publish_time: src.publish_time ?? null,
                score: hit._score ?? null,
                ...(hit.highlight && Object.keys(hit.highlight).length
                    ? { highlight: hit.highlight as Record<string, string[]> }
                    : {}),
            };
        });
        return { total, page, pageSize, items };
    }
}
