# 08 智能搜索

Status: done
Blocked by: 02
Spec: §5.3（原型图 3）

## 目标

对齐原型图 3 的完整搜索体验，可与其他工单并行开发。

## 范围

- 搜索主页：大搜索框 + 搜索按钮 + 高级搜索展开（文件类型/更新时间范围/文档分类/权限范围）
- 结果列表：标题、**关键词高亮摘要**、来源面包屑（分类 > 子分类）、更新时间、权限标注
- 相关度排序（mock 按标题命中 > 标签命中 > 摘要命中赋权）
- 搜索历史：本地 localStorage，展示/点击回填/清空
- 热门搜索：`GET /search/hot` mock 数据
- 搜索范围与过滤规则同 §5.3（无权限结果不出现）
- 列表⇄卡片视图切换

## 验收标准

- [x] 关键词在标题/摘要/标签中命中并高亮
- [x] 筛选组合与分页正确
- [x] private 文档不出现在 member 的搜索结果
- [x] 搜索历史随行为更新，可回填与清空

## Comments

- 2026-09-08 验收记录：
  - 高亮：搜「分析」→ 标题「竞品|分析|报告」mark 命中；搜「与」→ 摘要逐条 mark；搜「安全合规」（仅存在于标签）→ 4 条结果 title/summary 0 个 mark、tag 各 1 个 mark，无误高亮。高亮采用 `HighlightText` 节点级渲染（无 v-html 面）。
  - 相关度排序：标题命中(3) > 标签(2) > 摘要(1)，同分按 updatedAt 降序（「分析」结果 d030 标题命中置首实证）。
  - 筛选组合：「分析」+PDF+部门可见 → 3 条收敛为 2 条（公司可见 d004 被排除）；重置按钮清空全部筛选；dateFrom=2026-08-27 API 层验证仅剩 d004。分页：「与」30 条 = 3 页 ×10，UI 翻页页序与全量结果第 11-20/21-30 位一致。
  - 权限过滤：admin「与」30 条；member li 仅 21 条（排除他人 private d008/d013 与 7 条他部门文档，差分推演吻合），且「需求评审」（唯一命中 private d008）返回 0 条 + 空态提示。
  - 历史：新搜索词置顶、点击历史 chip 回填并执行、清空后 UI 行与 localStorage 键同步移除。
  - 卡片⇄列表切换正常（同一数据源，视图互斥渲染）。
- 2026-09-08 修复：`HighlightText` 原为多根 fragment，外部 `class="title-text"` 无法 fallthrough（Vue 警告 + 标题样式类失效）；改为单根 `<span>` 包裹后 fallthrough 生效，vue-tsc 通过（EXIT=0）。
- 2026-09-08 边界说明：搜索历史按 spec §8 存前端 localStorage，无 `/search/history` 端点（对 §7 的偏差，已在 `src/mocks/handlers/search.ts` 注释标注）；更新时间范围筛选的 UI 日期选择器未逐项目录点选，以 dateFrom/dateTo 参数在 API 层验证（UI 绑定为 value-format=YYYY-MM-DD 直传）。
