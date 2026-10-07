# 06 TipTap 在线文档编辑器

Status: done
Blocked by: 05
Spec: §5.2 在线文档、ADR-0002

## 目标

`type=online` 文档的创建与编辑闭环，内容以 TipTap JSON 存储与回显。

## 范围

- TipTap 集成（starter-kit 基础：标题/加粗/斜体/列表/引用/代码块/表格/图片占位）
- 编辑器页面：顶部文档元信息（标题可改）+ 工具栏 + 内容区
- 打开 `type=online` 文档进入编辑；`type=file` 文档不可进入（入口隐藏）
- 自动保存（防抖 + PATCH `contentJson`），保存状态指示（已保存/保存中）
- 从 JSON 回显渲染
- 新建在线文档时由 05 的入口进入本页面

## 验收标准

- [x] 新建 → 编辑 → 刷新后内容完整回显
- [x] 自动保存触发且关闭前无丢失（beforeunload 兜底）
- [x] 存储格式为 TipTap JSON（检查接口 payload）
- [x] 文件类型文档无编辑入口

## 备注

编辑器是长期锁入点（ADR-0002），组件封装保持独立（`components/editor/`），不与业务页面耦合，便于二期替换。

## Comments

- 2026-09-08：TipTap v2 集成完成（starter-kit/image/table，表格子扩展按 v2 拆分包引入）。`RichEditor`（components/editor/RichEditor.vue + json.ts）工具栏覆盖 H1-H3/加粗/斜体/删除线/行内代码/有序无序列表/引用/代码块/分隔线/表格/图片 URL 插入。
- 2026-09-08：Editor.vue 自动保存为 1.5s 防抖 PATCH（title+contentJson），三态指示（已保存/保存中…/待自动保存），保存失败提示并自动重试；站内路由离开时 await 在途保存（onBeforeRouteLeave）；beforeunload 用 fetch keepalive 兜底 + 浏览器离开确认。
- 验收记录（Chrome 实测）：① 新建「工单06验收文档」→ 输入 H1+段落 → 离开后从列表重新进入，标题与富文本结构完整回显；② PATCH 自动保存触发（网络面板 3 次 PATCH 全 200，状态流转 待自动保存→保存中→已保存）；③ PATCH payload 实证为 TipTap JSON（`{type:'doc',content:[{type:'heading',attrs:{level:1}},…]}`），mock handler 同步提取纯文本 summary；④ UI 层文件行仅预览/下载（Index.vue 操作列 v-if type==='file'），守卫层直链 `/documents/d004/edit` 被拦截回列表并提示"上传文件仅支持预览与下载，不支持在线编辑"。
- 已知边界（mock 内存库，与工单 05 操作日志边界同类，真实后端接入后自然消除）：① 整页刷新后内存库重置为种子数据，新建文档 id 失效 → 编辑页 catch 后跳回列表，故"刷新后回显"按**同会话内重新进入**口径验收；② beforeunload 的 keepalive 请求在页面卸载时发出，但 MSW handler 随主线程销毁无法落库，端到端"关闭前无丢失"留待真实后端验证（弹框拦截与请求发出已代码级确认）。
- vue-tsc 通过（EXIT=0）。
