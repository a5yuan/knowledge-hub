---
status: historical
updated: 2026-09-12
---

# Document 数据库映射计划

## Summary

为 `knowledge-hub-backend` 的 document 模块建立与现有数据库结构对应的映射：

1. **PostgreSQL**：新建 TypeORM 实体 `KhDocument`，映射 `kh_document` 表（init.sql 定义）。
2. **MongoDB**：新建 Mongoose Schema `DocumentContent`，映射 `document_content` 集合（init.js 定义索引）。
3. **连接配置**：在 AppModule 中配置 TypeORM（Postgres）与 Mongoose 根连接，并新增 `.env` 存放连接参数。
4. **模块注册**：在 DocumentModule 中注册实体与 Schema（`TypeOrmModule.forFeature` / `MongooseModule.forFeature`）。

## Current State Analysis

- [package.json](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/package.json)：已依赖 `@nestjs/typeorm` ^11、`typeorm` ^1.1、`@nestjs/mongoose` ^11、`mongoose` ^9、`@nestjs/config` ^4、`pg`、`snowflake-id`。
- [app.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/app.module.ts)：仅导入 `DocumentModule`，**无任何数据库连接**。
- [document.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.module.ts)：空脚手架，无 entities / schemas 目录。
- [init.sql](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/init-scripts/postgresql/init.sql)：`kh_document` 表，共 25 列（见下方映射表）。
- [init.js](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/init-scripts/mongodb/init.js)：`document_content` 集合，`documentId` 唯一索引、`deleted` 普通索引；注释表明 `_id(ObjectId) ↔ kh_document.content_id`。
- [docker.compose.yml](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/docker.compose.yml)：Postgres `user/123456@localhost:5432/knowledge_hub`；Mongo `mongo_user/mongo_pass123@localhost:27017/knowledge_hub`。

## Proposed Changes

### 1. 新建 `.env`（仓库根目录）

存放连接参数（值与 docker.compose.yml 一致）：

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=user
POSTGRES_PASSWORD=123456
POSTGRES_DB=knowledge_hub
MONGO_URI=mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub
```

**为什么**：连接配置需要可配置来源；**如何**：`@nestjs/config` 读取。

### 2. 新建 `src/document/entities/document.entity.ts`

TypeORM 实体 `KhDocument`，`@Entity('kh_document')`。字段与 init.sql 逐列对应：

| init.sql 列 | TypeORM 装饰器 | TS 类型 | 说明 |
|---|---|---|---|
| id BIGINT PK | `@PrimaryColumn({ type: 'bigint' })` | string | snowflake 应用侧生成，非自增；pg 驱动 bigint 默认返回 string |
| title VARCHAR NOT NULL | `@Column({ type: 'varchar', nullable: false })` | string | |
| content_id VARCHAR NOT NULL UNIQUE | `@Column({ type: 'varchar', unique: true, nullable: false })` | string | 存 Mongo `_id` 字符串 |
| summary VARCHAR | `@Column({ type: 'varchar', nullable: true })` | string \| null | |
| category_id BIGINT | `@Column({ type: 'bigint', nullable: true })` | string \| null | |
| team_id BIGINT | `@Column({ type: 'bigint', nullable: true })` | string \| null | |
| author_id BIGINT | `@Column({ type: 'bigint', nullable: true })` | string \| null | |
| cover_image VARCHAR | `@Column({ type: 'varchar', nullable: true })` | string \| null | |
| tags VARCHAR | `@Column({ type: 'varchar', nullable: true })` | string \| null | 单列字符串（逗号分隔或 JSON，按 init.sql 原样） |
| status SMALLINT DEFAULT 0 | `@Column({ type: 'smallint', default: 0 })` | number | |
| remark VARCHAR | `@Column({ type: 'varchar', nullable: true })` | string \| null | |
| view_count INT DEFAULT 0 | `@Column({ type: 'int', default: 0 })` | number | |
| like_count INT DEFAULT 0 | `@Column({ type: 'int', default: 0 })` | number | |
| comment_count INT DEFAULT 0 | `@Column({ type: 'int', default: 0 })` | number | |
| favourite_count INT DEFAULT 0 | `@Column({ type: 'int', default: 0 })` | number | |
| word_count INT DEFAULT 0 | `@Column({ type: 'int', default: 0 })` | number | |
| publish_time TIMESTAMP | `@Column({ type: 'timestamp', nullable: true })` | Date \| null | |
| is_public BOOLEAN DEFAULT false | `@Column({ type: 'boolean', default: false })` | boolean | |
| created_at TIMESTAMP DEFAULT NOW() | `@CreateDateColumn({ type: 'timestamp' })` | Date | |
| updated_at TIMESTAMP DEFAULT NOW() | `@UpdateDateColumn({ type: 'timestamp' })` | Date | |
| create_by BIGINT | `@Column({ type: 'bigint', nullable: true })` | string \| null | |
| update_by BIGINT | `@Column({ type: 'bigint', nullable: true })` | string \| null | |
| deleted BOOLEAN DEFAULT false | `@Column({ type: 'boolean', default: false })` | boolean | 逻辑删除标记 |

**为什么**：表结构由 init.sql 管理，实体只做映射（`synchronize: false`），不增删列。

### 3. 新建 `src/document/schemas/document-content.schema.ts`

Mongoose Schema `DocumentContent`，`@Schema({ collection: 'document_content', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })`。

| 字段 | Mongoose 定义 | 说明 |
|---|---|---|
| documentId | `@Prop({ type: Number, required: true, unique: true, index: true })` | 对应 `kh_document.id`，匹配 init.js 唯一索引 |
| content | `@Prop({ type: String, default: '' })` | 正文内容 |
| format | `@Prop({ type: String, enum: ['markdown', 'html'], default: 'markdown' })` | 正文格式 |
| version | `@Prop({ type: Number, default: 1 })` | 版本号 |
| images | `@Prop({ type: [String], default: [] })` | 图片 URL 列表 |
| deleted | `@Prop({ type: Boolean, default: false, index: true })` | 逻辑删除，匹配 init.js 索引 |

- `_id`（ObjectId）由 Mongoose 自动生成，其字符串值存到 PG 的 `content_id`（与 init.js 注释一致，schema 内无需额外字段）。
- timestamps 字段名用 `created_at` / `updated_at` 与 PG 约定保持一致。
- 索引定义与 init.js 一致，Mongoose autoIndex 幂等，不会重复创建。

### 4. 修改 `src/document/document.module.ts`

注册实体与 Schema：

```ts
imports: [
  TypeOrmModule.forFeature([KhDocument]),
  MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }]),
]
```

### 5. 修改 `src/app.module.ts`

```ts
imports: [
  ConfigModule.forRoot({ isGlobal: true }),
  TypeOrmModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      type: 'postgres',
      host: config.get('POSTGRES_HOST', 'localhost'),
      port: Number(config.get('POSTGRES_PORT', 5432)),
      username: config.get('POSTGRES_USER'),
      password: config.get('POSTGRES_PASSWORD'),
      database: config.get('POSTGRES_DB'),
      autoLoadEntities: true,
      synchronize: false, // 表结构由 init.sql 管理
    }),
  }),
  MongooseModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({ uri: config.get('MONGO_URI') }),
  }),
  DocumentModule,
]
```

**为什么**：根连接全局可用；`synchronize: false` 避免与 init.sql 冲突。

## Assumptions & Decisions

- **实体类名 `KhDocument`**：与表名 `kh_document` 对齐，避免与浏览器内置 `Document` 混淆。
- **id 用 `string`**：snowflake 大整数超出 `Number.MAX_SAFE_INTEGER`，pg 驱动 bigint 默认返回字符串。
- **`synchronize: false`**：表结构已由 init.sql 管理，TypeORM 不做同步。
- **document_content 正文字段**：按「基础正文」方案（content / format / version / images / deleted + timestamps + documentId），字段需求后续可扩展。
- **tags 按 VARCHAR 单列字符串**：init.sql 定义为 VARCHAR，不做数组拆列。
- **连接参数写死默认值 + `.env` 覆盖**：值取自 docker.compose.yml。
- **本次不做**：DTO、Service/Controller 业务逻辑、RabbitMQ/ES/Neo4j 集成、Redis 缓存等均不在范围内。

## Verification

1. `npm run build`（nest build）——TypeScript 编译通过，无类型错误。
2. 若本地 Docker 服务已启动（`docker compose up -d`），运行 `npm run start` 观察启动日志：
   - TypeORM 成功连接 Postgres（`knowledge_hub`）；
   - Mongoose 成功连接 Mongo（`knowledge_hub`），无连接错误。
3. 检查 `npm run lint` 无新增报错。
