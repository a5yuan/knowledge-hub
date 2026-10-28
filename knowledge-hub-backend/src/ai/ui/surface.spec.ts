import { CATALOG } from './catalog';
import { validateSurface } from './surface';

/** 构造一个最小合法的 surface，测试里按需改字段 */
function baseSurface(): Record<string, unknown> {
  return {
    surfaceId: 's_test',
    root: 'root',
    nodes: {
      root: { type: 'stack', props: { gap: 8 }, children: ['cards'] },
      cards: {
        type: 'knowledgeCards',
        props: {
          query: '热处理',
          items: [
            { documentId: '1', documentTitle: '淬火工艺规范', excerpt: '摘要' },
          ],
        },
      },
    },
  };
}

describe('validateSurface', () => {
  it('合法 surface 通过，并补全 props 默认值', () => {
    const input = baseSurface();
    // 删掉 gap 与 query，验证 zod default 生效
    const root = (
      input.nodes as Record<string, { props: Record<string, unknown> }>
    ).root;
    const cards = (
      input.nodes as Record<string, { props: Record<string, unknown> }>
    ).cards;
    delete root.props.gap;
    delete cards.props.query;

    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(true);
    expect(result.surface?.nodes.root.props?.gap).toBe(8);
    expect(result.surface?.nodes.cards.props?.query).toBe('');
  });

  it('catalog 外的组件被丢弃，父级继续渲染', () => {
    const input = baseSurface();
    (input.nodes as Record<string, { type: string }>).cards = {
      type: 'knowledgeTabel', // 故意拼错
    };

    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(true);
    // 根节点还在
    expect(result.surface?.nodes.root).toBeDefined();
    // 坏节点被裁掉，且 root 的 children 不再指向它
    expect(result.surface?.nodes.cards).toBeUndefined();
    expect(result.surface?.nodes.root.children).toEqual([]);
    expect(
      result.dropped.some((d) => d.reason.includes('不在 catalog 中')),
    ).toBe(true);
  });

  it('props 非法时丢弃该节点', () => {
    const input = baseSurface();
    (
      input.nodes as Record<string, { props: Record<string, unknown> }>
    ).cards.props = {
      query: 'x',
      items: [{ documentTitle: '缺 documentId' }],
    };

    const result = validateSurface(input, CATALOG);

    expect(result.surface?.nodes.cards).toBeUndefined();
    expect(result.dropped.some((d) => d.reason.includes('参数校验失败'))).toBe(
      true,
    );
  });

  it('循环引用不会死循环', () => {
    const input = baseSurface();
    (input.nodes as Record<string, { children: string[] }>).root.children = [
      'a',
    ];
    (input.nodes as Record<string, unknown>).a = {
      type: 'stack',
      props: {},
      children: ['root'],
    };

    // 若没有环检测，这个用例会超时而不是断言失败
    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(true);
    expect(result.dropped.some((d) => d.reason.includes('循环引用'))).toBe(
      true,
    );
  });

  it('root 不存在时整体丢弃', () => {
    const input = baseSurface();
    input.root = 'not_exists';

    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(false);
    expect(result.surface).toBeUndefined();
  });

  it('节点数超过上限时整体丢弃', () => {
    const input = baseSurface();
    const nodes = input.nodes as Record<string, unknown>;
    for (let i = 0; i < 100; i++) {
      nodes[`n${i}`] = { type: 'markdown', props: { content: 'x' } };
    }

    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(false);
    expect(result.dropped[0].reason).toContain('超过上限');
  });

  it('children 引用了不存在的节点时跳过，不影响父级', () => {
    const input = baseSurface();
    (input.nodes as Record<string, { children: string[] }>).root.children = [
      'cards',
      'ghost',
    ];

    const result = validateSurface(input, CATALOG);

    expect(result.ok).toBe(true);
    expect(result.surface?.nodes.root.children).toEqual(['cards']);
    expect(result.dropped.some((d) => d.reason.includes('不存在的节点'))).toBe(
      true,
    );
  });

  it('不接受子节点的组件带 children 时丢弃', () => {
    const input = baseSurface();
    (input.nodes as Record<string, { children: string[] }>).cards.children = [
      'root',
    ];

    const result = validateSurface(input, CATALOG);

    expect(result.surface?.nodes.cards).toBeUndefined();
    expect(result.dropped.some((d) => d.reason.includes('不接受子节点'))).toBe(
      true,
    );
  });

  it('深度超限时截断', () => {
    const input = {
      surfaceId: 's_deep',
      root: 'd0',
      nodes: {} as Record<string, unknown>,
    };
    for (let i = 0; i < 15; i++) {
      input.nodes[`d${i}`] = {
        type: 'stack',
        props: {},
        children: i < 14 ? [`d${i + 1}`] : [],
      };
    }

    const result = validateSurface(input, CATALOG, { maxDepth: 3 });

    expect(result.ok).toBe(true);
    expect(result.surface?.nodes.d3).toBeDefined();
    expect(result.surface?.nodes.d4).toBeUndefined();
    expect(result.dropped.some((d) => d.reason.includes('深度超过上限'))).toBe(
      true,
    );
  });

  it('结构不合法时整体丢弃且不抛错', () => {
    expect(validateSurface(null, CATALOG).ok).toBe(false);
    expect(validateSurface('nope', CATALOG).ok).toBe(false);
    expect(validateSurface({}, CATALOG).ok).toBe(false);
  });
});
