---
status: historical
updated: 2026-09-12
---

# Document 模块：数据库映射 + CRUD 接口 — 执行记录

日期：2026-09-12

## 背景

- 技术栈：NestJS 11 + TypeORM（PostgreSQL）+ Mongoose（MongoDB）
- 表/集合结构由 `init-scripts/` 定义：`kh_document`（PG 元数据）、`document_content`（Mongo 正文，`_id ↔ kh_document.content_id`，`documentId` 唯一索引）
- 原有 document 模块为空脚手架，AppModule 无任何数据库连接

## 完成内容

### 1. 数据库连接配置
- 新增 `.env`：Postgres / Mongo 连接参数（与 docker.compose.yml 一致）
- [app.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/app.module.ts)：
  - `ConfigModule.forRoot({ isGlobal: true })`
  - `TypeOrmModule.forRootAsync`：`synchronize: false`（表结构由 init.sql 管理，不自动同步）
  - `MongooseModule.forRootAsync`

### 2. 实体 / Schema 映射
- [document.entity.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/entities/document.entity.ts)：
  - `KhDocument` 实体，25 列与 `kh_document` 表逐列映射，每字段带业务注释
  - bigint 字段用 `string` 类型（snowflake 大整数、pg 驱动默认返回字符串）
- [document-content.schema.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/schemas/document-content.schema.ts)：
  - `DocumentContent` Schema：`documentId` 唯一索引、`deleted` 索引（与 init.js 一致）
  - timestamps 用 `created_at`/`updated_at`，与 PG 命名约定对齐
- [document.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.module.ts)：注册 `TypeOrmModule.forFeature([KhDocument])` + `MongooseModule.forFeature`

### 3. 雪花ID精度处理
- 新增 [snowflake-id.util.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/common/utils/snowflake-id.util.ts)：
  - `normalizeSnowflakeId(value, fieldName)`：接收 `bigint | string | number`，统一返回字符串
  - number 超出 `Number.MAX_SAFE_INTEGER` 直接抛错（精度已丢失，明确失败）
- 调用点：
  - entity `id` 列加 TypeORM transformer，写库前归一化
  - schema `documentId` 由 `Number` 改为 `String`，`pre('save')` 钩子落库前归一化

### 4. DTO（`src/document/dto/`）
- [create-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/create-document.dto.ts)：`title` 必填，其余可选，class-validator 校验
- [query-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/query-document.dto.ts)：过滤 + 分页（`page` 默认 1、`pageSize` 默认 20，上限 100），数值/布尔 `@Type` 转换
- [update-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/update-document.dto.ts)：`PartialType(CreateDocumentDto)`，全部可选
- 雪花ID字段（`category_id`/`team_id`/`author_id`/`id`）一律 `string`

### 5. CRUD 接口
- [document.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.controller.ts)：
  - `POST /document` 创建 | `GET /document` 分页查询 | `GET /document/:id` 详情 | `PATCH /document/:id` 更新 | `DELETE /document/:id` 删除
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts)：
  - `create`：snowflake 生成 id（字符串）→ 先写 Mongo 正文取 `_id` 作为 `content_id` → 写 PG 元数据
  - `findAll`：条件过滤 + `title`/`tags` 模糊匹配 + 分页，排除 `deleted`
  - `findOne`：元数据 + Mongo 正文（`documentId` 字符串匹配）
  - `update`：`Object.assign` 仅更新传入字段
  - `remove`：PG + Mongo 同步逻辑删除（`deleted = true`）
  - 按 id 操作统一经 `normalizeSnowflakeId` 归一化，不存在抛 404
- [main.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/main.ts)：新增全局 `ValidationPipe({ transform: true, whitelist: true })`

## 验证

- `npm run build`（nest build）编译通过（含每次变更后）

## 待办 / 说明

- 创建文档当前仅生成空正文；如需创建即带正文，需在 CreateDocumentDto 增加 `content`/`format` 字段
- DTO 未含 `id`（服务端生成）；`publish_time` 用 `@IsDateString` 接收 ISO 8601
- 数据库需先 `docker compose up -d` 启动，方可运行接口联调
