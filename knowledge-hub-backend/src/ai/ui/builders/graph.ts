/**
 * 知识图谱结果 → surface 的纯函数 builder（P0 铺开）。
 *
 * 截断到 catalog 上限（20 实体 / 40 关系）：超限时**先截再交校验**，
 * 而不是让校验把整块 graphMini 丢掉 —— 少几条边比整张图消失好。
 */
import type { GraphEntity, GraphRelation } from '../../tools/types';
import type { Surface } from '../surface';
import { nextSurfaceId } from './knowledge';

const MAX_ENTITIES = 20;
const MAX_RELATIONS = 40;

export function buildGraphSurface(input: {
  entities: GraphEntity[];
  relations: GraphRelation[];
  surfaceId?: string;
}): Surface {
  return {
    surfaceId: input.surfaceId ?? nextSurfaceId(),
    root: 'root',
    nodes: {
      root: { type: 'stack', props: { gap: 8 }, children: ['graph'] },
      graph: {
        type: 'graphMini',
        props: {
          entities: input.entities.slice(0, MAX_ENTITIES).map((e) => ({
            name: e.name,
            type: e.type ?? '',
            ...(e.description ? { description: e.description } : {}),
          })),
          relations: input.relations.slice(0, MAX_RELATIONS).map((r) => ({
            source: r.source,
            relation: r.relation ?? '',
            target: r.target,
          })),
        },
      },
    },
  };
}
