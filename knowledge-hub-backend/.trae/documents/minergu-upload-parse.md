---
status: historical
updated: 2026-09-13
---

# 文件上传解析接入 MinerU 计划

## Summary

按流程图实现文件上传→解析→三路存储→返回草稿摘要的完整链路（**异步架构**）：

```
POST /document/upload (multipart)
  → DocumentService: 存 RustFS 原文件 → 写 PG 草稿元数据 + Mongo 空正文(parse_state=pending)
  → 立即返回 { id, title, parse_state: 'pending', pollUrl }
  → 后台任务: FileService 分发 (txt 直读 / pdf·docx·pptx·xlsx → MinerU)
  → markdown 落 Mongo、summary/word_count 更新 PG、parse_state=success/failed
前端轮询 GET /document/:id 拿状态与正文
```

- MinerU 接入采用参考实现（`D:\tool\workBuddy-docment\2026-09-12-11-05-20\mineru-nest`）的三通道统一封装，`MINERU_PROVIDER` 环境变量切换，**默认 flash**（免 Token 云 API，≤10MB/≤20页，仅 Markdown）。

## Current State Analysis

- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts)：已有 CRUD（雪花ID、PG 元数据 + Mongo 正文、软删除），无上传/解析
- [document-content.schema.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/schemas/document-content.schema.ts)：字段 documentId/content/format/version/images/deleted/created_at/updated_at，**无解析状态字段**
- [package.json](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/package.json)：无 `multer` 类型、无 `mineru-open-sdk`、无 S3 客户端
- [docker.compose.yml](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/docker.compose.yml)：RustFS 已就绪（S3 API :9000，`rustfsadmin/rustfsadmin`），无 Redis（故用进程内后台任务而非 BullMQ）
- [.env](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/.env)：仅有 PG/Mongo 连接
- 参考实现 `mineru-nest/src/mineru/`（types/service/module）与 `documents.controller.ts`：三 provider 封装 + 异步 submit/getJob 模式，可基本原样拷贝

## Proposed Changes

### 1. 安装依赖

```bash
pnpm add -E mineru-open-sdk @aws-sdk/client-s3
pnpm add -D @types/multer
```

- `mineru-open-sdk`：flash/cloud 通道所需（参考实现为动态 import，锁精确版本，README 检查清单要求）
- `@aws-sdk/client-s3`：RustFS 为 S3 兼容存储
- `multer` 由 `@nestjs/platform-express` 自带，仅需类型

### 2. 新建 `src/mineru/`（拷贝参考实现，3 个文件）

- `mineru.types.ts`：原样拷贝（MineruProvider/ParseOptions/ParseResult/ParseJob）
- `mineru.service.ts`：原样拷贝（三通道 parse/submit/health、503 退避重试、幂等哈希）。仅做一处适配：`submit()` 的进程内 Map 任务表**不需要**——我们用 Mongo `parse_state` 做状态源，DocumentService 直接调 `parse()` 放后台执行
- `mineru.module.ts`：原样拷贝

### 3. 新建 `src/storage/`（RustFS S3 客户端）

**`rustfs.service.ts`**：
- `onModuleInit`：检查 bucket，不存在则 `CreateBucketCommand`（幂等，捕获 `BucketAlreadyOwnedByYou`）
- `upload(key, buffer, contentType)`：`PutObjectCommand`
- `publicUrl(key)`：`${RUSTFS_ENDPOINT}/${RUSTFS_BUCKET}/${key}`（path-style）

**`storage.module.ts`**：提供并导出 RustfsService。

对象 key 规则：`documents/{docId}/{filename}`。

### 4. 新建 `src/file/`（分发器，对应流程图 FileService）

**`file.service.ts`**：
```ts
async dispatch(buffer, filename): Promise<{ markdown: string; provider: string }>
```
- 扩展名 `txt`/`md` → `buffer.toString('utf8')` 直读（MinerU 不支持 txt，无需解析）
- `pdf`/`docx`/`pptx`/`xlsx` → `mineru.parse(buffer, filename)` 取 markdown
- 其余扩展名由 Controller 提前 400 拦截，不会到达此处

**`file.module.ts`**：imports MineruModule，exports FileService。

### 5. 修改 `src/document/schemas/document-content.schema.ts`

新增 4 个字段（Mongo 无需迁移，避免动 init.sql/PG 结构）：

| 字段 | 类型 | 说明 |
|---|---|---|
| parse_state | String, default 'pending' | pending / running / success / failed |
| parse_error | String | 失败原因 |
| source_file_name | String | 原始文件名（中文） |
| source_file_key | String | RustFS 对象 key |

### 6. 修改 `src/document/document.service.ts`

新增 `upload(file)`：
1. 文件名编码修复：`Buffer.from(file.originalname, 'latin1').toString('utf8')`（multer 在 Windows 下中文文件名 mojibake 的已知问题）
2. 校验扩展名 ∈ {pdf, docx, pptx, xlsx, txt, md}，否则 400
3. `id = snowflake.generate()`；`key = documents/{id}/{filename}` → `rustfs.upload(...)`
4. `contentModel.create({ documentId: id, parse_state: 'pending', source_file_name, source_file_key })`
5. PG 写元数据：`title = 文件名去扩展名`、`status = 0`（草稿）、`content_id`
6. **不 await** 后台任务 `this.processParse(id, buffer, filename)`，立即返回草稿摘要 JSON：
   `{ id, title, parse_state: 'pending', poll_url: '/document/{id}', source_file_url }`

私有 `processParse(docId, buffer, filename)`：
- Mongo `parse_state → running`
- `fileService.dispatch(...)` 得 markdown
- 成功：Mongo 更新 `content/format='markdown'/parse_state='success'`；PG 更新 `summary`（markdown 去符号后前 200 字）与 `word_count`（去空白字符数）
- 失败：Mongo 更新 `parse_state='failed'` + `parse_error`
- ⚠️ 已知取舍：进程内任务，应用重启时 running 状态会滞留（POC 可接受，生产换 BullMQ/队列）

`findOne` 扩展：响应追加 `parse_state`、`parse_error`、`source_file_url`（由 key 拼出）。

### 7. 修改 `src/document/document.controller.ts`

```ts
@Post('upload')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
upload(@UploadedFile() file?: Express.Multer.File)
```
- 缺 file → 400；10MB 上限对齐 flash 通道限制
- 路由顺序：`upload` 在 `:id` 之前定义避免被吃

### 8. 修改 `src/document/document.module.ts` / `src/app.module.ts`

- DocumentModule imports：`FileModule`、`StorageModule`
- AppModule 不变（MineruModule/FileModule/StorageModule 由 DocumentModule 引入即可）

### 9. 修改 `.env`

```env
# MinerU（默认 flash 免 Token）
MINERU_PROVIDER=flash
MINERU_API_TOKEN=
MINERU_SELF_HOSTED_URL=http://127.0.0.1:8000
MINERU_BACKEND=pipeline
MINERU_TIMEOUT_MS=600000
MINERU_MAX_RETRIES=3
# RustFS
RUSTFS_ENDPOINT=http://localhost:9000
RUSTFS_ACCESS_KEY=rustfsadmin
RUSTFS_SECRET_KEY=rustfsadmin
RUSTFS_BUCKET=knowledge-hub
```

## Assumptions & Decisions

- **异步 + 进程内后台任务**：用户已确认；无 Redis，故不用 BullMQ，采用参考实现的 `void runJob()` 模式，状态落 Mongo
- **解析状态存 Mongo 不存 PG**：避免修改 init.sql（bind-mount 卷只在首次初始化执行，改表需重置数据目录）
- **默认 flash 通道**：数据会上传 mineru.net（≤10MB/20页/仅 Markdown）；切 self-hosted/cloud 只改 `MINERU_PROVIDER`，代码不动
- **txt/md 不走 MinerU**：直读 UTF-8，docx/pptx/pdf/xlsx 走 MinerU（与流程图五格式对齐）
- **title 取文件名去扩展名**；summary 由 markdown 头部截取 200 字
- **不做**：SHA-256 幂等去重（README 清单项，POC 暂缓）、MinerU 归属标注 UI、图片提取落存储（flash 只回 Markdown）

## Verification

1. `npm run build` 编译通过
2. 重启服务（RustFS/PG/Mongo 已在运行）
3. 上传 txt（含中文）：立即返回 `parse_state=pending` + id；轮询 `GET /document/:id` → `success` + 正文 + word_count/summary；RustFS Console(:9001) 可见原文件
4. 上传中文文件名的 docx/pdf：文件名不乱码；flash 通道需外网，若 mineru.net 不可达则 `parse_state=failed` 且 `parse_error` 有因（验证失败路径）
5. 不支持格式（如 .exe）→ 400
6. 既有 CRUD 回归：列表/更新/删除不受影响
