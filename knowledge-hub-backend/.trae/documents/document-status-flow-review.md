---
status: historical
updated: 2026-09-15
---

# 文档状态流转工单（审核开关 + 四状态机 + 三索引联动）

> 依据：架构图《文档状态流转图（需审批流程）》+ [init.sql](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/init-scripts/postgresql/init.sql#L27-L43) 已建好的 `kh_document_review` 审核表。
> 用户确认决策：**status 2=待审核 3=已归档**；**审核开启时绕审入口直接 400**；**包含待办/历史查询接口**；**REVIEW_ENABLED 环境变量控制**（关闭时草稿→发布无审核，完全向后兼容）。

## Summary

为 `kh_document.status` 落地四状态机与三索引联动（向量 kh_chunk / 关键词 kh_document / 图谱 Neo4j）：

```
                 REVIEW_ENABLED=false                    REVIEW_ENABLED=true
Draft(0) ── POST /publish ──► Published(1)      Draft(0) ── POST /publish(提审) ──► PendingReview(2)
                                                   ▲ reject(驳回,comment必填)│
                                                   └────────────────────────┘
                                              PendingReview(2) ── POST /approve ──► Published(1) ──投递MQ──► 重建三套索引
Published(1) ── POST /archive(异步清索引) ──► Archived(3)
Published(1) ── POST /save-draft(同步清索引) ──► Draft(0)
```

- **仅 Published(1) 参与三套索引**：Draft/PendingReview/Archived 均不参与（靠"离开 Published 即清索引"保证，检索层不改动）
- 审核开关关闭时行为与现状完全一致（直发 + PATCH 0→1 + 重复发布幂等）
- `kh_document_review`：一次提审一行；approve/reject 回填 review_result/reviewer/reviewed_at；`review_result IS NULL` 为待办

## Current State Analysis

- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L194-L214)：`publish()` 直发 status=1 + dispatchPublish(rag/kg) + dispatchIndex(search 快照)；无状态校验（2/3 状态也能调）
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L268-L288)：`update()` PATCH status 0→1 跳变触发投递，无开关判断
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L125-L134)：`create()` 直接展开 dto（status=1 可绕审）
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L305-L321)：`remove()` 已有"清三索引"完整实现（kh_chunk / kh_document / Neo4j，各自 try/catch），可提取复用
- [document.entity.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/entities/document.entity.ts#L55-L57)：status 注释"0=草稿, 1=已发布, 2=已归档 等"（需更新为权威四值）
- [create-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/create-document.dto.ts#L54-L58)：status 可选字段（需同步注释）
- [document.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.controller.ts#L66-L69)：`@Get(':id')` 在前——新增 `@Get('reviews/pending')` 必须注册在其之前，否则被 `:id` 吞掉
- [init.sql](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/init-scripts/postgresql/init.sql#L27-L43)：`kh_document_review` 表与两个索引**已建好，无需改表**；NestJS 侧无对应实体/代码
- [document.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.controller.ts#L71-L75)：PATCH 注释"status 0→1 跳变会触发队列投递"
- 项目无鉴权体系（authorId/createBy 均为透传字段），审核人身份由请求体传入
- DocumentService 未注入 ConfigService（需新增以读取 REVIEW_ENABLED）

## Proposed Changes

### 1. `.env` 追加（及 .env.example 若存在）

```env
# ---- 文档审核开关（true: /publish=提审，需 /approve 通过才发布；false: /publish 直接发布，现状行为）----
REVIEW_ENABLED=false
```

### 2. 新建 `src/document/entities/document-review.entity.ts`

映射 `kh_document_review`（init.sql 已建表，TypeORM `synchronize:false` 不改表）：

```ts
@Entity('kh_document_review')
export class KhDocumentReview {
  @PrimaryColumn({ type: 'bigint', transformer: { to: v => normalizeSnowflakeId(v), from: v => v } })
  id: string;
  @Column({ type: 'bigint' }) document_id: string;      // snowflake 字符串
  @Column({ type: 'bigint', nullable: true }) reviewer_id: string | null;
  @Column({ type: 'varchar', nullable: true }) reviewer_name: string | null;
  @Column({ type: 'smallint', nullable: true }) review_result: number | null;  // NULL=待审 1=通过 2=驳回
  @Column({ type: 'varchar', nullable: true }) review_comment: string | null;
  @Column({ type: 'smallint' }) before_status: number;
  @Column({ type: 'timestamp', nullable: true }) reviewed_at: Date | null;
  @CreateDateColumn({ type: 'timestamp' }) created_at: Date;
}
```

[document.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.module.ts) `forFeature` 追加 `KhDocumentReview`。

### 3. 状态常量（document.service.ts 顶部导出）

```ts
export const STATUS_DRAFT = 0;
export const STATUS_PUBLISHED = 1;
export const STATUS_PENDING_REVIEW = 2;
export const STATUS_ARCHIVED = 3;
```

[document.entity.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/entities/document.entity.ts#L55-L57) 与 [create-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/create-document.dto.ts#L54) 注释同步为「0=草稿, 1=已发布, 2=待审核, 3=已归档」。

### 4. `document.service.ts` 状态机改造

构造函数追加 `private readonly config: ConfigService`。新增 `private readonly reviewEnabled = ...`（模块初始化时读取 `REVIEW_ENABLED === 'true'`）。

**提取私有 `clearThreeIndexes(docId)`**：把 `remove()` 中三段 try/catch 清理搬进来；`remove()` 改调它（行为不变）。

**重写 `publish(id)`**（保持 POST /document/:id/publish 入口不变，按开关分叉）：

| 前状态 | REVIEW_ENABLED=false | REVIEW_ENABLED=true |
| --- | --- | --- |
| 0 草稿 | status=1 + publish_time + 投递（现状） | status=2 + **写审核记录**(before_status=0) |
| 1 已发布 | 幂等重复发布（现状） | **先 clearThreeIndexes → status=2 + 写审核记录**(before_status=1) |
| 2 待审核 | 400 已在待审核 | 400 已在待审核 |
| 3 已归档 | 400 归档为终态 | 400 归档为终态 |

**新增 `approve(id, dto)`**：
- 校验 status=2，否则 400（仅待审核可审核通过）
- 更新该文档最新一条待审记录：`review_result=1, reviewer_id, reviewer_name, reviewed_at=now`
- `status=1`；`publish_time ??= new Date()`（首审写入，复审保留原发布时间）
- `dispatchPublish + dispatchIndex`（即图示"投递 MQ 重建三套索引"，复用现有链路）

**新增 `reject(id, dto)`**：
- `comment` 必填（空 → 400 驳回意见必填，对齐图示）
- 校验 status=2；更新最新待审记录：`review_result=2, reviewer, comment, reviewed_at`
- `status=0`（回草稿，不清索引——待审核本就无索引）

**新增 `saveDraft(id)`（下架编辑）**：
- 校验 status=1（Draft/PendingReview/Archived 调用 → 400）
- **同步先 clearThreeIndexes**（清理幂等可重试，任一失败抛 500 不落库，保证"清索引后才可编辑"，避免已下架文档残留检索结果）
- 成功后 `status=0`（保留 publish_time 作为历史）

**新增 `archive(id)`**：
- 校验 status=1；`status=3` 先落库（正文保留，不删 Mongo）
- `void this.clearThreeIndexes(docId)` 异步清理（fire-and-forget + 日志，对齐图示"异步清理索引"）

**守卫（堵绕审口子）**：
- `create()`：`reviewEnabled && dto.status === STATUS_PUBLISHED` → 400「审核已开启，请创建草稿后走提审流程」
- `update()`：同样拦截 `dto.status === 1` → 400「审核已开启，发布请走 /publish 提审与 /approve」；审核关闭时维持现状（0→1 投递逻辑不变）
- 审核开启时 `update()` 若把 status 从 1 改为 0（手工下架）？——本期不做拦截（PATCH 语义为元数据更新，下架走 /save-draft），仅拦截 1

### 5. 新建 `src/document/dto/review-action.dto.ts`

```ts
export class ReviewActionDto {
  @IsOptional() @IsString() reviewer_id?: string;    // 审核人ID（雪花字符串）
  @IsOptional() @IsString() reviewer_name?: string;
  @IsOptional() @IsString() comment?: string;        // reject 时必填（service 校验）
}
```

### 6. `document.controller.ts` 新端点

```ts
@Get('reviews/pending/count')    // 必须放在 @Get(':id') 之前！
pendingCount()                   // GET /document/reviews/pending/count → { count: N }（待审核数量，前端角标轮询用）
@Get('reviews/pending')          // 必须放在 @Get(':id') 之前！
pending()                        // GET /document/reviews/pending
@Get(':id/reviews')
history(@Param('id') id)         // GET /document/:id/reviews
@Post(':id/approve')
approve(@Param('id') id, @Body() dto: ReviewActionDto)
@Post(':id/reject')
reject(@Param('id') id, @Body() dto: ReviewActionDto)
@Post(':id/save-draft')
saveDraft(@Param('id') id)
@Post(':id/archive')
archive(@Param('id') id)
```

- `/publish` 注释更新为「REVIEW_ENABLED=false 直接发布；true 提审（Published 重复提审会先清三套索引）」
- PATCH 注释同步

### 7. 待办、数量与历史查询（document.service.ts）

- `pendingReviewCount()`：`reviewRepo.count({ where: { review_result: IsNull() } })` → `{ count }`（命中 `idx_kh_document_review_pending` 部分索引）
- `pendingReviews()`：queryBuilder 查 `kh_document_review r`（`r.review_result IS NULL`，`ORDER BY r.created_at DESC`），leftJoin `kh_document d` 取 `d.title / d.status`；返回 `[{ id, document_id, title, doc_status, before_status, created_at, reviewer_name }]`
- `reviewHistory(docId)`：`WHERE document_id = docId ORDER BY created_at DESC`（含已驳回/通过记录）

## Assumptions & Decisions

- **status 值**：2=待审核、3=已归档（用户确认）；0/1 不动，实体/DTO 注释更新为权威定义
- **开关默认关闭**：`REVIEW_ENABLED=false` 时全部行为与现状逐字节一致，线上/测试零回归
- **绕审口子 400 拒绝**（用户确认）：审核开启时 create/PATCH 携带 status=1 直接报错，状态机唯一入口是 /publish(提审)→/approve
- **待办/历史接口包含**（用户确认）：索引在 init.sql 中本就为待办查询而建
- **save-draft 同步清索引、archive 异步清索引**：严格对齐图示标注（"清索引后可编辑" vs "异步清理索引"）；两种清理均幂等可重试
- **approve 复用现有投递链路**：dispatchPublish + dispatchIndex 即"重建三套索引"，无需新消息类型
- **publish_time 语义**：首审通过写入，复审（1→2→1）保留首次发布时间
- **审核人不鉴权**：项目无鉴权体系，reviewer_id/reviewer_name 由 body 透传
- **归档终态**：Archived 无出边（仅可 DELETE）；正文/原文件保留
- **不做**：检索层 status 过滤（依赖清理语义）、审核人权限/多级审批、超时自动驳回、reject 后消息通知

## Verification

1. `pnpm build` + `pnpm test mq.service`（既有单测不回归）
2. **回归（REVIEW_ENABLED=false）**：POST /publish 直发返回 status=1 + 三索引重建日志；PATCH 0→1 投递；重复发布幂等；curl.md 既有用例全部通过
3. **审核开启流程（REVIEW_ENABLED=true，改 .env 重启）**：
   - `POST /document`（status=1）→ 400；`PATCH /document/:id`（status=1）→ 400
   - 发布草稿（/publish）→ status=2、`GET /document/reviews/pending` 出现该记录、`GET /document/reviews/pending/count` 返回 `{count:1}`、三索引无该文档数据
   - `POST /:id/reject`（不带 comment）→ 400；带 comment → status=0、记录 review_result=2、`GET /:id/reviews` 可见、pending/count 归零
   - 再次 /publish → /approve → status=1、publish_time 写入、日志出现 RAG 分块/向量化/写图 + Search 索引；ES/Neo4j 数据核对
   - `POST /:id/archive` → status=3、异步清理日志、三索引数据归零（kh_chunk/_count、kh_document/_doc found=false、Neo4j MATCH 计数=0）
   - 已发布文档再次 /publish → status=2 且**三套索引先清**（kh_chunk 计数 0、Neo4j Document 消失）
   - `POST /:id/save-draft` → 三索引先清后 status=0
4. `kh_document_review` 行核对：一次提审一行，approve/reject 后 review_result/reviewer/reviewed_at 回填
5. curl.md 增补第 15 节审核流转用例（提交本工单时顺带完成）

## Execution Notes（2026-09-15 实施与验证记录）

1. **表缺失补建**：原假设「init.sql 已建好表」不成立——init.sql 只在数据目录为空的首次建库时执行，现网库早于该 DDL 创建。已对现网库幂等补建（`CREATE TABLE/INDEX IF NOT EXISTS`，与 init.sql L29-43 一致）。新环境无此问题。
2. **ES 写入 refresh 竞态（发现并修复）**：`DocIndexService.indexDocument` 原用 `refresh: false`，文档写入后默认 1s refresh 周期内对 `delete_by_query` 的搜索阶段不可见——「审核通过后立即归档/下架」时清理日志报成功但实际 matched=0，已归档文档残留检索结果。已改为 `refresh: true`（对齐 VectorIndexService bulk 既有惯例）。残余窗口：清理先于消费完成时（消息滞后 > 人工操作间隔，实际可忽略）。
3. **验证结论**（REVIEW_ENABLED 两种模式全流程实测通过）：
   - false 回归：直发 status=1 + 投递；PATCH 0→1 投递；重复发布幂等；pending count 恒 0
   - true 流程：绕审 create/PATCH 均 400；提审 status=2 + 审核记录；pending 列表带 title；count=1；无 comment 驳回 400、带 comment 回草稿 + review_result=2 + 归零；approve 后 publish_time 首审写入、复审保留、三索引重建（ES found=true）；已发布重复提审先清三索引（found=true→false）；save-draft 同步清索引；archive 终态 400 再发布、异步清索引
   - build 通过；mq.service 单测 3/3 通过
   - 已知客户端问题：PowerShell 5.1 发送中文 JSON 变 `?`（服务端存储正确性无问题，Git Bash/UTF-8 文件正常），已在 curl.md 15.2 标注
