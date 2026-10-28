/**
 * 多个 surface 组合成一张界面。
 *
 * 为什么需要它：surface 的下发语义是「覆盖式，以最后一次为准」。
 * 当一次回答同时有「检索到的文档」和「实体关系图」两种结果时，如果分两次下发，
 * 后一次会把前一次整块替换掉 —— 用户看到卡片闪一下就变样。
 * 正确做法是**组合成一份**再发，前端只做一次渲染。
 *
 * 组合规则：把每个 part 的根节点（约定为 stack）的子节点搬到新 root 下，
 * 节点 id 加序号后缀避免跨 part 冲突。
 */
import type { Surface, SurfaceNode } from '../surface';

export function composeSurfaces(parts: Surface[]): Surface {
  if (parts.length === 0) throw new Error('composeSurfaces 至少需要一个 surface');
  if (parts.length === 1) return parts[0];

  const nodes: Record<string, SurfaceNode> = {};
  const children: string[] = [];

  parts.forEach((part, idx) => {
    const rootNode = part.nodes[part.root];
    if (!rootNode) return;
    // 根是 stack（有 children）时搬子节点；根本身是叶子组件时整个搬过去
    const moveIds = rootNode.children?.length ? rootNode.children : [part.root];
    for (const id of moveIds) {
      const node = part.nodes[id];
      if (!node) continue;
      const key = `${id}__p${idx}`;
      nodes[key] = node;
      children.push(key);
    }
  });

  nodes.root = { type: 'stack', props: { gap: 12 }, children };

  return {
    surfaceId: parts[0].surfaceId,
    root: 'root',
    nodes,
  };
}
