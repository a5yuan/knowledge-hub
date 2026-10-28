/**
 * 引用来源 → surface 的纯函数 builder（P0 铺开）。
 *
 * excerpt 截断到 200 字：来源卡片只展示摘要，完整内容在 sources 里已有，
 * surface 抄一份长文本只会让消息体膨胀。
 */
import type { AiSourceV2 } from '../../ai-session.service';
import type { Surface } from '../surface';
import { nextSurfaceId } from './knowledge';

const MAX_SOURCES = 50;
const EXCERPT_LEN = 200;

export function buildSourcesSurface(input: {
  sources: AiSourceV2[];
  surfaceId?: string;
}): Surface {
  return {
    surfaceId: input.surfaceId ?? nextSurfaceId(),
    root: 'root',
    nodes: {
      root: { type: 'stack', props: { gap: 8 }, children: ['sources'] },
      sources: {
        type: 'sourceList',
        props: {
          sources: input.sources.slice(0, MAX_SOURCES).map((s) => ({
            index: s.index,
            kind: s.kind,
            title: s.title ?? '',
            ...(s.ref ? { ref: s.ref } : {}),
            ...(s.url ? { url: s.url } : {}),
            ...(s.excerpt
              ? {
                  excerpt:
                    s.excerpt.length > EXCERPT_LEN
                      ? `${s.excerpt.slice(0, EXCERPT_LEN)}…`
                      : s.excerpt,
                }
              : {}),
          })),
        },
      },
    },
  };
}
