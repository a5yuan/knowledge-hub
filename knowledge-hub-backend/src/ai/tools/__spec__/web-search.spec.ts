/* eslint-disable @typescript-eslint/require-await -- 测试桩故意用 async 返回已 resolve 的值，无需 await */
import { webSearch } from '../web-search';
import { makeHarness } from './stubs';

/**
 * web_search 契约测试（工单 23）。
 *
 * 三条必须钉住的行为：
 * 1. **未配 key 时不发请求**，直接给模型一段可复述的「能力未配置」说明 ——
 *    这条分支在线上很常见（默认没配 TAVILY_SEARCH）；
 * 2. 来源登记走 `push`（**不去重**），这是既有不一致，工单 23 明确不改；
 * 3. 任何异常都降级为可读文本，绝不让异常冒到工具循环（那里虽有 try/catch，
 *    但降级文案会退化成通用的「执行失败」，丢掉「Web 结果缺失」这个关键提示）。
 */
describe('web_search', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetchOnce(payload: unknown, ok = true, status = 200): jest.Mock {
    const fn = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => payload,
    });
    global.fetch = fn;
    return fn;
  }

  it('未配置 key：直接返回「未配置」，且完全不发起请求', async () => {
    const h = makeHarness({ tavilyApiKey: null });
    const fn = mockFetchOnce({});

    const out = await webSearch({ query: '钢铁产能' }, h.deps);

    expect(out.summary).toBe('Web 搜索未配置');
    expect(out.content).toContain('缺少 TAVILY_SEARCH');
    expect(out.results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('命中 2 条：返回 results、正文用 [W1]/[W2] 编号、来源按 push 追加', async () => {
    const h = makeHarness();
    mockFetchOnce({
      results: [
        { title: '标题A', url: 'https://a.example.com/x', content: 'A 正文' },
        { title: '标题B', url: 'https://b.example.com/y', content: 'B 正文' },
      ],
    });

    const out = await webSearch({ query: '钢铁产能' }, h.deps);

    expect(out.summary).toBe('Web 命中 2 条');
    expect(out.results).toEqual([
      { title: '标题A', url: 'https://a.example.com/x' },
      { title: '标题B', url: 'https://b.example.com/y' },
    ]);
    expect(out.content).toContain('[W1] 标题A (a.example.com)');
    expect(out.content).toContain('[W2] 标题B (b.example.com)');
    // 来源标题拼域名、excerpt 按 excerptLen 截断
    expect(h.store).toHaveLength(2);
    expect(h.store[0]).toMatchObject({
      kind: 'web',
      title: '标题A — a.example.com',
      url: 'https://a.example.com/x',
    });
  });

  it('0 条命中：单独文案，不登记来源', async () => {
    const h = makeHarness();
    mockFetchOnce({ results: [] });

    const out = await webSearch({ query: '冷门词' }, h.deps);

    expect(out.summary).toBe('Web 0 条命中');
    expect(out.content).toBe('公网搜索未找到相关结果。');
    expect(h.store).toHaveLength(0);
  });

  it('Tavily 返回非 2xx：降级文案 + warn，不抛错', async () => {
    const h = makeHarness();
    mockFetchOnce({}, false, 503);

    const out = await webSearch({ query: '钢铁' }, h.deps);

    expect(out.summary).toBe('Web 搜索暂不可用');
    expect(out.content).toContain('公网搜索服务暂时不可用');
    expect(out.results).toEqual([]);
    expect(h.warnings.join()).toContain('tavily 503');
  });

  it('fetch 直接抛错（网络异常）：同样降级，不冒泡', async () => {
    const h = makeHarness();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    const out = await webSearch({ query: '钢铁' }, h.deps);

    expect(out.summary).toBe('Web 搜索暂不可用');
    expect(h.warnings.join()).toContain('ECONNRESET');
  });
});
