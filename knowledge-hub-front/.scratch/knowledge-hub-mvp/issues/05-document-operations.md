# 05 文档操作：上传 / 在线文档创建 / 批量操作 / 解析状态流转

Status: done
Blocked by: 04
Spec: §5.2（新建/编辑与详情操作部分）

## 目标

文档生产与管理动作全部可用，mock 解析状态有真实感的流转。

## 范围

- 批量上传（多文件 + 拖拽，逐个生成 file 类型文档，`parseStatus: pending`）
- 解析状态 mock 流转：pending → processing（定时器 2~4s）→ done（90%）/ failed（10%）
- 新建在线文档入口：填标题/分类/标签/可见范围 → 跳转编辑器（编辑器本体在 06，本期可先建空 JSON 文档）
- 新建/编辑弹窗：标题、类型、分类（Category 接口下拉）、标签（多选可自由输入）、可见范围三档、文件夹归属
- 操作：编辑元信息、删除（仅本人或 admin）、归档/恢复、批量删除/归档/移动
- 下载：`fileUrl` mock 链接触发下载
- 操作日志写入（供 09 大盘"近期操作记录"消费）

## 验收标准

- [x] 上传后列表即时出现，解析状态经历完整流转并稳定
- [x] 删除/归档/移动后列表与分区归属一致
- [x] member 无法删除他人文档（按钮隐藏 + handler 双重校验）
- [x] 操作日志可查询到上传/删除/归档记录

## Comments

- 2026-09-07: 实现完成。新增 `src/mocks/parse.ts`（嵌套 setTimeout 模拟 pending→processing→done/failed，随机 2~4s 每段，90% 成功率）；`documents.ts` handler 补充 `/mock-files/:name` 下载端点并在上传/批量后写操作日志；`folders.ts` 的 `zoneOfFolder` 改按文件夹记录的 zone 判定（修复新文件夹前缀误判）。
- 2026-09-07: 新组件 `DocMetaFields`（分类/标签/可见范围/文件夹共用字段）、`UploadDialog`（拖拽多选 + 手动校验）、`MetaDialog`（新建在线文档/编辑元信息双模式）、`MoveDialog`（批量移动）；`Editor.vue` 占位页 + 路由 `/documents/:id/edit`；`Index.vue` 启用三个新建按钮、行内操作（查看/下载/更多菜单，canManage 双重口径）、批量操作栏与解析轮询。
- 2026-09-07: 浏览器验收过程中发现并修复两个 bug：① mock `filterDocuments` 排序比较方向写反，`order=desc` 实为升序（db.ts）；② MetaDialog 的 `el-form` 缺 `:model` 绑定，分类选了也报"请选择文档分类"（合并 title+meta 为单一 reactive 对象后修复）。
- 2026-09-07: 验收记录：上传 2 文件即时置顶并观察到"解析中→解析完成"流转后稳定；归档后从"我的文档"消失并在"文档归档"出现；删除有确认框且列表移除；移动到"项目资料"文件夹后归属一致；member（li）视角他人文档无操作菜单，直连 DELETE/批量接口均 403；`/api/operations` 可查到上传/批量归档/删除记录。vue-tsc 通过。
