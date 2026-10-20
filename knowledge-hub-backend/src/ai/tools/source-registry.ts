/**
 * 引用登记表（工单 23：从 `ai-agent.service.ts:830-843` 的 `registerSource` 逐行搬运）。
 *
 * **行为必须与原实现完全一致**（`sources.service.spec` 钉住）：
 * - key 取 `ref ?? url ?? ''`；key 为空则不去重
 * - 去重键是 `kind + key`，同 kind 同 ref 命中返回既有编号（1-based）
 * - 未命中则 push，返回新长度
 *
 * 两个方法对应两种既有行为：
 * - `register` = 原 `registerSource`（知识库 / 图谱）
 * - `push` = 原 `sources.push(...)`（web_search 现状，不去重）
 */
import type { SourceDraft, SourceRegistry } from './types';

/**
 * 用给定数组作为底层存储创建登记表。
 *
 * 传入数组而非内部新建：编排层在循环外声明 `sources` 并多处直接读它
 * （`data-sources` 事件、最终落库），登记表必须与它共享同一份引用。
 */
export function createSourceRegistry(store: SourceDraft[]): SourceRegistry {
  return {
    register(draft: SourceDraft): number {
      const key = draft.ref ?? draft.url ?? '';
      if (key) {
        const idx = store.findIndex(
          (s) => s.kind === draft.kind && (s.ref ?? s.url ?? '') === key,
        );
        if (idx >= 0) return idx + 1;
      }
      store.push(draft);
      return store.length;
    },

    push(draft: SourceDraft): number {
      store.push(draft);
      return store.length;
    },

    all(): SourceDraft[] {
      return store;
    },
  };
}
