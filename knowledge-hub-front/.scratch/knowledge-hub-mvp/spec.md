# 企业智能知识库前端（knowledge-hub-front）MVP 规格

> Status: drafted | 来源: grill-me 访谈 + 产品原型（assest/product/1~5.png）| 日期: 2026-09-04

## 1. 背景与目标

为企业内部（几十~几百人规模）建设统一的知识库前端系统。知识以**文件上传为主体**（PDF/DOCX/XLSX/PPTX 等），辅以**在线文档**（TipTap 编写，覆盖制度/流程类内容），提供组织、检索能力；AI 智能问答与知识图谱为二期目标，一期完成入口占位与数据模型预留。

配套后端：`knowledge-hub-backend`（NestJS + PostgreSQL + MongoDB + Elasticsearch，尚在早期）。一期前端以 **mock 先行**开发，数据模型由本规格主导。

## 2. 用户与角色

| 角色   | 说明                                                                 |
| ------ | -------------------------------------------------------------------- |
| 成员   | 普通员工：浏览/上传/管理自己的文档，按可见范围访问他人文档，使用搜索 |
| 管理员 | 额外拥有系统管理：用户管理、分类/标签管理、系统公告                  |

## 3. 范围

**一期（MVP）**：登录认证、文档管理、智能搜索、首页大盘（简化）、系统管理（基础）、个人中心（基础）、AI 问答与知识图谱**占位页**。

**明确不做（一期）**：
- AI 问答真实功能（RAG、会话、模型配置）→ 二期
- 知识图谱（节点抽取、关系构建、力导向图）→ 二期
- 企业 SSO（企微/钉钉/飞书）→ 二期，登录走账号密码 + JWT
- 文件真实解析管道（前端仅展示解析状态，mock 流转）
- 分类/标签管理界面与系统公告（二期；分类一期由种子数据提供，建模保持可配置）
- 首页大盘子页面（访问分析/文档统计/用户统计/热门内容，见 §5.4）
- 生产部署流水线（一期交付 = 本地开发 + 演示可用）

## 4. 信息架构

与原型一致的一级导航：

```
首页大盘 | 文档管理 | 智能搜索 | AI智能问答(占位) | 知识图谱(占位) | 个人中心 | 系统管理(仅管理员)
```

## 5. 功能需求

### 5.1 登录认证（对应原型：无登录页原型，自行设计，风格对齐图 1 顶栏）

- 账号密码登录，JWT 鉴权（localStorage 存储，axios 拦截器附带与 401 处理）
- 两角色：管理员/成员；登录后按角色显示/隐藏"系统管理"入口
- 路由守卫：未登录跳转登录页

### 5.2 文档管理（原型图 2，核心模块）

**四分区**（左侧栏）：我的文档 / 公共文档 / 部门文档 / 文档归档
- 我的文档：`visibility=private` 或本人所有的文档
- 部门文档：本部门成员的文档与部门共享目录
- 公共文档：`visibility=company` 的文档
- 文档归档：归档态文档，只读

**文档类型**：
- 文件文档：pdf/docx/xlsx/pptx/md/txt 等，上传产生
- 在线文档：TipTap 编辑器创建，内容存 JSON（`type=online`）

**工具栏**：关键词搜索（名称/内容/上传人）、批量上传、新建文件夹、筛选（文件类型/解析状态/权限范围）、列表⇄卡片视图切换

**列表列**：文档名称、文件类型、上传时间（排序）、上传人、解析状态（解析完成✓/解析中⟳/解析失败✗）、权限范围（仅本人/部门可见/公司可见）、操作（预览/下载/更多）

**文档详情/操作**：
- 文件文档：预览（**pdf 浏览器原生内嵌**；docx/xlsx/pptx 预览按钮置灰提示"仅下载"，二期接预览服务）、下载、编辑权限范围、归档/恢复、删除（仅本人或管理员）
- 在线文档：TipTap 编辑器打开编辑，自动保存
- 批量操作：批量删除/归档/移动

**新建/编辑**：弹窗或页面提供：标题、类型（文件上传 / 在线文档）、分类（单选：产品文档/技术文档/培训资料/制度流程/市场营销）、标签（多选，自由输入）、可见范围（仅本人/部门可见/公司可见）、文件夹归属

### 5.3 智能搜索（原型图 3）

- 顶部大搜索框 + 高级搜索展开（文件类型/更新时间/文档分类/权限范围筛选）
- 结果项：标题、**关键词高亮摘要**、来源面包屑（分类 > 子分类）、更新时间、权限标注
- 相关度排序（一期 mock 按命中权重模拟）；搜索历史（本地）+ 热门搜索（mock 接口）
- 搜索范围：标题 + 摘要内容 + 标签（在线文档为正文 JSON 提取的纯文本；文件文档为标题/摘要字段——真实全文索引依赖后端 ES，二期接入）

### 5.4 首页大盘（原型图 1，简化版）

- 统计卡：文档总数、今日新增文档、用户搜索次数、活跃用户数（**AI 问答次数卡片一期不展示**，无数据源）
- **活跃用户数口径 = 当日登录去重用户数**（已决议）
- 访问趋势折线图（今日/近7日/近30日切换，mock 数据）
- 文档分类占比环形图
- 近期操作记录表（操作时间/用户/类型/内容/相关文档）
- 原型中大盘左侧子菜单（访问分析/文档统计/用户统计/热门内容/系统公告）对应子页面**一期不做**，二期随真实埋点数据落地
- 数据全部由 mock 接口提供

### 5.5 系统管理（一期仅用户管理，已决议）

- 用户管理：列表、新增/禁用、角色分配、部门归属
- 分类与标签管理、系统公告 → 二期（分类可配置能力由 Category 建模 + 种子数据支撑，一期无管理界面）

### 5.6 占位模块（AI 智能问答 / 知识图谱）

- 路由与一级导航入口存在，页面渲染"模块建设中（二期）"的友好占位
- 导航不隐藏（保住产品完整性预期），个人中心/文档管理中不出现任何假功能入口

### 5.7 个人中心（基础）

- 个人资料查看/编辑（昵称、密码修改）
- 我的上传统计

## 6. 数据模型（mock 与未来后端共用契约）

```ts
User        { id, username, passwordHash, displayName, role: 'admin'|'member', departmentId, status }
Department  { id, name }
Category    { id, key: 'product'|'tech'|'training'|'process'|'marketing', name, enabled, sort }
Tag         { id, name }
Folder      { id, name, parentId, zone: 'mine'|'public'|'department'|'archive', ownerId, departmentId }
Document    {
  id, title,
  type: 'file'|'online',
  fileType?: 'pdf'|'docx'|'xlsx'|'pptx'|'md'|'txt',   // type=file 时
  contentJson?: object,                                 // type=online 时（TipTap JSON）
  summary: string,              // 搜索摘要（在线文档自动提取，文件文档取元信息）
  categoryId, tagIds: string[],
  visibility: 'private'|'department'|'company',
  zone, folderId, ownerId,
  parseStatus: 'pending'|'processing'|'done'|'failed', // 二期解析管道入口，一期 mock 流转
  fileSize?, fileUrl?,
  createdAt, updatedAt, archivedAt?
}
OperationLog { id, userId, action: 'upload'|'update'|'delete'|'login'|'ai-ask', targetId?, createdAt }
```

## 7. API 契约草案（REST，mock 与真实后端一致）

```
POST /auth/login                → { token, user }
GET  /auth/me
GET/POST /folders               ?zone=&parentId=
PATCH/DELETE /folders/:id
GET  /documents                 ?zone=&folderId=&type=&categoryId=&tagId=&visibility=&parseStatus=&keyword=&sort=&page=&pageSize=
POST /documents                 （在线文档创建）
POST /documents/upload          （批量，multipart）
GET/PATCH/DELETE /documents/:id
POST /documents/batch           { action: 'delete'|'archive'|'restore'|'move', ids }
GET  /search                    ?q=&fileType=&categoryId=&visibility=&dateFrom=&dateTo=&page=
GET  /search/hot                GET /search/history
GET  /stats/dashboard           ?range=today|7d|30d
GET  /operations                ?page=（近期操作记录）
GET/POST/PATCH /users           （管理员）
GET/POST /categories /tags      （管理员）
GET/POST/PATCH /announcements   （管理员）
```

## 8. Mock 策略

- MSW（Mock Service Worker）拦截上述全部端点，内存数据库 + 假数据种子（对齐原型中的示例：24,567 文档、五分类等）
- API 层隔离：`src/api/` 下模块化接口定义，组件只依赖接口不依赖 mock；切换真实后端仅改 baseURL 与拦截器
- 解析状态流转：上传后 pending → processing（定时器）→ done/failed，演示真实感
- `skills-lock.json` 与 `.claude/` 为工程配套，不属于交付物

## 9. 非功能与约束

- 权限规则：**无权限文档在列表与搜索结果中默认隐藏**（非禁点态）；部门可见 = 本部门成员可见；管理员可见全部
- 浏览器目标：Chrome/Edge 现代版本（Element Plus 基线）
- UI 风格：以原型为视觉基准（蓝色主色、卡片化、左侧菜单 + 顶栏导航）
- 中文为唯一界面语言

## 10. 决议记录（原假设，2026-09-04 复核已全部决议）

| #   | 议题             | 决议                                                                                    |
| --- | ---------------- | --------------------------------------------------------------------------------------- |
| 1   | 系统管理一期范围 | **仅用户管理**；分类/标签管理界面与系统公告延至二期                                     |
| 2   | 活跃用户数口径   | **当日登录去重用户数**                                                                  |
| 3   | 文档预览程度     | **pdf 浏览器原生内嵌 + office 仅下载**（office 预览按钮置灰，二期接 kkFileView 类服务） |
| 4   | 文档分类建模     | **Category 表可配置 + 五类种子数据**，一期无管理界面                                    |

## 11. 二期路线（占位依据）

文件解析管道（对接解析状态）→ Elasticsearch 全文索引 → AI 智能问答（会话/引用/追问/模型配置，原型图 4）→ 知识图谱（节点/关系抽取与可视化，原型图 5）→ 企业 SSO → office 在线预览（kkFileView 类）→ 分类/标签管理界面与系统公告 → 首页大盘子页面（访问分析等）

## 12. 术语表（规格内约定，后续沉淀 CONTEXT.md）

| 术语                    | 定义                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| 文档（Document）        | 知识库最小内容单元，分文件文档与在线文档两种类型                                              |
| 文档类型（type）        | `file`（上传文件）/ `online`（TipTap 编写，存 JSON）——注意与"文件类型"（pdf/docx 等格式）区分 |
| 文档分类（Category）    | 单选的业务分类（数据可配置，默认五类种子：产品/技术/培训/制度/营销）                          |  |
| 标签（Tag）             | 多选自由词汇                                                                                  |
| 可见范围（visibility）  | 仅本人 / 部门可见 / 公司可见 三档                                                             |
| 分区（zone）            | 我的文档/公共文档/部门文档/文档归档 四个固定视图区                                            |
| 解析状态（parseStatus） | 二期解析管道的处理进度标记，一期 mock 展示                                                    |
