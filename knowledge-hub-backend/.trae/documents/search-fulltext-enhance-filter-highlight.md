---
status: historical
updated: 2026-09-17
---

# 三期工单：全文检索增强 —— ES 详情接口 + 多词 operator + filter 过滤 + highlight 高亮

> 二期工单 [search-fulltext-pipeline-phase2.md](search-fulltext-pipeline-phase2.md) 明确「不做 highlight 高亮、bool 过滤」留后续迭代，本工单即该后续。
> 用户已确认三项决策：①按 id 拉整篇文档走**新增 ES 详情接口**（不动 GET /document/:id）；②多词匹配**加 operator 参数**（默认 or 保持现状）；③filter **全量支持** status / is_public / category_id / team_id / tags / author_id。

## Summary

| 功能 | 落点 |
|---|---|
| ES 详情接口 | `GET /search/doc/:docId` 从 kh_document 拉整篇快照（含 content），不存在返回 404 |
| 多词匹配 | `operator=or\|and`，or 为默认（现状语义），and 要求 q 分词后全部命中 |
| filter 过滤 | bool.filter + term/terms：status、is_public、category_id、team_id、author_id 单项 term；tags 多值**取交集**（每 tag 一条 term） |
| highlight 高亮 | title/summary 整段（number_of_fragments:0），content 取 3 片段（fragment_size:120），默认 `<em>` 标签 |

## Key Facts（已验证）

- ES v8 `client.get` 文档不存在时抛 ResponseError（`err.meta.statusCode === 404`），try/catch 判 404 返回 null 即可
- multi_match 默认 best_fields 类型基于 match，**支持 `operator: 'and'`**
- highlight 在服务端基于 _source 计算，与 `_source:{excludes:['content']}` 不冲突，content 照样可高亮
- `@Get()` 与 `@Get('doc/:docId')` 路由无冲突；`whitelist: true` 会剥离未声明 query 参数 → 所有新参数必须进 DTO
- bool.filter 内 term 不参与算分，不改变现有相关性排序；is_public/status 未传时不拼（区分「没传」与 false）
- 高亮返回每字段是数组（content 有 3 个片段），前端按数组渲染

## Changes

### 1. src/es/doc-index.service.ts（核心）

- `DocSearchItem` 增加可选 `highlight?: Record<string, string[]>`（向后兼容）
- 新增 `DocSnapshot` 接口（镜像 mapping 全字段，含 content）
- 新增 `getDoc(docId): Promise<DocSnapshot | null>`：

```ts
async getDoc(docId: string): Promise<DocSnapshot | null> {
    await this.ensureReady();
    try {
        const resp = await this.es.getClient().get<DocSnapshot>({ index: DOC_INDEX, id: docId });
        return resp._source ?? null;
    } catch (err) {
        if ((err as { meta?: { statusCode?: number } }).meta?.statusCode === 404) return null;
        throw err;
    }
}
```

- `search()` 扩展签名：`search(q, page, pageSize, opts?: { operator?: 'or'|'and'; filters?: SearchFilters })`
  - 查询体统一改 bool 包裹（评分与现状一致）：`must: [multi_match]`，and 时 multi_match 加 `operator: 'and'`
  - `filter: []` 按入参动态拼 term；tags 逐条 term（交集）；filter 为空不拼 filter 键
  - 追加 `highlight: { fields: { title:{number_of_fragments:0}, summary:{number_of_fragments:0}, content:{number_of_fragments:3, fragment_size:120} } }`（ES 默认 `<em></em>`，无需显式 pre/post_tags）
  - items map 追加 `highlight: hit.highlight`（有值才带）
  - `SearchFilters` 定义为普通可选字段接口（service 不依赖 DTO 类，controller 负责组装）

### 2. src/search/search.dto.ts（扩展）

对齐 query-document.dto.ts 的 @Type 转换风格，全部可选：

```ts
@IsOptional() @IsIn(['or', 'and']) operator: 'or' | 'and' = 'or';
@IsOptional() @Type(() => Number) @IsInt() @Min(0) status?: number;
@IsOptional() @Type(() => Boolean) @IsBoolean() is_public?: boolean;
@IsOptional() @IsString() category_id?: string;   // team_id / author_id 同款
/** 多 tag 交集：支持 ?tags=A,B 与 ?tags=A&tags=B（Transform 归一为数组） */
@IsOptional()
@Transform(({ value }) => Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value)
@IsArray() @IsString({ each: true }) tags?: string[];
```

### 3. src/search/search.controller.ts

- 新增 `@Get('doc/:docId')`（放在 @Get() 前，遵循「具体路由在前」惯例）：调 getDoc，null 时 `throw new NotFoundException(...)`
- `search()` 透传 `{ operator: dto.operator, filters: {...} }` 给 service

### 4. test/curl/payload/curl.md（第 12 节追加）

详情接口（含 404 用例）、operator=and（结果数 ≤ or）、各 filter 单独+组合、tags 两种传法、highlight 断言 `<em>`。统一 `Authorization: Bearer ${ACCESS_TOKEN}`。

## 不做（保持边界）

- 不动 GET /document/:id（PG+Mongo 详情）、mq/pipeline/RAG/KG 链路零改动
- 不做 kNN+BM25 hybrid、不做权限标注变化（/search 维持现状登录即可）
- 不写单测（search 链路无 mock 基建，与二期一致），验证走 build + curl

## Verification

1. `pnpm build` 编译通过
2. 重启 dev server，确认已发布文档在 ES（`GET :9200/kh_document/_count`）
3. curl 序列（UTF-8，--data-urlencode）：
   - 回归：原 `GET /search?q=...` 行为不变（含分页）
   - 详情：`GET /search/doc/{docId}` 返回含 content 整篇快照；不存在 docId → 404
   - operator：`q=前端 分布式`，or vs and，and 结果数 ≤ or
   - filter：`status=1`、`is_public=true`、`category_id=...`、`tags=Java,前端`（交集）、组合过滤
   - highlight：响应 items[].highlight.title/content 含 `<em>`
