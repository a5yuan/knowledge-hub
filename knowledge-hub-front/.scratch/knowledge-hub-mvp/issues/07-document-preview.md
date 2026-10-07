# 07 文档预览与下载

Status: done
Blocked by: 05
Spec: §5.2、§10 决议 #3

## 目标

按决议实现差异化预览：pdf 内嵌、office 仅下载。

## 范围

- pdf：浏览器原生内嵌预览（详情抽屉或独立页，iframe/embed 方案）
- docx/xlsx/pptx：预览按钮置灰 + tooltip 提示"该格式暂不支持在线预览，请下载查看"
- 下载按钮全类型可用
- 在线文档点击查看 → 只读渲染模式（复用 06 的渲染能力，无工具栏）

## 验收标准

- [x] pdf 在系统内直接预览
- [x] office 三类按钮置灰且提示文案正确
- [x] 在线文档只读模式正常渲染

## Comments

- 2026-09-08：新增预览页 `documents/:id/preview`（Preview.vue）：pdf 走 Chrome 原生 viewer 内嵌；在线文档复用 RichEditor 只读渲染（新增 `editable` prop：useEditor editable + watch setEditable + 工具栏 v-if）；office/md/txt 直链访问兜底为空态提示 + 下载按钮。
- 2026-09-08：列表预览按钮接线（Index.vue）：online/pdf 可点进入预览页，其余置灰（span 包裹保证 disabled 状态下 tooltip 可触发），tooltip 按行动态文案；删除原 stub。
- 2026-09-08：mock 文件服务升级：`.pdf` 请求返回极简合法 PDF（application/pdf，运行时计算 xref 偏移，单页 Helvetica 英文占位）；其余格式维持 text/plain attachment。
- 验收记录（Chrome 实测）：① pdf（d009）预览页 Chrome 原生 viewer 正常渲染（缩略图/页码/缩放齐全）；② 逐行 tooltip 实证：online/pdf 行显示"预览"，md/docx/xlsx 行显示"该格式暂不支持在线预览，请下载查看"且按钮 disabled（pptx 与 docx 同分支覆盖）；③ 在线文档只读渲染：contenteditable=false、无工具栏、标题/富文本结构完整；④ docx 直链预览兜底提示正确。
- 技术备注：iframe 直连 fileUrl 会被 SPA fallback 接管（iframe 首次导航请求不受 Service Worker 控制，MSW 拦截不到）→ 预览页改为先 fetch（走 MSW）再以 blob URL 喂 iframe，真实后端下同样兼容。
