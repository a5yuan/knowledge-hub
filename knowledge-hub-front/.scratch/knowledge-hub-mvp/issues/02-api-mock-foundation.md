# 02 API 层 + MSW Mock 基础设施与种子数据

Status: done
Blocked by: 01
Spec: §6 数据模型、§7 API 契约、§8 Mock 策略

## 目标

打通"组件只依赖接口层"的数据通路，全部 19 个端点可被 mock 响应，种子数据对齐原型示例。

## 范围

- axios 实例（baseURL、拦截器挂载点、统一错误结构）
- `src/api/` 模块化接口定义：auth / folders / documents / search / stats / operations / users / categories / tags / announcements
- MSW 接入与全部 handler
- 内存数据库 + 类型定义（对齐 spec §6 全部实体与字段，含 `parseStatus`、`visibility`、`zone`、`type: file|online`）
- 种子数据：2 角色 + 多部门用户、五类分类（Category 表，可配置建模）、标签池、四分区文件夹树、约 30 条文档（覆盖全部 fileType 与三种可见范围与三种解析状态）、操作日志
- 热门搜索/搜索历史接口（history 走 localStorage，hot 走 mock 聚合）

## 验收标准

- [x] 任意页面可通过 api 层取到 mock 数据（临时挂一个演示调用验证后移除）
- [x] 所有 handler 返回结构一致（`{ code, data, message }` 或约定格式）
- [x] spec §7 列出的端点无遗漏

## Comments

- 2026-09-04 完成并验收通过。
- 分层：`src/types/api.ts`（契约类型）→ `src/mocks/`（seed 种子 + db 内存库 + handlers）→ `src/api/`（10 个模块，组件只依赖此层）。
- 运行时验证（浏览器实测）：dashboard 经 api 层拿到大盘数据（文档总数 30 = 32 种子 - 2 归档，分类占比 5/9/5/6/5）；成员 li 登录后部门分区 15 篇（仅研发部 owner）、公共分区 14 篇、无 token 默认 admin 视角 32 篇；搜索"压测"命中标题；热门搜索聚合正常；成员删除他人文档被 403 拦截。构建 exit 0。
- **对 spec §7 的已记录偏差**：`GET /search/history` 不设端点——搜索历史按 §8 走前端 localStorage（`src/api/search.ts` 内实现），与 §7 列表冲突时以 §8 为准（ADR-0003 规则）。
- **给工单 03 的显式 TODO**：`db.ts` 的 `getViewer()` 当前无 token 时兜底默认 admin（本工单为让脚手架可用），接入登录后必须移除兜底并对受保护端点返回 401；`http.ts` 401 拦截器需补跳转登录。
- 权限/分区纯函数（`canSeeDocument` / `inZone` / `filterDocuments` / `relevanceScore`）收敛在 `src/mocks/db.ts`，工单 04 补测试、迁移后端时同源复用。
- 环境经验：MSW v2 handler 多分支返回类型需统一宽松（`HttpResponse<DefaultBodyType>`），过紧泛型会分支互斥报错。

## 备注

本工单是并行分叉点：完成后 03/04/08/09 可同时开工。数据模型如有出入，以 spec §6 为准并回改 spec，不允许静默分叉（ADR-0003）。
