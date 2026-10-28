/**
 * 联网搜索结果 → surface 的纯函数 builder（P0 铺开）。
 *
 * 与 knowledge 同构：stack 包一层，便于将来「结果 + 来源」并列时直接加子节点。
 */
import type { WebResult } from '../../tools/types';
import type { Surface } from '../surface';
import { nextSurfaceId } from './knowledge';

export function buildWebSurface(input: {
  query: string;
  results: WebResult[];
  surfaceId?: string;
}): Surface {
  return {
    surfaceId: input.surfaceId ?? nextSurfaceId(),
    root: 'root',
    nodes: {
      root: { type: 'stack', props: { gap: 8 }, children: ['links'] },
      links: {
        type: 'webLinks',
        props: {
          query: input.query,
          // catalog 上限 10：这里先截断，避免整块因超限被校验丢弃
          results: input.results.slice(0, 10).map((r) => ({
            title: r.title || '（无标题）',
            url: r.url ?? '',
          })),
        },
      },
    },
  };
}
