# Document API 测试 curl

> 基础地址：`http://localhost:3000`，后端需已启动。
> **鉴权（全局 Guard 生效）**：除 `/auth/register`、`/auth/login`、`/auth/refresh`、根路由健康检查外，所有接口必须携带 `-H "Authorization: Bearer ${ACCESS_TOKEN}"`（下文示例已统一携带）。先执行第 16 节登录，再回到本节测试。
> 上传接口为**异步解析**：`POST /document/upload` 立即返回 `parse_state=pending`，轮询详情拿结果。
> Windows 的 cmd 控制台下 curl 会按 GBK 发送中文文件名（服务端无法还原）；中文文件名用例请在 Git Bash / WSL / macOS / 浏览器中执行。
> **PowerShell 用户注意**：Windows PowerShell 5.1 中 `curl` 是 `Invoke-WebRequest` 的别名，会报「找不到驱动器 http」；请统一使用 `curl.exe`（或改用 Git Bash / cmd）。

```bash
# 前置：登录拿 token（详见第 16 节），测试账号 admin / reviewer / user 密码均为 123456
ACCESS_TOKEN='登录返回的 accessToken'
REFRESH_TOKEN='登录返回的 refreshToken'
```

## 1. 上传 PDF（走 MinerU flash 通道，含 authorId / createBy）

```bash
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'file=@./李先生_28岁_76761.pdf' \
  -F 'authorId=10001' \
  -F 'createBy=10001' | jq
```

返回草稿摘要 JSON（示例）：

```json
{
  "id": "7504751718287020032",
  "title": "李先生_28岁_76761",
  "parse_state": "pending",
  "poll_url": "/document/7504751718287020032",
  "source_file_url": "http://localhost:9000/knowledge-hub/documents/7504751718287020032/李先生_28岁_76761.pdf"
}
```

创建成功后，把返回的 `id` 赋给变量：

```bash
DOC_ID='替换成返回的id'
```

支持的格式：`pdf` / `docx` / `pptx` / `xlsx` / `txt` / `md`，大小 ≤ 10MB（对齐 flash 通道限制）。

---

## 2. 上传 TXT（直读，不走 MinerU，秒级完成）

```bash
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'file=@./upload.sample.txt' \
  -F 'authorId=10002' | jq
```

---

## 3. 轮询解析状态（success / failed 时停止）

```bash
for i in $(seq 1 24); do
  sleep 5
  STATE=$(curl -s "http://localhost:3000/document/${DOC_ID}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq -r '.parse_state')
  echo "[poll ${i}] parse_state=${STATE}"
  [ "${STATE}" = "success" ] || [ "${STATE}" = "failed" ] && break
done
```

解析失败时查看原因：

```bash
curl -s "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{parse_state, parse_error}'
```

---

## 4. 详情（元数据 + Markdown 正文 + 解析状态）

```bash
curl -s "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{id, title, author_id, create_by, parse_state, word_count, summary, content, source_file_name, source_file_url}'
```

预期：`author_id=10001`、`parse_state=success`、`content` 为 MinerU 产出的 Markdown。

---

## 5. 异常用例

非法 authorId（非纯数字，预期 400）：

```bash
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'file=@./upload.sample.txt' \
  -F 'authorId=abc' | jq
```

不支持的格式（预期 400）：

```bash
echo dummy > ./bad.exe
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'file=@./bad.exe' | jq
```

缺少 file 字段（预期 400）：

```bash
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'notfile=@./upload.sample.txt' | jq
```

文件超过 10MB（预期 413）：

```bash
dd if=/dev/zero of=./big.txt bs=1M count=11 2>/dev/null
curl -s -X POST http://localhost:3000/document/upload \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -F 'file=@./big.txt' | jq
```

---

## 6. 创建文档（JSON，不经文件上传）

```bash
curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "新员工入职指南（研发中心）",
    "summary": "研发中心新员工第一周入职清单：账号开通、环境搭建、规范学习与常见问题。",
    "tags": "入职,研发中心,onboarding,内部规范",
    "status": 1,
    "is_public": false,
    "remark": "面向校招/社招研发同学，季度复核一次",
    "category_id": "20001",
    "team_id": "30001",
    "author_id": "10001",
    "create_by": "10001"
  }' | jq
```

---

## 7. 列表（分页 + 标题模糊搜索）

```bash
curl -s 'http://localhost:3000/document?page=1&pageSize=10&title=入职' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

按标签过滤：

```bash
curl -s 'http://localhost:3000/document?page=1&pageSize=10&tags=onboarding' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

---

## 8. 更新

```bash
curl -s -X PATCH "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "新员工入职指南（研发中心）v1.1",
    "summary": "v1.1：补充远程入职流程、试用期目标模板。",
    "tags": "入职,研发中心,onboarding,内部规范,远程办公",
    "remark": "v1.1 已同步 HRBP 与 IT",
    "update_by": "10001"
  }' | jq
```

---

## 9. 软删除（同时清理 ES 索引 kh_chunk / kh_document 与 Neo4j 图谱）

```bash
curl -s -X DELETE "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

删除后再查详情应返回 404：

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"
```

ES 中该文档的全文快照与 RAG 切块应一并清理（服务端日志出现 `ES 切块已删除` / `ES 文档快照已删除`）：

```bash
curl -s "http://localhost:9200/kh_document/_doc/${DOC_ID}" | jq '.found'   # 预期 false（或 404）
curl -s "http://localhost:9200/kh_chunk/_search?q=doc_id:${DOC_ID}&size=1" | jq '.hits.total.value'  # 预期 0
```

Neo4j 中该文档的 Document/Chunk 节点一并清理、孤儿实体被回收（服务端日志出现 `Neo4j 图谱已清理 docId=...`）：

```bash
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 "MATCH (d:Document {docId:'${DOC_ID}'}) RETURN count(d) AS docs"              # 预期 0
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 "MATCH (e:Entity) WHERE NOT EXISTS { ()-[:MENTIONS]->(e) } RETURN count(e) AS orphans"  # 预期 0
```

---

## 10. 发布文档（status=1，投递 RAG/KG 两队列 + Search 快照索引消息）

```bash
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

预期返回：`{"id":"...","status":1,"publish_time":"...","queues":["rag","kg"],"indexExchange":"kh.document.exchange"}`。
同一文档重复发布是幂等的：RAG 管线先删旧切块再写入（kh_chunk 块数不变）；Search 快照按 `_id=docId` 覆盖写（kh_document 条数不变）；KG 管线先删旧图谱再重建（Document/Chunk 结构稳定，实体数随 LLM 抽取可能小幅浮动）。

也可通过更新接口触发（仅 status 0→1 跳变时投递，重复 PATCH 不重投）：

```bash
curl -s -X PATCH "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @./update.status.published.json | jq '{id, status, publish_time}'
```

---

## 11. 验证 RAG 管线结果（ES 索引 kh_chunk）

```bash
# 切块总数
curl -s "http://localhost:9200/kh_chunk/_count" | jq

# 按文档查切块（正文/标题均为 ik 中文分词）
curl -s "http://localhost:9200/kh_chunk/_search?q=doc_id:${DOC_ID}&size=3&_source=doc_id,doc_title,chunk_index,content" | jq

# 全文检索（BM25）
curl -s "http://localhost:9200/kh_chunk/_search?q=content:前端开发&size=3&_source=doc_title,chunk_index,content" | jq

# 向量 kNN 检索（用 dashscope 生成查询向量后 kNN 查询，参考 pipeline 流程）
curl -s "http://localhost:9200/kh_chunk/_mapping" | jq '.kh_chunk.mappings.properties.embedding'
```

服务端日志应依次出现：`消息已投递 exchange=document.events routingKey=rag` → `分块完成` → `向量化完成 ... 维度=1024` → `ES 写入完成` → `消息消费完成`。
RabbitMQ 管理台 http://localhost:15672 （guest/guest）：`rag.queue` / `kg.queue` 消费后 Ready≈0（KG 管线验证见第 13 节）。

---

## 12. 验证全文检索链路（topic 交换机 kh.document.exchange → ES 索引 kh_document）

发布时服务端构建**整篇文档快照（元数据 + 正文）**，经 topic 交换机 `kh.document.exchange`（routing key `document.index`）投递到 `kh.document.search.queue`，Search 消费者直接写入 ES 索引 `kh_document`（`_id=docId`，重复发布覆盖更新）。

```bash
# 快照落库核对（title/summary/content/元数据齐全，中文正常）
curl -s "http://localhost:9200/kh_document/_doc/${DOC_ID}" | jq '._source | del(.content)'

# 索引总数（重复发布后应保持不变）
curl -s "http://localhost:9200/kh_document/_count" | jq
```

服务端日志应依次出现：`消息已投递 exchange=kh.document.exchange routingKey=document.index` → `ES 文档索引完成 index=kh_document docId=...` → `Search 管线完成 docId=...` → `消息消费完成 queue=kh.document.search.queue`。

### 检索 API（GET /search?q=，对 title^2/summary/content 做 ik 中文分词检索，需登录）

```bash
# 关键词检索（URL 中文需编码，Git Bash 下可用 --data-urlencode 配 -G）
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端技术栈' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# 分页
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=入职' --data 'page=1' --data 'pageSize=5' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

预期返回：`{"total":N,"page":1,"pageSize":10,"items":[{"doc_id","title","summary","word_count","publish_time","score","highlight"?}]}`（结果不回传整篇正文 content）。

### 检索增强（三期：operator 多词匹配 / filter 过滤 / highlight 高亮 / ES 详情）

```bash
# 多词 operator=and（q 分词后全部命中，结果数 ≤ 默认 or）
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端 分布式' --data 'operator=and' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{total, operator_used: .items[0].doc_id}'
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端 分布式' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.total'   # or 基准对比

# filter：状态 + 可见性（term 过滤，不算分不影响排序）
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端' --data 'status=1' --data 'is_public=true' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.total'

# filter：多 tag 交集（?tags=A,B 逗号分隔；也可 ?tags=A&tags=B 重复参数）
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端' --data-urlencode 'tags=Java,前端' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.total'

# filter：按分类/团队/作者（雪花 ID 按实际替换）
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端' --data "category_id=${CATEGORY_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.total'

# highlight 高亮：title/summary 整段、content 3 片段，默认 <em> 标签包裹命中词
curl -s -G 'http://localhost:3000/search' --data-urlencode 'q=前端技术栈' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.items[0].highlight'

# ES 详情：按 docId 拉整篇快照（含 content 正文）
curl -s "http://localhost:3000/search/doc/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{doc_id: .doc_id, title, content_len: (.content | length)}'

# ES 详情 404：不存在的 docId
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/search/doc/9999999999999999999" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"   # 预期 404
```

预期：highlight 断言 `items[].highlight.title` / `.content` 含 `<em>`；operator=and 的 total ≤ or；各 filter 与无条件检索对比 total 变化；详情接口 `.content` 非空且 `.doc_id == $DOC_ID`。

---

## 13. 验证 KG 管线结果（Neo4j 图谱，发布时与 RAG 同步触发）

发布消息同时投递 `kg.queue`，KG 管线：查 Mongo 快照 → 复用 RAG 分块（chunkMarkdown，与向量块一一对应）→ qwen-plus 抽取实体/关系（structured output 约束 JSON）→ 写 Neo4j。

图模型：`(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[:RELATED_TO {relation}]->(:Entity)`。
实体类型：`person` / `org` / `tech` / `location` / `term` / `other`；实体按 `name+type` MERGE 去重（跨文档同名实体自动合并）；`relation` 文本存关系属性。

服务端日志应依次出现：`消息已投递 exchange=document.events routingKey=kg` → `KG 分块完成 docId=... 块数=... maxChars=500` → `KG 实体关系抽取完成 docId=... 块数=...`（逐块调 LLM，11 块约 3 分钟）→ `Neo4j 驱动已初始化 uri=bolt://localhost:7687` → `Neo4j 写图完成 docId=... chunks=... entities=... relations=...` → `KG 管线完成 docId=...`。

```bash
# ① 文档节点与切块数（与 RAG 切块数一致，同一 chunker）
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 \
  "MATCH (d:Document {docId:'${DOC_ID}'}) OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk) RETURN d.docId, d.title, count(c) AS chunks;"

# ② 实体提及次数与去重后实体数（mentions ≥ entities）
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 \
  "MATCH (:Chunk {docId:'${DOC_ID}'})-[m:MENTIONS]->(e:Entity) RETURN count(m) AS mentions, count(DISTINCT e) AS entities;"

# ③ 实体类型分布
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 \
  "MATCH (:Chunk {docId:'${DOC_ID}'})-[:MENTIONS]->(e:Entity) RETURN e.type AS type, count(DISTINCT e) AS cnt ORDER BY cnt DESC;"

# ④ 实体间关系样例（RELATED_TO 的 relation 为关系属性）
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 \
  "MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity) RETURN a.name, r.relation, b.name LIMIT 10;"
```

也可浏览器打开 http://localhost:7474 （neo4j/12345678）可视化核对：

```cypher
MATCH p=(:Document {docId:'替换成DOC_ID'})-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity) RETURN p LIMIT 100
```

幂等性核对：重复发布后 Document=1、Chunk 数稳定、无重复 MENTIONS 边（先删后写）；LLM 抽取非确定性，实体/关系数允许小幅浮动。

```bash
# 无重复 MENTIONS（预期 0）
docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 \
  "MATCH (c:Chunk {docId:'${DOC_ID}'})-[m:MENTIONS]->(e:Entity) WITH c, e, count(m) AS cnt WHERE cnt > 1 RETURN count(*) AS dup_pairs;"
```

---

## 14. KG 失败路径（停 Neo4j）与恢复

```bash
# 1) 停 Neo4j
docker stop knowledge_hub_neo4j

# 2) 发布文档 → 触发 KG 消费失败
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

预期（服务端日志约 **30~60 秒**后出现——驱动 executeWrite 重试窗口，非立即失败）：

```
ERROR [MqService] 消费失败 queue=kg.queue docId=${DOC_ID}: Failed to connect to server. Please ensure that your database is listening on the correct host and port ...
```

| 验证点   | 预期                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 消息处置 | 失败消息被 **ack 丢弃**，RabbitMQ 管理台 `kg.queue` Ready=0 / Unacked=0（队列不堵塞） |
| 故障隔离 | 同一发布的 RAG / Search 管线正常完成，应用保持存活（接口仍返回 200）                  |
| 应用启动 | Neo4j 宕机时应用可正常启动（驱动懒初始化，启动时不连库）                              |

```bash
# 3) 恢复：重启 Neo4j，等容器日志出现 "Bolt enabled on 0.0.0.0:7687" 后重新发布
docker start knowledge_hub_neo4j
docker logs knowledge_hub_neo4j --since 2m 2>&1 | grep "Bolt enabled"
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

预期日志：`Neo4j 写图完成 docId=${DOC_ID} ...` → `KG 管线完成 docId=${DOC_ID}`（驱动在下次 session 自动重连，**应用无需重启**），第 13 节的 Cypher 核对恢复正常。

消费失败语义由单元测试固化（失败/成功/毒消息均 ack 不 nack）：`pnpm test mq.service`。

---

## 15. 文档状态流转（REVIEW_ENABLED 审核开关 + 四状态机）

> 状态机（审核开启）：`0 草稿 → 2 待审核 → 1 已发布 → 3 已归档`；审核关闭时 `0 → 1` 直发（现状行为）。
> 仅 **已发布(1)** 参与三套索引（kh_chunk / kh_document / Neo4j），离开已发布状态即清理。
> 开关在 `.env` 的 `REVIEW_ENABLED`（true=提审需 `/approve`；false=直发），**改后需重启应用**。
> **审核人身份自 token 注入**（approve/reject 请求体仅 `comment`），审核接口需 `ROLE_REVIEWER` / `ROLE_ADMIN` 角色（user 账号 → 403）。审批人下拉数据源见第 16 节 reviewer-ids。

### 15.1 回归：REVIEW_ENABLED=false（关闭，现状行为）

```bash
# 创建草稿（不带 status，默认 0），记录返回 id 为 DOC_ID
curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Review Off Test"}' | jq

# 发布 → 直接发布：status=1 + publish_time + 投递 rag/kg 队列 + Search 快照
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# PATCH 0→1 跳变仍触发投递；重复发布幂等（status 保持 1）
curl -s -X PATCH "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' -d '{"status":1}' | jq

# 待审核数量恒为 0（不产生审核记录）
curl -s http://localhost:3000/document/reviews/pending/count \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq   # {"count":0}
```

### 15.2 审核开启：REVIEW_ENABLED=true（改 .env 后重启）

```bash
# 1) 绕审拦截：创建 / PATCH 携带 status=1 直接 400
curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Bypass","status":1}' | jq                          # → 400
curl -s -X PATCH "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' -d '{"status":1}' | jq       # → 400

# 2) 提审：草稿 → 待审核（status=2，写 kh_document_review 记录 before_status=0）
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
# {"id":"...","status":2,"before_status":0,"review":"submitted",...}

# 3) 待审核数量 + 待办列表（角标轮询）
curl -s http://localhost:3000/document/reviews/pending/count \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq   # {"count":1}
curl -s http://localhost:3000/document/reviews/pending \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq   # 含 title / doc_status / before_status

# 4) 角色拦截：user 账号 token 审核直接 403（需 ROLE_REVIEWER / ROLE_ADMIN）
USER_TOKEN='第 16 节 user 账号登录返回的 accessToken'
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/approve" \
  -H "Authorization: Bearer ${USER_TOKEN}" \
  -H 'Content-Type: application/json' -d '{}' | jq                 # → 403 无权限

# 5) 驳回：comment 必填（缺失 → 400；成功 → status=0 回草稿，待办归零）
#    审核人 = token 注入的当前登录用户（不再从请求体透传）
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/reject" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' -d '{}' | jq                 # → 400 驳回意见必填
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/reject" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"comment":"格式不符合规范，请修改后重新提交"}' | jq
# 中文 comment 注意：Windows PowerShell 会把请求体编码为 ?，请用 Git Bash / WSL / UTF-8 payload 文件

# 6) 审核历史（含通过/驳回，按提审时间倒序；reviewer_id/reviewer_name 来自 token）
curl -s "http://localhost:3000/document/${DOC_ID}/reviews" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# 7) 再次提审 → 通过：status=1 + publish_time（首审写入，复审保留）+ 三索引重建
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/approve" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' -d '{"comment":"符合规范，通过"}' | jq
```

预期日志：`RAG 分块` / `向量化` / `Neo4j 写图完成` / `[DocIndexService] ES 文档索引完成`。

### 15.3 已发布 → 重复提审（先清三套索引再入待审核）

```bash
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq   # status=2, before_status=1

# 核对索引已清 + 审核表回填
curl -s "http://localhost:9200/kh_document/_doc/${DOC_ID}" | jq           # "found": false
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "SELECT review_result, before_status, reviewer_name, reviewed_at FROM kh_document_review WHERE document_id=${DOC_ID} ORDER BY created_at;"
# 一次提审一行；approve/reject 后 review_result / reviewer（来自 token）/ reviewed_at 回填，待办只看 review_result IS NULL
```

### 15.4 下架编辑与归档（终态）

```bash
# 先恢复已发布：提审 → 通过（同 15.2 第 7 步）

# 下架编辑（仅已发布）：同步清三套索引 → status=0（索引清理失败则 500 不落库，可重试）
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/save-draft" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# 归档（仅已发布，终态）：status=3，三套索引异步清理，正文与原文件保留
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/archive" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s "http://localhost:9200/kh_document/_doc/${DOC_ID}" | jq           # "found": false

# 已归档再发布 → 400（归档无出边，仅可 DELETE）
curl -s -X POST "http://localhost:3000/document/${DOC_ID}/publish" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq   # → 400
```

| 验证点     | 预期                                                                  |
| ---------- | --------------------------------------------------------------------- |
| 绕审拦截   | 审核开启时 create / PATCH 携带 status=1 → 400                         |
| 角色拦截   | approve / reject 使用 user 账号 token → 403                           |
| 提审       | status=2 + kh_document_review 新增一行（review_result IS NULL）       |
| 待审核数量 | `GET /document/reviews/pending/count` 与待办行数一致                  |
| 驳回       | comment 必填；status=0 回草稿；review_result=2；待办归零              |
| 通过       | status=1；首审写 publish_time、复审保留；RAG/KG/Search 三索引重建     |
| 审核人     | reviewer_id / reviewer_name = token 注入的当前登录用户                |
| 索引联动   | 仅 status=1 存在 ES/Neo4j 数据；提审/下架/归档/重复提审后 found=false |

---

## 16. 用户模块（注册 / 登录 / 双 token 鉴权）

> 双 token：`accessToken`（2h，调业务接口，过期即废不可续期）+ `refreshToken`（7d，仅用于换新 token，**不能**调业务接口）。
> 除 register / login / refresh 外全部接口需登录；全局 JwtAuthGuard 无 token → 401，角色不足 → 403。
> 配置在 `.env`：`JWT_SECRET` / `JWT_ACCESS_EXPIRES=2h` / `JWT_REFRESH_EXPIRES=7d`。
> 预置测试账号（init.sql，密码均 `123456`）：`admin`（管理员+审核员）/ `reviewer`（审核员）/ `user`（普通用户）。

### 16.1 注册（公开，不自动登录）

```bash
# 成功：返回 userId + 提示语（密码 ≥6 位；默认绑定 ROLE_USER）
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"zhangsan","password":"123456","email":"zhangsan@company.com","realName":"张三"}' | jq
# {"userId":"...","message":"注册成功，请登录"}

# 异常：重复用户名 → 409；密码 <6 位 → 400；邮箱格式非法 → 400
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"zhangsan","password":"123456"}' | jq               # → 409 用户名已存在
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"lisi","password":"123"}' | jq                      # → 400 密码至少 6 位
```

### 16.2 登录（公开，签发双 token）

```bash
# 成功：accessToken + refreshToken + tokenType + expiresIn(7200) + userInfo（含角色）
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"123456"}' | jq
```

预期返回（示例）：

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "expiresIn": 7200,
  "userInfo": {
    "userId": "1000000000000000001",
    "username": "admin",
    "realName": "系统管理员",
    "email": "admin@company.com",
    "avatar": null,
    "roles": ["ROLE_ADMIN", "ROLE_REVIEWER"]
  }
}
```

把返回值赋给变量（第 1-15 节测试均依赖）：

```bash
ACCESS_TOKEN='登录返回的 accessToken'
REFRESH_TOKEN='登录返回的 refreshToken'

# user 账号登录（403 角色拦截用例用）
USER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"user","password":"123456"}' | jq -r '.accessToken')
```

异常：用户不存在 / 密码错误统一 401 `用户名或密码错误`（防用户名枚举）；禁用账号 401 `用户已被禁用`。

```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"wrong"}' | jq                   # → 401
```

### 16.3 鉴权语义验证（全局 Guard 生效）

```bash
# 无 token 访问业务接口 → 401
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/document   # 401

# 带 accessToken → 200
curl -s http://localhost:3000/document?page=1&pageSize=1 \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '.total'

# refreshToken 不能调业务接口 → 401（type 校验）
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://localhost:3000/document?page=1&pageSize=1" \
  -H "Authorization: Bearer ${REFRESH_TOKEN}"                          # 401

# 伪造 token → 401
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://localhost:3000/document?page=1&pageSize=1" \
  -H 'Authorization: Bearer abc.def.ghi'                               # 401
```

### 16.4 me 接口（当前登录用户信息）

```bash
curl -s http://localhost:3000/auth/me \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
# {"userId":"...","username":"admin","realName":"系统管理员","email":"...","avatar":null,"roles":["ROLE_ADMIN","ROLE_REVIEWER"]}
```

### 16.5 reviewer-ids 接口（审批员列表，approve/reject 审核人下拉数据源）

```bash
curl -s http://localhost:3000/auth/reviewer-ids \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
# 预期含 reviewer（审核员张三）与 admin；user（普通用户）不在列表
# [{"userId":"1000000000000000002","username":"reviewer","realName":"审核员张三"}, ...]
```

### 16.6 refresh 接口（轮换双 token）

```bash
# 成功：返回新的 accessToken + refreshToken（旧的 refresh 未做服务端吊销，有效期 7d 内仍可用）
curl -s -X POST http://localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"${REFRESH_TOKEN}\"}" | jq

# 异常：传 accessToken 冒充 → 401；伪造/过期 → 401
ACCESS_AS_REFRESH=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"123456"}' | jq -r '.accessToken')
curl -s -X POST http://localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"${ACCESS_AS_REFRESH}\"}" | jq               # → 401
```

### 16.7 access token 过期演练（可选）

```bash
# 1) .env 临时改 JWT_ACCESS_EXPIRES=5s 并重启
# 2) 登录后等 5 秒，业务接口 401
# 3) refresh 换新 token 后恢复访问；演练完改回 2h 并重启
```

| 验证点                | 预期                                                         |
| --------------------- | ------------------------------------------------------------ |
| 注册                  | 返回 userId + 提示语；重复用户名 409；密码 <6 位 400         |
| 登录                  | 双 token + expiresIn=7200 + userInfo.roles；错误密码统一 401 |
| 全局 Guard            | 无 token 401；refreshToken 调业务接口 401；伪造 token 401    |
| me                    | 与登录返回的 userInfo 一致（含角色）                         |
| reviewer-ids          | 含 reviewer/admin，不含 user；按账号启用状态过滤             |
| refresh               | 轮换签发新双 token；access 冒充/伪造/过期 401；禁用用户 401  |
| 角色拦截（联动 15.2） | user 账号 approve/reject → 403                               |

鉴权核心语义由单元测试固化：`pnpm test auth.service`。

---

## 17. 邮箱注册激活与找回密码（REQUIRE_EMAIL_VERIFICATION + Redis + SMTP）

> **开关在 `.env` 的 `REQUIRE_EMAIL_VERIFICATION`**（默认 false：注册立即可登录，现状行为；true：注册后 `email_verified=0 + status=0`，需邮件激活才能登录），**改后需重启应用**。
> 邮件走 SMTP（`.env` MAIL_*，QQ 邮箱需填授权码）；**MAIL_USER 未配置（空或占位 xx@xx.com）时进入 DEV 兜底**——激活链接 / 验证码从服务端日志 `[DEV 兜底]` 行获取，链路仍可跑通。
> Redis（docker.compose.yml `redis` 服务，6379）：存激活 token（24h）与重置验证码（10 分钟），key 前缀 `email:activation:` / `email:reset:`。
> 找回密码三接口均 @Public（未登录场景）；激活链接 `GET /auth/verify-email?token=` 在浏览器直接打开，返回 HTML 结果页。

### 17.1 回归：REQUIRE_EMAIL_VERIFICATION=false（现状行为）

```bash
# 注册 → email_verified=1/status=1，立即可登录，不发激活邮件
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailoff01","password":"123456","email":"mailoff01@company.com"}' | jq

curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailoff01","password":"123456"}' | jq '.tokenType, .userInfo.roles'   # Bearer
```

### 17.2 激活链路：REQUIRE_EMAIL_VERIFICATION=true（改 .env 后重启）

```bash
# 1) 注册（true 时 email 必填，缺失 → 400；邮箱重复 → 409）
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailon01","password":"123456","email":"mailon01@company.com","realName":"邮箱测试"}' | jq
# {"userId":"...","message":"注册成功，请查收激活邮件并完成激活后再登录"}

# 异常：缺邮箱 → 400；重复邮箱 → 409
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' -d '{"username":"mailon02","password":"123456"}'        # 400
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailon03","password":"123456","email":"mailon01@company.com"}'             # 409

# 2) 未激活登录 → 403（明确提示，无法登录）
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailon01","password":"123456"}' | jq
# {"message":"邮箱未激活，请查收激活邮件完成激活后再登录","error":"Forbidden","statusCode":403}

# 3) 核对 Redis：激活 token（TTL≈86400，值为 userId）
docker exec knowledge_hub_redis redis-cli keys 'email:activation:*'
docker exec knowledge_hub_redis redis-cli ttl "email:activation:<上一步的token>"

# 4) 浏览器打开激活链接（DEV 兜底模式从服务端日志 [DEV 兜底] 行复制；SMTP 已配置则查收邮件）
#    http://localhost:3000/auth/verify-email?token=<token>          → HTML「邮箱激活成功」
#    重复打开同一链接 → HTML「激活失败：链接无效或已过期」（token 一次性）

# 5) 激活后登录 → 双 token
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"mailon01","password":"123456"}' | jq '.userInfo | {userId, email, roles}'

# 6) 重发激活邮件（防枚举：无论邮箱是否存在统一提示；仅未激活账号真正发信）
curl -s -X POST http://localhost:3000/auth/resend-activation \
  -H 'Content-Type: application/json' \
  -d '{"email":"mailon01@company.com"}' | jq
```

### 17.3 找回密码（邮箱验证码，未登录场景）

```bash
# 0) 准备：确保 admin@company.com 已激活（预置账号默认已激活）

# 1) 发送验证码（防枚举：统一模糊提示；验证码从邮件 / 服务端日志 [DEV 兜底] 行获取）
curl -s -X POST http://localhost:3000/auth/password/send-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@company.com"}' | jq

# 核对 Redis：验证码 TTL≈600
docker exec knowledge_hub_redis redis-cli keys 'email:reset:*'
docker exec knowledge_hub_redis redis-cli get "email:reset:admin@company.com"

# 2) 错误验证码 → 400（且不消耗正确码）
curl -s -X POST http://localhost:3000/auth/password/reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@company.com","code":"000000","newPassword":"765432"}' | jq    # → 400 验证码错误或已过期

# 3) 正确验证码重置 → 成功（验证码一次性失效）
curl -s -X POST http://localhost:3000/auth/password/reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@company.com","code":"<收到的6位码>","newPassword":"765432"}' | jq

# 4) 原码重放 → 400（一次性）
# 5) 新密码登录 → 双 token；旧密码 → 401
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"765432"}' | jq '.tokenType'                   # Bearer
```

| 验证点            | 预期                                                         |
| ----------------- | ------------------------------------------------------------ |
| 注册分叉（false） | email_verified=1/status=1，注册即可登录（现状回归）          |
| 注册分叉（true）  | email_verified=0/status=0；email 必填 400、重复邮箱 409      |
| 未激活登录        | 403「邮箱未激活，请查收激活邮件完成激活后再登录」            |
| 激活链接          | 一次性：首次 HTML 成功页，重复打开失败页；Redis token 被消费 |
| 重发激活          | 统一模糊提示（防枚举）；仅未激活账号真正发信                 |
| send-code         | 6 位码写 Redis TTL≈600；防枚举统一提示；未激活账号不发码     |
| reset 一次性      | 错码 400 不消耗正确码；成功后原码重放 400                    |
| 重置后登录        | 新密码成功、旧密码 401                                       |

注册激活与找回密码语义由单元测试固化：`pnpm test auth.service user.service`。

---

## 18. RBAC 权限模块（三级权限 + 全局三 Guard）

> 全局 Guard 链：JwtAuthGuard（401）→ RolesGuard（403 角色不足）→ PermissionsGuard（403 权限不足，ROLE_ADMIN 旁路）。
> 权限语义：用户最终权限 = 角色权限 ∪ 直赋权限（去重合并，仅 status=1 且未删除）。
> 权限码按需实时查询（不进 token / userInfo / /auth/me），前端菜单/按钮渲染调 `GET /auth/permissions`。
> 种子：init.sql 预置菜单/按钮码；**reviewer 直赋 document:create**（kh_user_permission 4200000000000000001，需先应用种子增量，见 18.4）。
> 试点标注：POST /document、PATCH /document/:id、DELETE /document/:id、approve/reject（@Roles + @RequirePermission 叠加）。

### 18.1 权限查询（GET /auth/permissions，三账号对比）

```bash
# admin：roles 含 ROLE_ADMIN，Guard 全旁路；permissions 反映角色授权行（admin 种子无授权行 → 多为空）
curl -s http://localhost:3000/auth/permissions \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# user：角色授权 dashboard/document/search/profile + 文档 list/create/edit/delete
USER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"user","password":"123456"}' | jq -r '.accessToken')
curl -s http://localhost:3000/auth/permissions -H "Authorization: Bearer ${USER_TOKEN}" | jq
# 预期：buttons 含 document:create/edit/delete/list；menus 为 document 树（含子级），无 system

# reviewer：角色授权 document:list + document:review + search；直赋 document:create（图1 扩展能力）
REVIEWER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"123456"}' | jq -r '.accessToken')
curl -s http://localhost:3000/auth/permissions -H "Authorization: Bearer ${REVIEWER_TOKEN}" | jq
# 预期：codes 同时含 document:review（角色）与 document:create（直赋）；buttons 含两者
```

### 18.2 权限码校验矩阵（接口级，PermissionsGuard）

```bash
# admin：无授权行仍全通过（Admin 旁路，图4；NestJS POST 默认返回 201 Created）
curl -s -o /dev/null -w 'admin create:  HTTP %{http_code}\n' -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"title":"perm-admin-test"}'                                                    # 201

# user：有 document:create/delete → 200；无 document:review → approve 403
DOC_ID=$(curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"title":"perm-user-test"}' | jq -r '.id')
curl -s -o /dev/null -w 'user approve:  HTTP %{http_code}\n' -X POST "http://localhost:3000/document/${DOC_ID}/approve" \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"comment":"x"}'                                                                # 403（RolesGuard 先拦：角色不足）
curl -s -o /dev/null -w 'user delete:   HTTP %{http_code}\n' -X DELETE "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${USER_TOKEN}"                                            # 200（有 document:delete；201=创建成功默认码）

# reviewer：无 document:delete → 403 权限不足（PermissionsGuard 拦，与角色层 403 文案不同）
curl -s -X DELETE "http://localhost:3000/document/${DOC_ID}" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" | jq
# {"message":"无权限操作，需要权限之一：document:delete","error":"Forbidden","statusCode":403}
```

### 18.3 直赋生效对照（角色权限 ∪ 直赋权限，图1 扩展能力）

```bash
# 1) reviewer 创建文档：角色无 document:create，但直赋生效 → 201
RDOC_ID=$(curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"title":"perm-reviewer-direct"}' | jq -r '.id')                                # 201

# 2) 删除直赋行 → 权限即时收敛（实时查询，无需重启/重登录）
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "DELETE FROM kh_user_permission WHERE id=4200000000000000001;"

# 3) 再创建 → 403 权限不足
curl -s -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"title":"perm-reviewer-direct-2"}' | jq                                        # 403 document:create

# 4) 恢复直赋行（幂等种子）
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "INSERT INTO kh_user_permission (id, user_id, permission_id) VALUES (4200000000000000001, 1000000000000000002, 4000000000000000012) ON CONFLICT (id) DO NOTHING;"
curl -s -o /dev/null -w 'restored create: HTTP %{http_code}\n' -X POST http://localhost:3000/document \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"title":"perm-reviewer-direct-3"}'                                             # 201
```

### 18.4 首次启用：应用种子增量（已有 PG 卷不重跑 init.sql）

```bash
docker cp init-scripts/postgresql/init.sql knowledge_hub_postgres:/tmp/init.sql
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub -f /tmp/init.sql
# 幂等（CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING）；核对直赋行：
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "SELECT id, user_id, permission_id FROM kh_user_permission;"
```

| 验证点            | 预期                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| /auth/permissions | 三账号 codes/menus/buttons 与角色授权+直赋一致；未授权菜单不出现       |
| 菜单树祖先链      | 子菜单命中而父菜单未授权时，父菜单仍出现在 menus（防悬挂）             |
| Admin 旁路        | admin 无任何 role_permission 行，试点接口仍全通过（POST 201）          |
| 角色层 403        | user approve → 403「需要角色之一」（RolesGuard 先于 PermissionsGuard） |
| 权限层 403        | reviewer delete → 403「无权限操作，需要权限之一：document:delete」     |
| 直赋生效与收敛    | reviewer create 直赋后 201；删直赋行即时 403；恢复再 201（无需重启）   |
| 未标注接口零感知  | GET /document、search、/auth/me 等行为不变                             |

RBAC 权限语义由单元测试固化：`pnpm test permission.service permissions.guard`。

---

## 19. 团队模块（CRUD + 成员管理 + 权限接入）

> 权限码：team:create / team:edit / team:delete / team:member（parent = system:team 菜单）。
> 授权：ROLE_USER 得 create/edit/member；**team:delete 未授权任何角色（仅 Admin 旁路可删）**；ROLE_REVIEWER 无 team 权限。
> 团队删除为软删（成员关联行不动）；移除成员为硬删关联行。建团时 leader_id 缺省 = 当前登录用户。
> 种子含预置团队：技术中心(8000000000000000001)/后端开发组(8000000000000000002)，admin 为 leader、user 为后端组 member。

### 19.1 团队 CRUD 与权限矩阵

```bash
# admin：全通过（旁路，无 team 授权行）
curl -s -o /dev/null -w 'admin create: HTTP %{http_code}\n' -X POST http://localhost:3000/team \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"team_name":"perm-admin-team"}'                                                 # 201

# user：有 team:create → 201；leader_id 缺省 = 自己（返回 leader_id = user 的 userId）
TEAM_ID=$(curl -s -X POST http://localhost:3000/team \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"team_name":"perm-user-team","description":"curl 建团"}' | jq -r '.id')
curl -s "http://localhost:3000/team/${TEAM_ID}" -H "Authorization: Bearer ${USER_TOKEN}" | jq '{id, team_name, leader_id}'

# user：无 team:delete → 403 权限不足（team:delete 未授权任何角色）
curl -s -X DELETE "http://localhost:3000/team/${TEAM_ID}" \
  -H "Authorization: Bearer ${USER_TOKEN}" | jq
# {"message":"无权限操作，需要权限之一：team:delete","error":"Forbidden","statusCode":403}

# user：有 team:edit → 200（改名 + 禁用启停）
curl -s -X PATCH "http://localhost:3000/team/${TEAM_ID}" \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"team_name":"perm-user-team-v2","status":1}' | jq '.team_name, .status'

# reviewer：无任何 team:* 权限 → 403
curl -s -o /dev/null -w 'reviewer create: HTTP %{http_code}\n' -X POST http://localhost:3000/team \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"team_name":"perm-reviewer-team"}'                                              # 403

# 分页 + 模糊（登录即可）
curl -s "http://localhost:3000/team?page=1&pageSize=10&team_name=开发组" \
  -H "Authorization: Bearer ${USER_TOKEN}" | jq '{total, names: [.items[].team_name]}'
```

### 19.2 成员管理全链路（team:member）

```bash
# 1) user 给自己的团队加 admin 为 leader；重复添加 → 409
curl -s -X POST "http://localhost:3000/team/${TEAM_ID}/members" \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"user_id":"1000000000000000001","member_role":"leader"}' | jq
curl -s -o /dev/null -w 'dup add: HTTP %{http_code}\n' -X POST "http://localhost:3000/team/${TEAM_ID}/members" \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"user_id":"1000000000000000001"}'                                               # 409

# 2) 成员列表：联 kh_user 显示 username/realName
curl -s "http://localhost:3000/team/${TEAM_ID}/members" \
  -H "Authorization: Bearer ${USER_TOKEN}" | jq

# 3) admin 降级为 member → 再移除
curl -s -X PATCH "http://localhost:3000/team/${TEAM_ID}/members/1000000000000000001" \
  -H "Authorization: Bearer ${USER_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"member_role":"member"}' | jq
curl -s -X DELETE "http://localhost:3000/team/${TEAM_ID}/members/1000000000000000001" \
  -H "Authorization: Bearer ${USER_TOKEN}" | jq

# 4) 移除非成员 → 404
curl -s -o /dev/null -w 'not member: HTTP %{http_code}\n' -X DELETE "http://localhost:3000/team/${TEAM_ID}/members/1000000000000000002" \
  -H "Authorization: Bearer ${USER_TOKEN}"                                             # 404

# 5) admin 删除团队（唯一可删角色，软删）→ 列表不再出现
curl -s -X DELETE "http://localhost:3000/team/${TEAM_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s -o /dev/null -w 'after delete: HTTP %{http_code}\n' "http://localhost:3000/team/${TEAM_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"                                           # 404
```

### 19.3 首次启用：应用种子增量（team:* 权限码）

```bash
docker cp init-scripts/postgresql/init.sql knowledge_hub_postgres:/tmp/init.sql
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub -f /tmp/init.sql
# 核对 4 个权限码 + 3 行授权：
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "SELECT permission_code FROM kh_permission WHERE permission_code LIKE 'team:%';"
docker exec knowledge_hub_postgres psql -U user -d knowledge_hub \
  -c "SELECT id, role_id, permission_id FROM kh_role_permission WHERE id BETWEEN 4100000000000000012 AND 4100000000000000014;"
```

| 验证点         | 预期                                                             |
| -------------- | ---------------------------------------------------------------- |
| 建团默认负责人 | leader_id 缺省 = 当前登录用户                                    |
| Admin 旁路     | admin 无 team 授权行仍全通过（含唯一的 team:delete）             |
| 权限层 403     | user delete → 403 team:delete；reviewer create → 403 team:create |
| 重复成员       | 409「已是团队成员」；非成员移除 → 404                            |
| 成员联查       | 返回 username/realName/memberRole/joinedAt                       |
| 软删           | DELETE 后详情/列表 404 / 不出现，成员关联行保留                  |

团队语义由单元测试固化：`pnpm test team.service`。

---

## 20. KG 图谱检索（Cypher 节点属性匹配：聚合搜索 / 通用节点查询 / 通用关系查询）

> 前置：文档已发布且 KG 管线写图完成（§13）；`(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[:RELATED_TO]->(:Entity)`。
> 全部用 Cypher `toLower CONTAINS` 对节点属性做子串匹配（不建索引，POC 数据量级）。中文关键词经 UTF-8 文件传参（见下）。

```bash
# 中文关键词传参（PowerShell/cmd 下中文经 curl 会变 GBK，写入 UTF-8 文件再 --data-urlencode "q@file"）
# Git Bash / WSL 下可直接 --data-urlencode 'q=软星'

# ① 聚合搜索：q 同时匹配 ES 文档 + Neo4j 实体 name/description + RELATED_TO 关系/两端实体名
curl -s -G 'http://localhost:3000/kg/search' --data-urlencode "q@/tmp/q.txt" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{q, docs_total: .docs.total, entities, edges}'

# ② 通用节点查询：label=entity（q 空 = 全量分页，带 mentionCount/relatedCount 统计，按提及数降序）
curl -s -G 'http://localhost:3000/kg/nodes' --data 'label=entity' --data 'page=1' --data 'pageSize=5' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ② 实体关键词 + type 过滤（type ∈ person/org/tech/location/term/other，仅 label=entity 生效）
curl -s -G 'http://localhost:3000/kg/nodes' --data 'label=entity' --data-urlencode "q@/tmp/q.txt" --data 'type=org' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ② 文档节点（按 title 匹配）/ Chunk 节点（按 content 匹配，返回 200 字预览）
curl -s -G 'http://localhost:3000/kg/nodes' --data 'label=document' --data-urlencode "q@/tmp/q.txt" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s -G 'http://localhost:3000/kg/nodes' --data 'label=chunk' --data-urlencode "q@/tmp/q.txt" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ③ 通用关系查询：rel=related_to（实体间关系）/ mentions（Chunk→Entity）/ has_chunk（Document→Chunk）
curl -s -G 'http://localhost:3000/kg/edges' --data 'rel=related_to' --data 'page=1' --data 'pageSize=10' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s -G 'http://localhost:3000/kg/edges' --data 'rel=mentions' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
curl -s -G 'http://localhost:3000/kg/edges' --data 'rel=has_chunk' --data 'pageSize=3' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ③ 实体名过滤：related_to 两端含该实体的边；mentions 目标实体为该实体的边
curl -s -G 'http://localhost:3000/kg/edges' --data 'rel=related_to' --data-urlencode "entity@/tmp/entity.txt" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ③ 不存在的实体名 → total=0 空列表（不报错）
curl -s -G 'http://localhost:3000/kg/edges' --data 'rel=related_to' --data 'entity=不存在的实体XYZ' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq '{total, items}'

# 未登录 → 401（全局 JwtAuthGuard）
curl -s -o /dev/null -w 'no token: HTTP %{http_code}\n' 'http://localhost:3000/kg/search?q=a'   # 401
```

| 验证点           | 预期                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| 聚合搜索         | `{q, docs, entities, edges}` 三路；docs 复用 ES（含 highlight）          |
| 节点查询统计     | entity 项含 mentionCount/relatedCount，按 mentionCount DESC 排序         |
| type 过滤        | 仅 entity 生效；type 非法值 → 400                                        |
| content 截断     | chunk 项 contentPreview ≤ 200 字；has_chunk 项同款                       |
| entity 过滤      | related_to 两端 / mentions 目标端含该实体名才返回                        |
| 不存在实体       | total=0 空列表                                                           |
| 非法 label/rel   | 400（@IsIn 白名单）                                                      |

---

未安装 `jq` 时去掉 `| jq` 即可。测试夹具：`test/curl/payload/upload.sample.txt`（中文 TXT）、`test/curl/payload/upload.sample.pdf`（最小 PDF）、`test/curl/payload/update.status.published.json`（PATCH 发布触发）。

## 21. RAG 混合检索 + AI 流式问答（/rag/search + /ai/chat SSE）

> 前置：已有**已发布文档**（`kh_chunk` 索引有数据，见 §1 上传 + §2 发布流程）。
> 链路：关键词召回(BM25) + 向量召回(KNN) → RRF 融合 → Reranker 精排（`RERANK_MODEL=qwen3.7-text-rerank`，dashscope 原生 rerank 端点）。
> `/ai/chat` 复用同一检索拿上下文 → qwen-plus 流式生成，SSE 返回。

```bash
# ① 混合检索（rerank 默认开启；中文 query 走 UTF-8 文件防 GBK 编码坑）
#    夹具：test/curl/payload/rag-search-q.txt 内容为「知识库」
curl -s -G 'http://localhost:3000/rag/search' --data-urlencode "q@test/curl/payload/rag-search-q.txt" --data 'top_k=3' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ② 关闭重排（降级路径：score 为 RRF 融合分 1/(60+rank)，值越小序越后）
curl -s -G 'http://localhost:3000/rag/search' --data-urlencode "q@test/curl/payload/rag-search-q.txt" --data 'top_k=2' --data 'rerank=false' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

# ③ 未登录 → 401
curl -s -o /dev/null -w 'no token: HTTP %{http_code}\n' \
  -G 'http://localhost:3000/rag/search' --data-urlencode "q@test/curl/payload/rag-search-q.txt"   # 401

# ④ AI 流式问答（SSE）：-N 关闭缓冲，逐事件输出；body 为 UTF-8 JSON 文件
#    夹具：test/curl/payload/ai-chat.json
curl -N -s -X POST 'http://localhost:3000/ai/chat' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data-binary '@test/curl/payload/ai-chat.json'

# ⑤ 未登录调用问答 → 401（SSE 头部都不会发出）
curl -s -o /dev/null -w 'no token: HTTP %{http_code}\n' -X POST 'http://localhost:3000/ai/chat' \
  -H 'Content-Type: application/json' --data-binary '@test/curl/payload/ai-chat.json'   # 401
```

`/rag/search` 响应结构：`{items: [{doc_id, doc_title, chunk_index, content, score, rank}], took_ms}`；
rerank 开启时 `score` 为重排相关性得分（0~1），关闭时为 RRF 融合分（≈0.016 量级）。

`/ai/chat` SSE 事件协议：

| 事件      | data 内容                                                | 说明                     |
| --------- | -------------------------------------------------------- | ------------------------ |
| `message` | `{"delta":"token 增量"}`                                 | LLM 流式 token，多次推送 |
| `done`    | `{"answer":"完整答案","sources":[{doc_id,doc_title,chunk_index,score,rank}]}` | 流结束，含引用列表       |
| `error`   | `{"message":"AI 服务处理失败…"}`                         | 失败提示，随后连接关闭   |

| 验证点             | 预期                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| 混合检索排序       | rerank=true 时 score 为相关性得分且按相关性降序；双路命中 chunk 更靠前   |
| rerank=false 对照  | score 变为 RRF 分，顺序可能不同（精排改变了排序）                        |
| SSE 增量           | 多条 `event: message` 逐 token 输出，最后一条 `event: done`              |
| done 引用          | answer 内 `[编号]` 与 sources 的 rank 对应                               |
| 问答鉴权           | 无 token → 401（全局 JwtAuthGuard，POST SSE 也不例外）                   |
| 重排服务不可用     | 降级为 RRF 顺序，接口仍 200（服务端 warn 日志 `降级为 RRF 排序`）        |
| top_k 越界         | top_k=0 / >20 → 400（DTO 校验）                                          |

