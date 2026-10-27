---
status: current
updated: 2026-10-27
---

# 子系统：文档主域（`knowledge-hub-backend/src/document/`）

改文档 CRUD、上传、审核流转之前必读。

## 职责

**负责**：文档生命周期 —— 创建 / 上传 / 更新 / 删除、状态机流转（草稿→待审→发布→归档）、审核记录（`document-review`）、与前端列表查询的契约。

**不负责**：文件解析（`file/` + `mineru/` 分发）、切片与 embedding（`pipeline/`）、全文索引写入（`es/`）。本模块发布后**发 MQ 事件**，由消费者接手后续。

## 不变量

1. **状态码固定**：`0` 草稿 / `1` 已发布 / `2` 待审核 / `3` 已归档（`document.entity.ts`）。流转设计见 `.trae/documents/document-status-flow-review.md`。
2. **审核相关路由必须声明在 `@Get(':id')` 之前**。已在 `document.controller.ts` 验证的既有顺序：

```
@Get('reviews/pending/count')   ← 必须在 :id 之前（角标轮询用）
@Get('reviews/pending')         ← 必须在 :id 之前
@Get(':id/reviews')
@Get(':id')
```

3. **审核记录必须存 `before_status`**（`document-review.entity.ts`）。驳回后要能还原到提审前的状态，这个字段是唯一依据。

## 依赖方向

```
document/ ──→ mq/（发布后发 document.events）
          ──→ es/（发布后索引，经消费者而非直接调用）
          ──→ storage/（附件）

document/ ──✗ 不直接调用 rag/、kg/、pipeline/
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `document.controller.ts` | 路由 + 审核子路径声明顺序 |
| `document.service.ts` | CRUD + `publish` / `approve` / `reject` / `saveDraft` / `archive` |
| `entities/document.entity.ts` | 状态码定义（0/1/2/3） |
| `entities/document-review.entity.ts` | 审核记录（`before_status` / `review_result`） |
| `dto/query-document.dto.ts` | 列表查询条件（改动频繁，每次加筛选都要动） |

## 已知陷阱

### 归属校验缺失，`author_id` 取自请求体

文档 CRUD **未做归属校验**，`author_id` / `create_by` 从请求体取而非 Token。可越权伪造作者。这是已知缺陷（见 `../pitfalls.md` §四），改这里时不要以为"反正有 Guard 就安全了"。

### 状态机是数字，不是枚举字符串

`status` 是 `number`，数据库里存 0/1/2/3。写比较时注意 `0` 是合法值 —— 用 `!== undefined` 判空，不要用真值判断（见 `../code-standards.md` §二）。这是本模块最容易犯的错，因为"草稿"恰好是 falsy。

### 审核链路与 stats 大盘有隐含耦合

`reviews/pending/count` 被前端角标轮询调用，改动返回形状会直接影响布局。大盘的待办数字另有 `stats/` 独立计算，两处口径要手动保持一致。

## 测试方式

- 真实用例沉淀在 `knowledge-hub-backend/test/curl/`（不是 spec）
- 手工链路：上传 → 提审 → 审核（approve/reject）→ 发布 → 归档，每步看 MQ 消费者日志
- 状态流转的完整设计背景见 `.trae/documents/document-status-flow-review.md`（已入库）
