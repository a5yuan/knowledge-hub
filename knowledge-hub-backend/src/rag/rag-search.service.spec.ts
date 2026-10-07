import { RerankService } from './rerank.service';
import { RagSearchService, rrfFuse } from './rag-search.service';
import { ChunkHit } from '../es/vector-index.service';
import { EmbeddingService } from '../pipeline/embedding.service';
import { RerankResult } from './rerank.service';
import { TracingService } from '../observability/tracing.service';

/** 造一个切块命中 */
function hit(docId: string, chunkIndex: number, score = 1): ChunkHit {
  return {
    doc_id: docId,
    doc_title: `标题-${docId}`,
    chunk_index: chunkIndex,
    content: `${docId} 的第 ${chunkIndex} 块内容`,
    score,
  };
}

describe('rrfFuse（RRF 倒数排名融合）', () => {
  it('单路结果按 1/(k+rank) 打分且降序排列', () => {
    const fused = rrfFuse([[hit('a', 0), hit('a', 1)]]);
    expect(fused).toHaveLength(2);
    expect(fused[0].doc_id).toBe('a');
    expect(fused[0].chunk_index).toBe(0);
    expect(fused[0].rrfScore).toBeCloseTo(1 / 61, 10);
    expect(fused[1].rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it('同 chunk 出现在两路时分数相加且只保留一份（去重键 doc_id+chunk_index）', () => {
    const fused = rrfFuse([
      [hit('a', 0), hit('b', 0)],
      [hit('b', 0), hit('c', 0)],
    ]);
    // a 只在路 1 rank1：1/61；b 在路 1 rank2 + 路 2 rank1：1/62+1/61；c 只在路 2 rank2：1/62
    expect(fused).toHaveLength(3);
    const b = fused.find((f) => f.doc_id === 'b')!;
    expect(b.rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 10);
    const a = fused.find((f) => f.doc_id === 'a')!;
    const c = fused.find((f) => f.doc_id === 'c')!;
    expect(a.rrfScore).toBeCloseTo(1 / 61, 10);
    expect(c.rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it('双路同时命中的 chunk 排在单路命中之前（融合分更高）', () => {
    const fused = rrfFuse([[hit('a', 0), hit('b', 0)], [hit('b', 0)]]);
    expect(fused[0].doc_id).toBe('b');
  });
});

describe('RagSearchService（混合检索编排）', () => {
  const embedding = {
    embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  } as unknown as EmbeddingService;
  let vectorIndex: { knnSearch: jest.Mock; textSearch: jest.Mock };
  let rerank: { rerank: jest.Mock };
  let config: { get: jest.Mock };
  let service: RagSearchService;

  beforeEach(() => {
    vectorIndex = { knnSearch: jest.fn(), textSearch: jest.fn() };
    rerank = { rerank: jest.fn() };
    config = { get: jest.fn(() => undefined) };
    service = new RagSearchService(
      vectorIndex as never,
      embedding,
      rerank as never,
      config as never,
      // 工单 13：真实 TracingService（本环境无 LANGFUSE_ENABLED/Key → 自动关闭，等价于改动前行为）
      new TracingService(),
    );
  });

  it('rerank 成功：按 relevance_score 重排，score 取相关性得分、rank 重新编号', async () => {
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0), hit('b', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('b', 0), hit('c', 0)]);
    // 融合序：b0(双路) > a0 > c0 → candidates=[b0, a0, c0]；重排把 c0 提到第一，b0 第二
    rerank.rerank.mockResolvedValue([
      { index: 2, relevance_score: 0.95 },
      { index: 0, relevance_score: 0.5 },
    ] as RerankResult[]);

    const result = await service.search('测试问题', 2, true);

    expect(vectorIndex.knnSearch).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      50,
      undefined,
    );
    expect(vectorIndex.textSearch).toHaveBeenCalledWith(
      '测试问题',
      50,
      undefined,
    );
    expect(rerank.rerank).toHaveBeenCalledWith(
      '测试问题',
      expect.any(Array),
      2,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      doc_id: 'c',
      chunk_index: 0,
      score: 0.95,
      rank: 1,
    });
    expect(result.items[1]).toMatchObject({ doc_id: 'b', score: 0.5, rank: 2 });
    expect(result.took_ms).toBeGreaterThanOrEqual(0);
  });

  it('rerank 失败（返回 null）：降级为 RRF 顺序截断 topK，score 为 RRF 融合分', async () => {
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0), hit('b', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('b', 0), hit('c', 0)]);
    rerank.rerank.mockResolvedValue(null);

    const result = await service.search('测试问题', 2, true);

    // 融合序 b > a > c，取前 2
    expect(result.items.map((i) => i.doc_id)).toEqual(['b', 'a']);
    expect(result.items[0].rank).toBe(1);
    expect(result.items[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(result.items[1].score).toBeCloseTo(1 / 61, 10);
  });

  it('useRerank=false：跳过重排直接 RRF 顺序返回', async () => {
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('b', 0)]);

    const result = await service.search('测试问题', 5, false);

    expect(rerank.rerank).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.doc_id)).toEqual(['a', 'b']);
  });

  it('11 号工单：RAG_SCORE_THRESHOLD > 0 时丢弃低于阈值的分数', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'RAG_SCORE_THRESHOLD' ? '0.6' : undefined,
    );
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0), hit('b', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('b', 0), hit('c', 0)]);
    rerank.rerank.mockResolvedValue([
      { index: 2, relevance_score: 0.95 },
      { index: 0, relevance_score: 0.5 },
    ] as RerankResult[]);

    const result = await service.search('测试问题', 5, true);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ doc_id: 'c', score: 0.95 });
  });

  it('双路均无结果：返回空 items', async () => {
    vectorIndex.knnSearch.mockResolvedValue([]);
    vectorIndex.textSearch.mockResolvedValue([]);

    const result = await service.search('测试问题', 5, true);

    expect(rerank.rerank).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });

  it('09 号工单：传入 scope 时双路召回带同一条可见性 filter', async () => {
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('a', 0)]);
    rerank.rerank.mockResolvedValue(null);

    await service.search('测试问题', 5, false, {
      userId: 'U1',
      teamIds: ['T1'],
      isAdmin: false,
      canReview: false,
    });

    const expectedFilter = {
      bool: {
        should: [
          { term: { author_id: 'U1' } },
          {
            bool: {
              filter: [{ term: { status: 1 } }, { term: { is_public: true } }],
            },
          },
          {
            bool: {
              filter: [{ term: { status: 1 } }, { terms: { team_id: ['T1'] } }],
            },
          },
        ],
        minimum_should_match: 1,
      },
    };
    expect(vectorIndex.knnSearch).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      50,
      expectedFilter,
    );
    expect(vectorIndex.textSearch).toHaveBeenCalledWith(
      '测试问题',
      50,
      expectedFilter,
    );
  });

  it('09 号工单：admin scope → 双路 filter 均为 undefined（免过滤）', async () => {
    vectorIndex.knnSearch.mockResolvedValue([hit('a', 0)]);
    vectorIndex.textSearch.mockResolvedValue([hit('a', 0)]);

    await service.search('测试问题', 5, false, {
      userId: 'U1',
      teamIds: [],
      isAdmin: true,
      canReview: true,
    });

    expect(vectorIndex.knnSearch).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      50,
      undefined,
    );
    expect(vectorIndex.textSearch).toHaveBeenCalledWith(
      '测试问题',
      50,
      undefined,
    );
  });
});

describe('RerankService（dashscope 重排）', () => {
  let fetchSpy: jest.SpyInstance;
  let service: RerankService;

  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'OPENAI_API_KEY') return 'test-key';
      if (key === 'RERANK_MODEL') return def;
      return def;
    }),
  };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    service = new RerankService(config as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('成功：解析 output.results 返回 index+relevance_score', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: { results: [{ index: 1, relevance_score: 0.88 }] },
      }),
    });

    const results = await service.rerank('q', ['doc1', 'doc2'], 1);

    expect(results).toEqual([{ index: 1, relevance_score: 0.88 }]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/services/rerank/text-rerank/text-rerank');
    const body = JSON.parse(init.body);
    expect(body.parameters).toEqual({ return_documents: false, top_n: 1 });
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });

  it('非 200 响应：返回 null（降级信号），不抛异常', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });

    const results = await service.rerank('q', ['doc1'], 1);

    expect(results).toBeNull();
  });

  it('fetch 抛错（网络/超时）：返回 null（降级信号），不抛异常', async () => {
    fetchSpy.mockRejectedValue(new Error('aborted'));

    const results = await service.rerank('q', ['doc1'], 1);

    expect(results).toBeNull();
  });

  it('响应缺 output.results：返回 null', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const results = await service.rerank('q', ['doc1'], 1);

    expect(results).toBeNull();
  });
});
