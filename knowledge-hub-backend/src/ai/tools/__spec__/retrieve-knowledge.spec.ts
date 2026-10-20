/* eslint-disable @typescript-eslint/require-await -- 测试桩故意用 async 返回已 resolve 的值，无需 await */
import {
  retrieveKnowledge,
  overallGrade,
  gradeLabel,
} from '../retrieve-knowledge';
import { makeHarness, type HarnessOptions } from './stubs';

/**
 * retrieve_knowledge 契约测试（工单 23）。
 *
 * 这是四个工具里分支最多、也是唯一做切题评估的：
 * 0 命中 / 全不切题 / 部分切题 / 评估降级 / 检索异常，五条路径的**返回值语义必须可区分**，
 * 因为编排层把 `items` 直接下发给 `data-retrieve`，把 `content` 交给模型 ——
 * 一旦把「全不切题」误判成「0 命中」，模型会收到错误的行动建议。
 *
 * 另外钉住两条不变量：
 * - `rag.search` 的调用参数恒为 `(query, 5, true, scope)`（topK=5、开 rerank）
 * - 同一文档重复检索走 `SourceRegistry` 去重，编号不变
 */
describe('retrieve_knowledge', () => {
  const DOCS = [
    {
      doc_id: 'doc-1',
      doc_title: '高炉检修规程',
      content: '高炉检修需每年一次。',
    },
    {
      doc_id: 'doc-2',
      doc_title: '转炉操作规程',
      content: '转炉出钢温度控制。',
    },
  ];

  function optsWith(
    grades: Array<'on_topic' | 'partial' | 'off_topic'> | null,
    items = DOCS,
  ): HarnessOptions {
    return {
      search: async () => ({ items }),
      grader: async () => grades,
    };
  }

  it('0 命中：grade=none，items 为空，不发切题评估事件', async () => {
    const h = makeHarness(optsWith(null, []));

    const out = await retrieveKnowledge(
      { query: '冷门问题' },
      { question: '冷门问题' },
      h.deps,
    );

    expect(out.grade).toBe('none');
    expect(out.summary).toBe('知识库 0 条命中');
    expect(out.items).toEqual([]);
    expect(out.content).toContain('无结果');
    expect(h.statuses).toHaveLength(0); // 没资料就不评估
    expect(h.store).toHaveLength(0);
  });

  it('全部不切题：grade=off_topic，items 清空但保留原始条数信息', async () => {
    const h = makeHarness(optsWith(['off_topic', 'off_topic']));

    const out = await retrieveKnowledge(
      { query: '无关问题' },
      { question: '无关问题' },
      h.deps,
    );

    expect(out.grade).toBe('off_topic');
    expect(out.summary).toBe('知识库 2 条均不切题');
    expect(out.items).toEqual([]);
    expect(out.content).toContain('请用 rewrite_query 换检索词重试');
    // 评估前有一次「评估资料...」，评估后有一次「不切题 · 剔除 2 条」
    expect(h.statuses).toHaveLength(2);
    expect(h.statuses[1].text).toContain('不切题');
    expect(h.statuses[1].text).toContain('剔除不切题 2 条');
    expect(h.store).toHaveLength(0);
  });

  it('部分切题：剔除 off_topic，只登记保留条目并按序编号', async () => {
    const h = makeHarness(optsWith(['on_topic', 'off_topic']));

    const out = await retrieveKnowledge(
      { query: '高炉检修' },
      { question: '高炉检修' },
      h.deps,
    );

    expect(out.grade).toBe('on_topic');
    expect(out.items).toHaveLength(1);
    expect(out.items?.[0]).toMatchObject({
      documentId: 'doc-1',
      documentTitle: '高炉检修规程',
    });
    expect(out.content).toContain('[1] 高炉检修规程');
    expect(out.content).toContain('可用 1/2 条');
    expect(h.statuses[1].text).toContain('剔除不切题 1 条');
    expect(h.store).toHaveLength(1);
  });

  it('评估降级（grader 返回 null）：全量保留，整体态按 on_topic 处理', async () => {
    const h = makeHarness(optsWith(null));

    const out = await retrieveKnowledge(
      { query: '高炉' },
      { question: '高炉' },
      h.deps,
    );

    expect(out.grade).toBe('on_topic');
    expect(out.items).toHaveLength(2);
    expect(out.content).toContain('可用 2/2 条');
    expect(h.store).toHaveLength(2);
  });

  it('检索异常：降级文案 + grade=none，不抛错', async () => {
    const h = makeHarness({
      search: async () => {
        throw new Error('ES timeout');
      },
    });

    const out = await retrieveKnowledge(
      { query: '高炉' },
      { question: '高炉' },
      h.deps,
    );

    expect(out.summary).toBe('知识库检索暂不可用');
    expect(out.grade).toBe('none');
    expect(out.items).toEqual([]);
    expect(out.content).toContain('请基于已有信息回答');
    expect(h.warnings.join()).toContain('retrieve_knowledge 降级');
  });

  it('rag.search 调用参数恒为 (query, 5, true, scope)', async () => {
    const calls: unknown[][] = [];
    const scope = {
      userId: 'u1',
      isAdmin: false,
      teamIds: [],
      canReview: false,
    };
    const h = makeHarness({
      search: async (...args: unknown[]) => {
        calls.push(args);
        return { items: DOCS };
      },
      grader: async () => ['on_topic', 'on_topic'],
    });

    await retrieveKnowledge(
      { query: '高炉' },
      { question: '高炉', scope },
      h.deps,
    );

    expect(calls[0]).toEqual(['高炉', 5, true, scope]);
  });

  it('同一文档重复检索：source 按 doc_id 去重，编号不变', async () => {
    const h = makeHarness(optsWith(['on_topic', 'on_topic']));

    const first = await retrieveKnowledge(
      { query: '高炉' },
      { question: '高炉' },
      h.deps,
    );
    const second = await retrieveKnowledge(
      { query: '高炉' },
      { question: '高炉' },
      h.deps,
    );

    expect(h.store).toHaveLength(2); // 2 个文档，两轮各登记一次但去重
    expect(first.content).toContain('[1] 高炉检修规程');
    expect(second.content).toContain('[1] 高炉检修规程');
  });
});

describe('overallGrade / gradeLabel（纯函数）', () => {
  it('无资料 → none；评估降级 → on_topic', () => {
    expect(overallGrade(null, 0)).toBe('none');
    expect(overallGrade(null, 3)).toBe('on_topic');
  });

  it('全不切题 → off_topic；有切题 → on_topic；否则 partial', () => {
    expect(overallGrade(['off_topic', 'off_topic'], 2)).toBe('off_topic');
    expect(overallGrade(['partial', 'on_topic'], 2)).toBe('on_topic');
    expect(overallGrade(['partial', 'partial'], 2)).toBe('partial');
  });

  it('中文文案覆盖四态', () => {
    expect(gradeLabel('on_topic')).toBe('切题');
    expect(gradeLabel('partial')).toBe('部分相关');
    expect(gradeLabel('off_topic')).toBe('不切题');
    expect(gradeLabel('none')).toBe('无结果');
  });
});
