import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EsService } from './es.service';

/** kh_chunk：RAG 分块向量索引（对应架构图"写入 ES_chunk"） */
export const CHUNK_INDEX = 'kh_chunk';

/** 单个切块（含向量） */
export interface ChunkWithVector {
    index: number;
    content: string;
    embedding: number[];
}

/** 检索命中的切块（不含向量，含相关性得分） */
export interface ChunkHit {
    doc_id: string;
    doc_title: string;
    chunk_index: number;
    content: string;
    score: number;
}

/** chunk 可见性字段（09 号工单：随发布消息写入 kh_chunk，召回阶段过滤用） */
export interface ChunkVisibility {
    authorId?: string | null;
    teamId?: string | null;
    /** 缺省 1（已发布）：rag 队列只投已发布文档，旧消息兜底 */
    status?: number;
    /** 缺省 false：fail-closed，未带字段的 chunk 仅作者/admin 可见路径之外不放行 */
    isPublic?: boolean;
}

/** kh_chunk 可见性字段 mapping（与 visibility-scope.ts 规则字段对齐） */
const CHUNK_VISIBILITY_MAPPING = {
    author_id: { type: 'keyword' as const },
    team_id: { type: 'keyword' as const },
    status: { type: 'integer' as const },
    is_public: { type: 'boolean' as const },
};

const CHUNK_SOURCE_FIELDS = ['doc_id', 'doc_title', 'chunk_index', 'content'];

/**
 * VectorIndex：kh_chunk 向量索引管理（创建映射 / 按 doc 重写 / 删除）
 */
@Injectable()
export class VectorIndexService {
    private readonly logger = new Logger(VectorIndexService.name);
    /** 索引确保创建只执行一次（懒执行，规避模块初始化顺序问题） */
    private ready?: Promise<void>;

    constructor(
        private readonly es: EsService,
        private readonly config: ConfigService,
    ) { }

    /** 索引不存在则创建（幂等）；dims 对齐 EMBEDDING_DIMS */
    private ensureIndex(): Promise<void> {
        const dims = Number(this.config.get<number>('EMBEDDING_DIMS', 1024));
        const client = this.es.getClient();
        return (async () => {
            const exists = await client.indices.exists({ index: CHUNK_INDEX });
            if (exists) {
                this.logger.log(`ES 索引已存在 index=${CHUNK_INDEX}，补推可见性字段 mapping（09 号工单）`);
                // 增量加字段幂等合法，不需重建索引/重向量化；失败则抛错（fail-closed，避免在无字段索引上静默放行）
                await client.indices.putMapping({
                    index: CHUNK_INDEX,
                    properties: CHUNK_VISIBILITY_MAPPING,
                });
                return;
            }
            await client.indices.create({
                index: CHUNK_INDEX,
                settings: { number_of_shards: 1, number_of_replicas: 0 },
                mappings: {
                    properties: {
                        doc_id: { type: 'keyword' },
                        doc_title: { type: 'text', analyzer: 'ik_max_word', search_analyzer: 'ik_smart' },
                        chunk_index: { type: 'integer' },
                        content: { type: 'text', analyzer: 'ik_max_word', search_analyzer: 'ik_smart' },
                        embedding: { type: 'dense_vector', dims, index: true, similarity: 'cosine' },
                        created_at: { type: 'date' },
                        ...CHUNK_VISIBILITY_MAPPING,
                    },
                },
            });
            this.logger.log(`ES 索引创建完成 index=${CHUNK_INDEX} dims=${dims}`);
        })();
    }

    private async ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.ensureIndex();
        }
        await this.ready;
    }

    /** 写入切块：先删后写（重发布幂等），_bulk 批量提交；visibility 写入召回过滤所需可见性字段 */
    async bulkIndexChunks(
        docId: string,
        docTitle: string,
        chunks: ChunkWithVector[],
        visibility?: ChunkVisibility,
    ): Promise<void> {
        await this.ensureReady();
        const client = this.es.getClient();
        // 先删该文档旧切块，保证同一文档重复发布不产生重复 chunk
        await client.deleteByQuery({
            index: CHUNK_INDEX,
            query: { term: { doc_id: docId } },
            refresh: true,
        });

        const operations = chunks.flatMap((c) => [
            { index: { _index: CHUNK_INDEX } },
            {
                doc_id: docId,
                doc_title: docTitle,
                chunk_index: c.index,
                content: c.content,
                embedding: c.embedding,
                created_at: new Date().toISOString(),
                // 09 号工单：可见性字段（缺省 fail-closed：status=1 兜底、is_public=false、作者/团队为空）
                author_id: visibility?.authorId ?? null,
                team_id: visibility?.teamId ?? null,
                status: visibility?.status ?? 1,
                is_public: visibility?.isPublic ?? false,
            },
        ]);
        const resp = await client.bulk({ operations, refresh: true });
        if (resp.errors) {
            const failed = resp.items.find((item) => {
                const r = item as Record<string, { error?: unknown }>;
                return Object.values(r).some((v) => v?.error);
            });
            throw new Error(`ES bulk 写入存在失败项: ${JSON.stringify(failed)?.slice(0, 500)}`);
        }
        this.logger.log(`ES 写入完成 index=${CHUNK_INDEX} docId=${docId} chunks=${chunks.length}`);
    }

    /** 删除某文档全部切块（document.remove 调用；不存在则删 0 条，幂等） */
    async removeDocChunks(docId: string): Promise<void> {
        await this.ensureReady();
        await this.es.getClient().deleteByQuery({
            index: CHUNK_INDEX,
            query: { term: { doc_id: docId } },
            refresh: true,
        });
        this.logger.log(`ES 切块已删除 index=${CHUNK_INDEX} docId=${docId}`);
    }

    /** 向量检索：knn 语义召回 Top-K（RAG 混合检索的向量路）；filter=可见性子句（ES 8 knn 原生支持） */
    async knnSearch(queryVector: number[], k: number, filter?: Record<string, unknown>): Promise<ChunkHit[]> {
        await this.ensureReady();
        const resp = await this.es.getClient().search({
            index: CHUNK_INDEX,
            // ⚠️ 必须显式传 size：ES 顶层 size 默认只有 10，会截断返回条数；
            //    knn.k 只放宽候选搜索、不决定返回多少条 —— 不传 size 时本函数最多只返回 10 条，
            //    导致 KNN 路（10）与 BM25 路（size=50）候选池不对等，RRF 融合系统性偏向 BM25
            size: k,
            knn: {
                field: 'embedding',
                query_vector: queryVector,
                k,
                num_candidates: Math.max(k * 2, 100),
                ...(filter ? { filter } : {}),
            },
            _source: CHUNK_SOURCE_FIELDS,
        });
        return resp.hits.hits.map((hit) => {
            const src = (hit._source ?? {}) as Record<string, unknown>;
            return {
                doc_id: (src.doc_id as string) ?? '',
                doc_title: (src.doc_title as string) ?? '',
                chunk_index: (src.chunk_index as number) ?? 0,
                content: (src.content as string) ?? '',
                score: hit._score ?? 0,
            };
        });
    }

    /** 关键词检索：doc_title 加权 multi_match（RAG 混合检索的关键词路）；filter=可见性子句（bool.filter） */
    async textSearch(q: string, size: number, filter?: Record<string, unknown>): Promise<ChunkHit[]> {
        await this.ensureReady();
        const multiMatch = {
            multi_match: {
                query: q,
                fields: ['doc_title^2', 'content'],
            },
        };
        const resp = await this.es.getClient().search({
            index: CHUNK_INDEX,
            size,
            query: filter
                ? { bool: { must: [multiMatch], filter: [filter] } }
                : multiMatch,
            _source: CHUNK_SOURCE_FIELDS,
        });
        return resp.hits.hits.map((hit) => {
            const src = (hit._source ?? {}) as Record<string, unknown>;
            return {
                doc_id: (src.doc_id as string) ?? '',
                doc_title: (src.doc_title as string) ?? '',
                chunk_index: (src.chunk_index as number) ?? 0,
                content: (src.content as string) ?? '',
                score: hit._score ?? 0,
            };
        });
    }
}
