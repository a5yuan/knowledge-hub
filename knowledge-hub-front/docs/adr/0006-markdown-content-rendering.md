---
status: current
updated: 2026-09-20
---

# 真实后端正文格式为 markdown，前端以 markdown-it + DOMPurify 渲染（`html: false`）

后端 MinerU 解析管道把上传文件转成 **markdown**，写进 MongoDB `document_content.content`，由 `GET /document/:id` 的 `content` 字段返回。这个格式此前**没有任何 ADR 记录**：ADR-0002 决议的正文格式是 Mock 时期在线文档的 TipTap JSON（`contentJson`），而真实通道的正文是 markdown 字符串——两套口径在前端分叉，直接后果是**联调期「文档上传后显示无法查看」**：`Preview.vue` 只读 `contentJson`（适配层在真实通道从不产出它），后端已经解析好的 markdown 无人读取，页面只剩一句「该格式暂不支持在线预览，请下载查看」。

本 ADR 补齐这个缺口，并**部分取代** `.scratch/knowledge-hub-mvp/spec.md` §10 决议 #3 的结论（原文：pdf 原生内嵌，office 仅下载，二期接 kkFileView）。

**决议一：markdown 是真实通道正文的唯一格式。** 前端渲染收口到 `src/components/markdown/`：`render.ts` 是纯函数 `renderMarkdown(src): string`，`MarkdownView.vue` 是唯一展示组件。预览页、编辑页、审核工作台三处共用，不再各自写 `<pre>` 纯文本——「项目无 markdown 渲染库」的口径到此终止。

**决议二：三层安全姿态，缺一不可。**

1. `new MarkdownIt({ html: false, linkify: true, breaks: true })`——正文里的原始 HTML 被**转义成文本**，渲染结果只含渲染器自己生成的标签。
2. `DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })`——用**显式白名单**（只放行渲染器能产出的标签与属性），不用 DOMPurify 默认集合。
3. `link_open` 规则覆写，外链强制 `target="_blank"` + `rel="noopener noreferrer"`。

正文的**不可信程度是最高的一档**：它来自用户上传文件的解析结果，`.md` / `.txt` 更是原文直读，等于把用户文件内容直接送进 `v-html`。因此 `html: true` 属**安全姿态变更**，等于把边界全部押在 DOMPurify 上，须另开 ADR 并重做验收。项目**当前无 CSP**，是独立的遗留加固项，不在本决议范围内。

**决议三：预览页由「解析状态 + 正文」驱动，而不是由文件类型驱动。** `done` 且 `content` 非空 → markdown 渲染；`pending` / `processing` → 按原格式展示（pdf 原生内嵌、txt/md 原文、office 与未知格式下载）并**有界轮询**；`failed` → 原格式 + `parse_error` 原文横幅。轮询上限 40 × 2.5s ≈ 100s，超时停止并给「重新检查」——因为后端 `processParse` 是 fire-and-forget（无 MQ、无重试、无超时），`pending` / `running` 可能**永久挂住**，前端必须把它体现为可操作的状态而非无限转圈。

**决议四：office 文档解析完成前只能下载。** docx / xlsx / pptx 在浏览器里没有原生渲染能力，后端也没有 office→HTML 接口，这是被后端能力锁定的边界，不是实现取舍。解析完成后它们与 pdf 一样可在线阅读 markdown，因此 §10 决议 #3 的「office 仅下载」只在**解析完成前**继续成立。二期若接 kkFileView 一类服务，只需替换原格式分支，本决议其余部分不变。

## Consequences

- **两个新运行时依赖（不可逆）**：`markdown-it`（MIT）、`dompurify`（Apache-2.0 OR MPL-2.0），构建后合计约 132 KB / gzip 53.75 KB，作为共享 chunk 由三个路由复用。移除等于改回 `<pre>` 纯文本，是可见的功能回退
- **`html: false` 的取舍**：MinerU 对复杂表格可能输出原始 HTML，该配置下它们会显示为**字面文本**而非表格
- **正文里的图片必然裂图**：MinerU 的图片是带保留期的原始外链（后端 `images` 恒空、图片从不搬到 RustFS）。`MarkdownView` 用捕获阶段 `error` 监听把裂图替换为「图片不可用」占位，属展示层兜底，真正的修复在后端
- **`parse_error` 全链路可见**：预览页在 `failed` 时展示该字段原文（空串回落为统一文案）。后端**成功时写空串**而非 null，读侧需按「空串 = 无错误」处理
- **Mock 对等**：`src/mocks/content.ts` 等价 Mongo `document_content`，种子里 `done` 的文件文档预置正文、`failed` 的预置错误、`pending`/`processing` 的由详情接口触发续跑——否则新状态机在 Mock 下无法验证。**在线文档（`type=online`）不进这套流转**，其正文仍是 TipTap JSON
- **前端只规避、不修后端缺口**：`parse_state` 的 pending/running 无超时无重试；上传响应不含 `source_file_name` / `file_size`，列表响应不含 `parse_state` / `source_file_url`；RustFS bucket 从未设 policy，`/storage` 取流可能 403。清单见 `backend-integration/backend-todo.md`
- **正文取流必须校验 `res.ok` 与 `Content-Type`**：`/storage` 代理返回 403/404 或 SPA fallback 的 HTML 时，不校验的表现是**空白 iframe 且无任何报错**
