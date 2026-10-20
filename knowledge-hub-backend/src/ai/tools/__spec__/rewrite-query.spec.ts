import { rewriteQuery } from '../rewrite-query';
import { makeHarness } from './stubs';

/**
 * rewrite_query 契约测试（工单 23）。
 *
 * 这个工具没有外部依赖，但它是**唯一会向模型下发过程事件**的轻量工具，
 * 因此两个易错点值得钉住：
 * 1. 空检索词必须短路 —— 否则会给模型一条「已改写为：（空）」的假成功回执；
 * 2. `rewrite` 字段承载改写结果，`content` 承载给模型看的指令，两者不能混。
 */
describe('rewrite_query', () => {
  it('正常改写：拼接 terms、下发 rewrite 过程事件、返回改写词', () => {
    const h = makeHarness();

    const out = rewriteQuery(
      { reason: '上次检索词没命中', terms: [' 高炉 ', '检修', ''] },
      h.deps,
    );

    expect(out.rewrite).toBe('高炉 检修');
    expect(out.summary).toBe('已改写：高炉 检修');
    expect(out.content).toContain('已将检索词改写为：高炉 检修');
    expect(out.content).toContain('上次检索词没命中');
    // 过程事件只发一次，stage 固定为 rewrite
    expect(h.statuses).toEqual([
      { stage: 'rewrite', text: '改写查询：高炉 检修' },
    ]);
  });

  it('terms 为空数组：返回「改写无效」，且不下发过程事件', () => {
    const h = makeHarness();

    const out = rewriteQuery({ reason: '不足', terms: [] }, h.deps);

    expect(out.summary).toBe('改写无效');
    expect(out.content).toContain('未提供检索词');
    expect(out.rewrite).toBeUndefined();
    expect(h.statuses).toHaveLength(0);
  });

  it('terms 全是空白字符：与空数组等价（trim 后过滤）', () => {
    const h = makeHarness();

    const out = rewriteQuery(
      { reason: '不足', terms: ['   ', '\n', ''] },
      h.deps,
    );

    expect(out.summary).toBe('改写无效');
    expect(h.statuses).toHaveLength(0);
  });

  it('reason 为空时用「信息不足」兜底，避免出现「（不足原因：）」空括号', () => {
    const h = makeHarness();

    const out = rewriteQuery({ reason: '', terms: ['退火'] }, h.deps);

    expect(out.content).toContain('不足原因：信息不足');
  });
});
