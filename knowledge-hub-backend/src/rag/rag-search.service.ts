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

/**
 * 检索消融模式（对照实验用，默认 hybrid 即生产路径）：
 * - hybrid：BM25 + KNN 双路 → RRF（唯一对外形态）
 * - hybrid_weighted：BM25 + KNN 双路 → 分数 min-max 归一化后加权求和（**对照臂**，
 *   用于实测「为什么用 RRF 而不是加权求和」；RF 的代价是两路 Top-1 必然平局，见 rrfFuse 注释）
 * - bm25：只跑关键词路，并**跳过查询向量化**（等价于删掉 KNN 分支）
 * - knn：只跑向量路（等价于删掉 BM25 分支）
 * 单路同样过 rrfFuse（单列表下 1/(k+rank) 单调，等价于原始序），保证下游完全一致。
 */
export type RetrievalMode = 'hybrid' | 'hybrid_weighted' | 'bm25' | 'knn';

/** 加权求和的权重（对照臂固定值：BM25 0.5 / KNN 0.5，不做调参） */
const WEIGHTED_FUSION_WEIGHTS = [0.5, 0.5] as const;

/** 分阶段耗时（ms）：knn/bm25 在 hybrid 下并行，两值可同时大于端到端耗时的剩余部分 */
export interface RagSearchStages {
  embed_ms: number;
  knn_ms: number;
  bm25_ms: number;
  fuse_ms: number;
  rerank_ms: number;
}

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
  /** 本次实际生效的检索模式（回显，便于对照实验确认参数生效） */
  mode: RetrievalMode;
  /** 分阶段耗时拆解（工单 13 补充：卡 1「双路 vs 单路延迟代价」证据） */
  stages: RagSearchStages;
}

/**
 * RRF 倒数排名融合（纯函数，便于单测）：
 * score(d) = Σ 1/(k + rank_i(d))，rank 从 1 起；去重键 doc_id + chunk_index，结果按融合分降序。
 *
 * ⚠️ 已知边界（实验实测，2026-10-09）：RRF **只用排名不用分数**，
 *    因此"两路各自的第 1 名"必然同分（都是 1/(k+1)）。当两路 Top-1 不是同一条、
 *    且互不在对方候选池内时，融合后的 Top-1 平局，胜负实际由**本函数的列表遍历顺序**
 *    决定（先 `lists[0]` 后 `lists[1]`，Map 插入序 + Array.sort 稳定性）。
 *    实测：`mode=hybrid` 传 `[knnHits, textHits]` 时，BM25 的正确 Top-1 会被
 *    KNN 的 Top-1 压到第 2（见 test/eval/results/ablation-real-at-1220.md）。
 *    这也是 `hybrid_weighted` 对照臂存在的理由。
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
 * 加权求和融合（纯函数，**对照臂专用**，非生产路径）：
 * 每条路内先对原始分做 min-max 归一化（消除 BM25 分与 cosine 分的量纲差），
 * 再按 weights 加权求和。这正是「RRF 免去量纲对齐」的对照组：
 * 它保留了单路内部的分差信息，所以不会出现 RRF 那种"两路 Top-1 必然平局"。
 */
export function weightedFuse(
  lists: ChunkHit[][],
  weights: readonly number[] = WEIGHTED_FUSION_WEIGHTS,
): Array<ChunkHit & { rrfScore: number }> {
  const map = new Map<string, ChunkHit & { rrfScore: number }>();
  lists.forEach((list, li) => {
    if (!list.length) return;
    const scores = list.map((h) => h.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min;
    const w = weights[li] ?? 1 / lists.length;
    list.forEach((hit) => {
      // 单路内部所有分相同（span=0）时统一给 1，避免除零
      const norm = span > 0 ? (hit.score - min) / span : 1;
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const existing = map.get(key);
      if (existing) existing.rrfScore += w * norm;
      else map.set(key, { ...hit, rrfScore: w * norm });
    });
  });
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
    mode: RetrievalMode = 'hybrid',
  ): Promise<RagSearchResult> {
    if (!this.tracing.enabled) return this.runSearch(q, topK, useRerank, scope, mode);
    // 工单 13：整体包一个 retriever 观察，检索层（召回/融合/精排）延迟与结果可追溯
    return this.tracing.withRetriever(
      'rag-search',
      { input: { query: q, topK, useRerank, mode } },
      async (update) => {
        const result = await this.runSearch(q, topK, useRerank, scope, mode);
        update({
          output: {
            hits: result.items.length,
            took_ms: result.took_ms,
            mode: result.mode,
            stages: result.stages,
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
    mode: RetrievalMode = 'hybrid',
  ): Promise<RagSearchResult> {
    const start = Date.now();
    // 09 号工单：可见性子句一次构建、双路共用（admin → undefined 不过滤）
    const visibilityFilter = scope ? buildVisibilityFilter(scope) : undefined;
    // 1. 查询向量化（工单 13：embedding 观察）；bm25 单路模式下无向量需求，直接跳过
    let embedMs = 0;
    let vector: number[] | undefined;
    if (mode !== 'bm25') {
      const embedStart = Date.now();
      [vector] = await this.tracing.withEmbedding(
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
      embedMs = Date.now() - embedStart;
    }
    // 2. 召回（hybrid：BM25 路 + 向量 KNN 路并行；单路模式下另一路直接置空数组，等价于删掉该分支）
    let knnMs = 0;
    let bm25Ms = 0;
    const knnPromise: Promise<ChunkHit[]> =
      mode === 'bm25'
        ? Promise.resolve([])
        : (async () => {
            const t = Date.now();
            const hits = await this.vectorIndex.knnSearch(
              vector as number[],
              RECALL_SIZE,
              visibilityFilter,
            );
            knnMs = Date.now() - t;
            return hits;
          })();
    const bm25Promise: Promise<ChunkHit[]> =
      mode === 'knn'
        ? Promise.resolve([])
        : (async () => {
            const t = Date.now();
            const hits = await this.vectorIndex.textSearch(q, RECALL_SIZE, visibilityFilter);
            bm25Ms = Date.now() - t;
            return hits;
          })();
    const [knnHits, textHits] = await Promise.all([knnPromise, bm25Promise]);
    // 3. 融合去重，取候选集（单路 = 单列表 RRF，序等价于原序，下游完全一致）
    const fuseStart = Date.now();
    const fused =
      mode === 'knn'
        ? rrfFuse([knnHits])
        : mode === 'bm25'
          ? rrfFuse([textHits])
          : mode === 'hybrid_weighted'
            ? weightedFuse([textHits, knnHits])
            : rrfFuse([knnHits, textHits]);
    const candidates = fused.slice(0, Math.min(topK * 4, 40));
    const fuseMs = Date.now() - fuseStart;

    let items: RagSearchItem[] | undefined;
    let rerankMs = 0;
    // 4. Reranker 精排；失败/关闭时降级为 RRF 顺序截断（工单 13：精排单独观察）
    if (useRerank && candidates.length > 0) {
      const rerankStart = Date.now();
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
      rerankMs = Date.now() - rerankStart;
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

    // 11 号工单阶段2：分数低于阈值的丢弃（RAG_SCORE_THRESHOLD，默认 0=关闭）
    //
    // ⚠️ 启用前必读：items[].score 的量纲取决于 rerank 是否生效（见上方两个分支），
    //    两者不可同尺度比较，直接用同一个阈值会误杀：
    //      - rerank 生效：score = relevance_score（dashscope 相关性分，通常 0~1）
    //      - rerank 降级：score = rrfScore（Σ 1/(60+rank)，双路召回下上限约 0.033）
    //    后果：若阈值按 rerank 分标定（如 0.3），则 reranker 一旦故障降级，
    //    **全部结果都会被过滤掉**，对外返回空列表——与「真的没有内容」不可区分。
    //    正确做法是先让两路分数归一化，或把过滤限制在 rerank 生效分支内；不要直接照搬 rerank 分标度。
    const threshold = Number(
      this.config.get<string>('RAG_SCORE_THRESHOLD') ?? 0,
    );
    if (Number.isFinite(threshold) && threshold > 0 && items.length > 0) {
      items = items.filter((it) => it.score >= threshold);
    }

    const tookMs = Date.now() - start;
    this.logger.log(
      `RAG 混合检索完成 q=${q.slice(0, 50)} mode=${mode} knn=${knnHits.length} text=${textHits.length} 返回=${items.length} rerank=${useRerank} 阈值=${threshold} took=${tookMs}ms`,
    );
    return {
      items,
      took_ms: tookMs,
      mode,
      stages: {
        embed_ms: embedMs,
        knn_ms: knnMs,
        bm25_ms: bm25Ms,
        fuse_ms: fuseMs,
        rerank_ms: rerankMs,
      },
    };
  }
}
