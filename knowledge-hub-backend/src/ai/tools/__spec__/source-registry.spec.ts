import { createSourceRegistry } from '../source-registry';
import type { SourceDraft } from '../types';

/**
 * SourceRegistry 编号语义（工单 23 验收项 5）。
 *
 * 编号 `n` 会立即被拼进工具返回的 `content`（`[1] 标题`），前端再按同一序号渲染来源列表。
 * 一旦去重键或 1-based 语义变了，回答里的 `[n]` 就会指向错误的来源 —— 这是本次重构
 * 风险最高的一处，因此单独立测，不混在工具用例里。
 */
describe('SourceRegistry', () => {
  const doc = (
    id: string,
    kind: SourceDraft['kind'] = 'knowledge',
  ): SourceDraft => ({
    kind,
    title: `标题-${id}`,
    ref: id,
    heading: null,
  });

  it('首次登记返回 1，重复登记返回既有编号（1-based）', () => {
    const store: SourceDraft[] = [];
    const reg = createSourceRegistry(store);

    expect(reg.register(doc('a'))).toBe(1);
    expect(reg.register(doc('b'))).toBe(2);
    expect(reg.register(doc('a'))).toBe(1); // 去重命中
    expect(store).toHaveLength(2);
  });

  it('去重键是 kind + ref：同 ref 不同 kind 视为不同来源', () => {
    const store: SourceDraft[] = [];
    const reg = createSourceRegistry(store);

    expect(reg.register(doc('x', 'knowledge'))).toBe(1);
    expect(reg.register(doc('x', 'graph'))).toBe(2);
    expect(store).toHaveLength(2);
  });

  it('没有 ref 也没有 url 时不参与去重，每次都追加', () => {
    const store: SourceDraft[] = [];
    const reg = createSourceRegistry(store);

    const anonymous: SourceDraft = {
      kind: 'knowledge',
      title: '无 ref',
      heading: null,
    };
    expect(reg.register(anonymous)).toBe(1);
    expect(reg.register(anonymous)).toBe(2);
    expect(store).toHaveLength(2);
  });

  it('push 不去重（web_search 的既有行为）', () => {
    const store: SourceDraft[] = [];
    const reg = createSourceRegistry(store);

    expect(reg.push(doc('a'))).toBe(1);
    expect(reg.push(doc('a'))).toBe(2); // 与 register 不同：不查重
    expect(store).toHaveLength(2);
  });

  it('all() 返回底层数组本身（编排层与登记表共享同一引用）', () => {
    const store: SourceDraft[] = [];
    const reg = createSourceRegistry(store);
    reg.register(doc('a'));

    expect(reg.all()).toBe(store);
  });
});
