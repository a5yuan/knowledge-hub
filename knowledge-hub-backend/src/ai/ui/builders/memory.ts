/**
 * 命中的记忆 → surface 的纯函数 builder（P0 铺开）。
 *
 * catalog 上限 3 条：记忆是多条命中按相关度排的，前 3 条已足够说明
 * 「这次回答参考了你的哪些偏好/上下文」，再多会挤占正文空间。
 */
import type { Surface } from '../surface';
import { nextSurfaceId } from './knowledge';

const MAX_MEMORIES = 3;
const TEXT_LEN = 200;

export function buildMemorySurface(input: {
  memories: Array<{ layer: 'user' | 'session'; text: string }>;
  surfaceId?: string;
}): Surface {
  return {
    surfaceId: input.surfaceId ?? nextSurfaceId(),
    root: 'root',
    nodes: {
      root: { type: 'stack', props: { gap: 8 }, children: ['memories'] },
      memories: {
        type: 'memoryChips',
        props: {
          memories: input.memories.slice(0, MAX_MEMORIES).map((m) => ({
            layer: m.layer,
            text: m.text.length > TEXT_LEN ? `${m.text.slice(0, TEXT_LEN)}…` : m.text,
          })),
        },
      },
    },
  };
}
