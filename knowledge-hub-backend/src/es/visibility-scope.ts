/**
 * 文档可见性作用域（09 号工单：三检索链路基于用户可见性过滤）
 *
 * 规则（满足任一即可见，对齐设计图《文档可见性控制》）：
 * 1. 自己的文档（author_id = 当前用户），任何状态
 * 2. 已发布（status=1）且 is_public=true —— 全员可见
 * 3. 已发布（status=1）且 team_id ∈ 用户所在团队 —— 团队成员可见
 * 补充：canReview=true（ROLE_ADMIN/ROLE_REVIEWER）可见待审核（status=2）文档——
 *       审核工作台详情走 GET /document/:id，不放开会打断审核流
 * admin（ROLE_ADMIN）免过滤（buildVisibilityFilter 返回 undefined）
 *
 * 纯函数、无 Nest 依赖：
 * - ES 召回过滤用 buildVisibilityFilter（kh_document / kh_chunk 共用）
 * - PG 列表与详情判定用 isDocVisible（与 ES DSL 语义一一对应）
 */

/** 可见性作用域（由登录用户 + kh_team_member 查询派生，见 TeamService.resolveVisibilityScope） */
export interface VisibilityScope {
  /** 当前用户ID（雪花字符串） */
  userId: string;
  /** 用户所在团队ID列表（可为空数组；admin 免过滤时不查库） */
  teamIds: string[];
  /** 是否超管（roles 含 ROLE_ADMIN）：免过滤 */
  isAdmin: boolean;
  /** 是否可审核（admin 或 ROLE_REVIEWER）：可见待审核文档 */
  canReview: boolean;
}

/** 可见性判定所需字段（PG kh_document 行与 ES 快照的交集） */
export interface VisibleDocFields {
  author_id?: string | null;
  team_id?: string | null;
  status?: number;
  is_public?: boolean;
  deleted?: boolean;
}

/** 文档状态：已发布（与 document.service.ts 的 STATUS_PUBLISHED 语义一致；此处独立定义避免 es↔document 循环引用） */
const STATUS_PUBLISHED = 1;
/** 文档状态：待审核（同上，对齐 STATUS_PENDING_REVIEW） */
const STATUS_PENDING_REVIEW = 2;

/**
 * 构建 ES 可见性过滤子句（bool.should + minimum_should_match=1，作为 bool.filter 的一条 clause 使用）：
 * - admin → undefined（调用方不拼 filter）
 * - teamIds=[] 时 terms 自然不命中，无需特判
 * - canReview 追加「status=2」分支（ES 中待审核文档通常已被清理，此分支主要服务 PG 侧同一语义）
 */
export function buildVisibilityFilter(
  scope: VisibilityScope,
): Record<string, unknown> | undefined {
  if (scope.isAdmin) return undefined;
  const should: Record<string, unknown>[] = [
    // 规则 1：本人文档，任何状态
    { term: { author_id: scope.userId } },
    // 规则 2：已发布 + 公开
    {
      bool: {
        filter: [
          { term: { status: STATUS_PUBLISHED } },
          { term: { is_public: true } },
        ],
      },
    },
    // 规则 3：已发布 + 本团队
    {
      bool: {
        filter: [
          { term: { status: STATUS_PUBLISHED } },
          { terms: { team_id: scope.teamIds } },
        ],
      },
    },
  ];
  if (scope.canReview) {
    // 审核人可见待审核文档（与 isDocVisible 保持同一语义）
    should.push({ term: { status: STATUS_PENDING_REVIEW } });
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/**
 * 单文档可见性判定（PG 列表/详情与 ES 详情共用，语义与 buildVisibilityFilter 一一对应）：
 * admin 全见；软删不可见；其余按规则 1~3（+ 审核人待审核）判定
 */
export function isDocVisible(doc: VisibleDocFields, scope: VisibilityScope): boolean {
  if (scope.isAdmin) return true;
  if (doc.deleted) return false;
  // 规则 1：本人文档（author_id 为空不算本人）
  if (doc.author_id && doc.author_id === scope.userId) return true;
  // 审核人可见待审核
  if (scope.canReview && doc.status === STATUS_PENDING_REVIEW) return true;
  // 规则 2/3 均要求已发布
  if (doc.status !== STATUS_PUBLISHED) return false;
  if (doc.is_public) return true;
  if (doc.team_id && scope.teamIds.includes(doc.team_id)) return true;
  return false;
}
