/**
 * Surface：Agent 输出界面的描述结构（生成式 UI 的「说明单」）。
 *
 * 设计要点（详见 docs/engineering/genui-surface.md）：
 * - 扁平存储：`nodes` 是一张 id → 节点的表，`children` 只存 id 不存完整节点。
 *   好处是校验一次遍历、增量更新按 id 命中、结构上与 A2UI 的 updateComponents 同构。
 * - 语义是「声明式」：模型/代码都不产出界面代码，只引用 `catalog` 里已注册的组件。
 * - 本文件只做**校验与裁剪**，不做渲染。校验失败不抛错——AI 输出不可信，
 *   任何情况下都要退化成「少一块内容」而不是「整页白屏」。
 */
import type { z } from 'zod';

/** 单个界面节点：组件 id + 参数 + 子节点 id 列表 */
export interface SurfaceNode {
  /** catalog 中的组件 id */
  type: string;
  /** 组件参数，可为空；值允许使用 `@data.xxx` 指针引用 surface.data */
  props?: Record<string, unknown>;
  /** 子节点 id 列表，顺序即渲染顺序；容器组件才需要 */
  children?: string[];
}

/*
 * 关于 `@data.xxx` 指针：
 * 类型上保留了 `data` 字段（对齐 A2UI 的 data model 绑定），但 **MVP 不启用指针语法**。
 * 原因是指针会让 props 在 zod 校验前拿到字符串而不是真实值，需要额外一层解析；
 * 而当前只有 knowledgeCards 一个组件消费数据，没有共享收益，不值得引入这层复杂度。
 * P1 若要支持多组件共享同一批数据，在 validateSurface 入口统一解析后再校验即可。
 */

/** 一次界面输出的完整描述 */
export interface Surface {
  /** 仅前端用作渲染 key 与 patch 定位，不落库、不参与业务语义 */
  surfaceId: string;
  /** 根节点 id */
  root: string;
  /** 节点表 */
  nodes: Record<string, SurfaceNode>;
  /** 共享数据；节点 props 通过 `@data.xxx` 引用，避免同一批数据重复序列化 */
  data?: Record<string, unknown>;
}

/** catalog 条目：组件白名单的唯一登记处 */
export interface CatalogEntry {
  /** 给模型看的一句话描述；注入 prompt 时只取它，不注入完整 schema */
  summary: string;
  /** props 校验规则；校验失败该节点整块丢弃 */
  props: z.ZodType;
  /** 是否接受子节点；为 false 时出现 children 会被丢弃 */
  slots: boolean;
}

/** 组件目录：key 即 SurfaceNode.type 的合法取值集合 */
export type Catalog = Record<string, CatalogEntry>;

/** 校验结果：ok=false 表示整块丢弃，前端不会收到该 surface */
export interface SurfaceValidationResult {
  ok: boolean;
  /** 裁剪后的干净 surface：只含可达且校验通过的节点 */
  surface?: Surface;
  /** 被丢弃的节点与原因，仅用于日志排查 */
  dropped: Array<{ id: string; reason: string }>;
}

export interface SurfaceValidateOptions {
  /** 节点数上限，防 Token 爆炸与渲染卡顿 */
  maxNodes?: number;
  /** 嵌套深度上限 */
  maxDepth?: number;
}

const DEFAULT_MAX_NODES = 64;
const DEFAULT_MAX_DEPTH = 8;

/** 结构守卫：只认本文件定义的形状，多余字段一律忽略 */
function isSurfaceShaped(input: unknown): input is Surface {
  if (typeof input !== 'object' || input === null) return false;
  const s = input as Partial<Surface>;
  if (typeof s.surfaceId !== 'string' || s.surfaceId === '') return false;
  if (typeof s.root !== 'string' || s.root === '') return false;
  if (typeof s.nodes !== 'object' || s.nodes === null) return false;
  if (s.data !== undefined && (typeof s.data !== 'object' || s.data === null))
    return false;
  return true;
}

/**
 * 校验并裁剪 surface。
 *
 * 裁剪规则（两层容错）：
 * - 结构性错误（形状不对 / root 不存在 / 节点数超限）→ 整体丢弃
 * - 单节点错误（type 不在 catalog / props 非法 / children 用在不接受子节点的组件上）
 *   → 丢弃该节点及其子树，父级继续渲染
 *
 * 返回的 surface 已不含任何非法节点，前端拿到可直接渲染，不需要二次容错。
 */
export function validateSurface(
  input: unknown,
  catalog: Catalog,
  options: SurfaceValidateOptions = {},
): SurfaceValidationResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dropped: Array<{ id: string; reason: string }> = [];

  if (!isSurfaceShaped(input)) {
    return { ok: false, dropped: [{ id: '-', reason: 'surface 结构不合法' }] };
  }

  const allIds = Object.keys(input.nodes);
  if (allIds.length === 0) {
    return { ok: false, dropped: [{ id: '-', reason: 'nodes 为空' }] };
  }
  if (allIds.length > maxNodes) {
    return {
      ok: false,
      dropped: [
        { id: '-', reason: `节点数 ${allIds.length} 超过上限 ${maxNodes}` },
      ],
    };
  }
  if (!(input.root in input.nodes)) {
    return { ok: false, dropped: [{ id: input.root, reason: 'root 不存在' }] };
  }

  // 第一轮：逐节点校验 type 与 props（与可达性无关，先算出合法集合）
  const legal = new Set<string>();
  for (const id of allIds) {
    const node = input.nodes[id];
    if (
      typeof node !== 'object' ||
      node === null ||
      typeof node.type !== 'string'
    ) {
      dropped.push({ id, reason: '节点结构不合法' });
      continue;
    }
    const entry = catalog[node.type];
    if (!entry) {
      // 白名单之外：模型编了个不存在的组件，这是最常见的一种失败
      dropped.push({ id, reason: `组件 ${node.type} 不在 catalog 中` });
      continue;
    }
    if (node.children !== undefined && !Array.isArray(node.children)) {
      dropped.push({ id, reason: 'children 不是数组' });
      continue;
    }
    if (node.children?.length && !entry.slots) {
      dropped.push({ id, reason: `组件 ${node.type} 不接受子节点` });
      continue;
    }
    const parsed = entry.props.safeParse(node.props ?? {});
    if (!parsed.success) {
      dropped.push({ id, reason: `组件 ${node.type} 参数校验失败` });
      continue;
    }
    legal.add(id);
  }

  // 第二轮：从 root 做 DFS，只保留「可达 + 合法」的节点
  // - visited 同时用来检测重复引用与环
  // - depth 用来拦超深嵌套（模型偶尔会写出自我嵌套的结构）
  const kept = new Set<string>();
  const stack: Array<{ id: string; depth: number }> = [
    { id: input.root, depth: 0 },
  ];
  const visiting = new Set<string>();

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (visiting.has(id)) {
      // 环：已经进过栈一次，直接跳过，不再展开
      dropped.push({ id, reason: '存在循环引用' });
      continue;
    }
    if (!legal.has(id)) continue;
    if (depth > maxDepth) {
      dropped.push({ id, reason: `深度超过上限 ${maxDepth}` });
      continue;
    }
    if (kept.has(id)) {
      // 被多处引用的同一节点只渲染一次，避免重复
      continue;
    }
    kept.add(id);
    visiting.add(id);
    for (const childId of input.nodes[id].children ?? []) {
      if (!(childId in input.nodes)) {
        dropped.push({ id: childId, reason: 'children 引用了不存在的节点' });
        continue;
      }
      stack.push({ id: childId, depth: depth + 1 });
    }
  }

  if (!kept.has(input.root)) {
    return { ok: false, dropped };
  }

  // 第三轮：重建只含保留节点的 surface，并把 props 换成 zod 解析后的归一化值（默认值会补上）
  const nodes: Record<string, SurfaceNode> = {};
  for (const id of kept) {
    const node = input.nodes[id];
    const parsed = catalog[node.type].props.safeParse(node.props ?? {});
    nodes[id] = {
      type: node.type,
      props: parsed.success ? (parsed.data as Record<string, unknown>) : {},
      // 只留指向保留节点的 children，避免前端拿到悬空 id
      children: (node.children ?? []).filter((c) => kept.has(c)),
    };
  }

  return {
    ok: true,
    surface: {
      surfaceId: input.surfaceId,
      root: input.root,
      nodes,
      data: input.data,
    },
    dropped,
  };
}
