import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VectorIndexService, ChunkHit } from '../es/vector-index.service';
import {
  buildVisibilityFilter,
  type VisibilityScope,
} from '../es/visibility-scope';
import { EmbeddingService } from '../pipeline/embedding.service';
import { RerankService } from './rerank.service';
import { TracingService } from '../observability/tracing.service';

/** 双路召回路数 */
const RECALL_SIZE = 50;
/** RRF 平滑常数（经验值 60） */
const RRF_K = 60;

/** 检索结果单项（rank 从 1 起；score 为重排相关性得分，降级时为 RRF 得分） */
export interface RagSearchItem {
  doc_id: string;
  doc_title: string;
  chunk_index: number;
  content: string;
  score: number;
  rank: number;
}

export interface RagSearchResult {
  items: RagSearchItem[];
  took_ms: number;
}

/**
 * RRF 倒数排名融合（纯函数，便于单测）：
 * score(d) = Σ 1/(k + rank_i(d))，rank 从 1 起；去重键 doc_id + chunk_index，结果按融合分降序。
 */
export function rrfFuse(
  lists: ChunkHit[][],
  k = RRF_K,
): Array<ChunkHit & { rrfScore: number }> {
  const map = new Map<string, ChunkHit & { rrfScore: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const rank = i + 1;
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const existing = map.get(key);
      if (existing) {
        existing.rrfScore += 1 / (k + rank);
      } else {
        map.set(key, { ...hit, rrfScore: 1 / (k + rank) });
      }
    });
  }
  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * RAG 混合检索编排（对应架构图：关键词召回 + 向量召回 → RRF 融合 → Reranker 精排）
 */
@Injectable()
export class RagSearchService {
  private readonly logger = new Logger(RagSearchService.name);

  constructor(
    private readonly vectorIndex: VectorIndexService,
    private readonly embedding: EmbeddingService,
    private readonly rerank: RerankService,
    private readonly config: ConfigService,
    private readonly tracing: TracingService,
  ) {}

  async search(
    q: string,
    topK: number,
    useRerank = true,
    scope?: VisibilityScope,
  ): Promise<RagSearchResult> {
    if (!this.tracing.enabled) return this.runSearch(q, topK, useRerank, scope);
    // 工单 13：整体包一个 retriever 观察，检索层（召回/融合/精排）延迟与结果可追溯
    return this.tracing.withRetriever(
      'rag-search',
      { input: { query: q, topK, useRerank } },
      async (update) => {
        const result = await this.runSearch(q, topK, useRerank, scope);
        update({
          output: {
            hits: result.items.length,
            took_ms: result.took_ms,
            doc_ids: [...new Set(result.items.map((it) => it.doc_id))],
          },
        });
        return result;
      },
    );
  }

  private async runSearch(
    q: string,
    topK: number,
    useRerank: boolean,
    scope?: VisibilityScope,
  ): Promise<RagSearchResult> {
    const start = Date.now();
    // 09 号工单：可见性子句一次构建、双路共用（admin → undefined 不过滤）
    const visibilityFilter = scope ? buildVisibilityFilter(scope) : undefined;
    // 1. 查询向量化（工单 13：embedding 观察）
    const [vector] = await this.tracing.withEmbedding(
      'embed-query',
      { input: { query: q } },
      async (update) => {
        const vectors = await this.embedding.embed([q]);
        update({
          output: { count: vectors.length, dims: vectors[0]?.length ?? 0 },
        });
        return vectors;
      },
    );
    // 2. 双路并行召回（关键词 BM25 路 + 向量 KNN 路，召回阶段即按用户可见性过滤）
    const [knnHits, textHits] = await Promise.all([
      this.vectorIndex.knnSearch(vector, RECALL_SIZE, visibilityFilter),
      this.vectorIndex.textSearch(q, RECALL_SIZE, visibilityFilter),
    ]);
    // 3. RRF 融合去重，取候选集
    const fused = rrfFuse([knnHits, textHits]);
    const candidates = fused.slice(0, Math.min(topK * 4, 40));

    let items: RagSearchItem[] | undefined;
    // 4. Reranker 精排；失败/关闭时降级为 RRF 顺序截断（工单 13：精排单独观察）
    if (useRerank && candidates.length > 0) {
      const reranked = await this.tracing.withSpan(
        'rerank',
        { input: { query: q, candidates: candidates.length, topN: topK } },
        async (update) => {
          const r = await this.rerank.rerank(
            q,
            candidates.map((c) => c.content),
            topK,
          );
          update({ output: { results: r?.length ?? 0, degraded: !r } });
          return r;
        },
      );
      if (reranked && reranked.length > 0) {
        items = reranked
          .filter((r) => r.index >= 0 && r.index < candidates.length)
          .map((r, i) => ({
            doc_id: candidates[r.index].doc_id,
            doc_title: candidates[r.index].doc_title,
            chunk_index: candidates[r.index].chunk_index,
            content: candidates[r.index].content,
            score: r.relevance_score,
            rank: i + 1,
          }));
      }
    }
    if (!items) {
      items = candidates.slice(0, topK).map((c, i) => ({
        doc_id: c.doc_id,
        doc_title: c.doc_title,
        chunk_index: c.chunk_index,
        content: c.content,
        score: c.rrfScore,
        rank: i + 1,
      }));
    }

    // 11 号工单阶段2：分数低于阈值的丢弃（RAG_SCORE_THRESHOLD，默认 0=关闭；rerank 分标度待标定）
    const threshold = Number(
      this.config.get<string>('RAG_SCORE_THRESHOLD') ?? 0,
    );
    if (Number.isFinite(threshold) && threshold > 0 && items.length > 0) {
      items = items.filter((it) => it.score >= threshold);
    }

    const tookMs = Date.now() - start;
    this.logger.log(
      `RAG 混合检索完成 q=${q.slice(0, 50)} knn=${knnHits.length} text=${textHits.length} 返回=${items.length} rerank=${useRerank} 阈值=${threshold} took=${tookMs}ms`,
    );
    return { items, took_ms: tookMs };
  }
}
