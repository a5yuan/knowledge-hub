/* eslint-disable @typescript-eslint/require-await -- 测试桩故意用 async 返回已 resolve 的值，无需 await */
import { retrieveGraph } from '../retrieve-graph';
import { makeHarness, type HarnessOptions } from './stubs';

/**
 * retrieve_graph 契约测试（工单 23）。
 *
 * 最值得钉住的是「关系两端实体补齐」：前端 mini 力导图按 `entities` 着色，
 * 若某条关系的两端不在 `entities` 里，前端会出现**没有节点的边**（渲染异常或灰边）。
 * 原实现为此在关系遍历里补 push 实体，重构时必须原样保留。
 */
describe('retrieve_graph', () => {
  const ENTITIES = [
    { name: '高炉', type: 'tech', description: '炼铁主体设备' },
    { name: '检修规程', type: 'term', description: null },
  ];
  const EDGES = [
    {
      sourceName: '高炉',
      sourceType: 'tech',
      relation: 'RELATED_TO',
      targetName: '检修规程',
      targetType: 'term',
    },
  ];

  function graphOpts(): HarnessOptions {
    return {
      searchGraph: async () => ({ entities: ENTITIES, edges: EDGES }),
    };
  }

  it('命中关系：每条关系登记一条 graph 来源并带全局编号', async () => {
    const h = makeHarness(graphOpts());

    const out = await retrieveGraph({ query: '高炉' }, h.deps);

    expect(out.summary).toBe('图谱命中 实体 2 / 关系 1');
    expect(out.relations).toEqual([
      { source: '高炉', relation: 'RELATED_TO', target: '检修规程' },
    ]);
    // 编号从 1 开始
    expect(out.content).toContain(
      '[1] 图谱关系：高炉（tech）—RELATED_TO→ 检修规程（term）',
    );
    expect(h.store).toHaveLength(1);
    expect(h.store[0]).toMatchObject({
      kind: 'graph',
      ref: 'graph:高炉->RELATED_TO->检修规程',
      title: '高炉 —RELATED_TO→ 检修规程',
      // excerpt 取两端 description，高炉有值
      excerpt: '炼铁主体设备',
    });
  });

  it('0 条关系：提示改用文档检索，实体列表仍返回', async () => {
    const h = makeHarness({
      searchGraph: async () => ({ entities: ENTITIES, edges: [] }),
    });

    const out = await retrieveGraph({ query: '不存在的实体' }, h.deps);

    expect(out.summary).toBe('图谱 0 条命中（实体 2）');
    expect(out.content).toContain('请改用 retrieve_knowledge');
    expect(out.entities).toHaveLength(2);
    expect(out.relations).toEqual([]);
    expect(h.store).toHaveLength(0);
  });

  it('关系两端不在实体列表时自动补齐（保证前端力导图节点完整）', async () => {
    const h = makeHarness({
      searchGraph: async () => ({
        // 只返回一个实体，关系的 target 缺失
        entities: [{ name: '高炉', type: 'tech', description: '主体设备' }],
        edges: [
          {
            sourceName: '高炉',
            sourceType: 'tech',
            relation: 'RELATED_TO',
            targetName: '点检制度',
            targetType: 'term',
          },
        ],
      }),
    });

    const out = await retrieveGraph({ query: '高炉' }, h.deps);

    const names = (out.entities ?? []).map((e) => e.name);
    expect(names).toContain('高炉');
    expect(names).toContain('点检制度');
    // 补齐的实体 description 为 undefined（原文用 undefined 而非 null）
    expect(
      out.entities?.find((e) => e.name === '点检制度')?.description,
    ).toBeUndefined();
  });

  it('Neo4j 不可用：degraded=true + 空数组，且不抛错', async () => {
    const h = makeHarness({
      searchGraph: async () => {
        throw new Error('Neo4j connection refused');
      },
    });

    const out = await retrieveGraph({ query: '高炉' }, h.deps);

    expect(out.summary).toBe('知识图谱暂不可用');
    expect(out.degraded).toBe(true);
    expect(out.entities).toEqual([]);
    expect(out.relations).toEqual([]);
    expect(h.warnings.join()).toContain('retrieve_graph 降级');
  });

  it('同一批关系重复检索：graph 来源按 ref 去重，编号不变', async () => {
    const h = makeHarness(graphOpts());

    const first = await retrieveGraph({ query: '高炉' }, h.deps);
    const second = await retrieveGraph({ query: '高炉' }, h.deps);

    expect(h.store).toHaveLength(1); // 去重生效
    expect(first.content).toContain('[1]');
    expect(second.content).toContain('[1]'); // 仍取既有编号
  });
});
