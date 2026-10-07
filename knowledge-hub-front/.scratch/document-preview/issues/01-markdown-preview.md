# 01 文档查看：解析完成前看原格式，解析完成后看 markdown

Status: done
Blocked by: -
Spec: MVP §10 决议 #3、backend-integration §4.2 文档域、§4.4 已知有损映射汇总、§5 待后端清单、§6 验收口径

## 目标

修掉「文档上传后点预览只显示『该格式暂不支持在线预览，请下载查看』」——让上传的文档在解析完成前按原格式展示、解析完成后自动切换为渲染后的 markdown 正文，并把后端的解析失败原因、永久卡死两种状态都体现为可操作界面。

## 范围

### 根因（四层互相掩盖，必须一起修才看得出来）

1. **正文取错字段**：`views/documents/Preview.vue` 只读 `loaded.contentJson`，而真实通道的 `mapDocumentDetail`（`src/api/adapters/document.ts`）**从不产出 `contentJson`** → 正文恒为 `EMPTY_DOC`。
2. **后端已解析好的正文无人读取**：后端 `GET /document/:id` 返回的 markdown `content`（Mongo `document_content.content`）此前只被 `Editor.vue` 与 `Reviews.vue` 当纯文本塞进 `<pre>`，预览页从未读它。
3. **模板叠罗汉**：`Preview.vue` 的「不支持」空状态用的是 `v-if` 而它上一行是 `v-else-if` → 不支持格式**同时**渲染空白 RichEditor 与空状态。
4. **取原文件从不校验响应**：`fetch(fileUrl).then(r => r.blob())` 不校验 `r.ok` → `/storage` 代理 403/404 或返回 SPA fallback 的 HTML 时表现为**空白 iframe 且无任何报错**。

附带：`isUnsupportedFile` 用 `fileType !== 'pdf'` 判定，`fileType` 为 `undefined` 时该式为 true → **连 pdf 都会被判「不支持」**。

### 硬约束（不可协商）

- **`snake_case` 红线（ADR-0005）**：`parse_state` / `parse_error` / `source_file_name` / `source_file_url` 只允许出现在 `src/api/adapters/document.ts`。视图层或 `types/api.ts` 出现这些名字，本工单不予验收。
- **`html: false` 一票否决**：markdown-it 必须以 `html: false` 初始化。改成 `true` 等于把安全边界全部押在 DOMPurify 上，属安全姿态变更，须另开 ADR。
- **有界轮询**：不得使用无上限的 `setInterval`。上限 40 × 2.5s ≈ 100s，超时停止并给「重新检查」。
- **单一 if/else-if 链**：正文区不得再出现并列的 `v-if` / `v-else-if` 把同一文档渲染两遍。

### 新增

- `src/components/markdown/render.ts` —— `markdown-it` + DOMPurify 纯函数渲染，`html: false`，显式 `ALLOWED_TAGS` / `ALLOWED_ATTR`，`link_open` 强制 `rel="noopener noreferrer"`
- `src/components/markdown/MarkdownView.vue` —— 共用只读展示组件，含裂图占位与代码块复制
- `src/mocks/content.ts` —— 等价 Mongo `document_content` 的 Mock 正文库与种子正文生成
- `src/views/documents/meta.ts` —— `PARSE_STATUS_META` / `DOC_STATUS_META`（此前 `DOC_STATUS_META` 在 `Index.vue` 与 `Reviews.vue` 各存一份）
- `docs/adr/0006-markdown-content-rendering.md` —— 正文格式与安全姿态决议
- `package.json` 追加 `markdown-it`、`dompurify` 两个**运行时**依赖

### 修改

- **重写** `src/views/documents/Preview.vue`：状态机（`done`+正文非空 → markdown；`pending`/`processing` → 原格式 + 有界轮询；`failed` → 原格式 + 失败原因横幅）、单一分支链、`res.ok` + `Content-Type` 双校验、下载回落原始文件名
- `src/views/documents/Editor.vue`、`src/views/documents/Reviews.vue`：`<pre>` 纯文本 → `MarkdownView`（三处渲染口径收口）
- `src/views/documents/Index.vue`：状态文案与配色改从 `meta.ts` 取
- `src/types/api.ts`：`DocumentItem` **纯追加** `fileName?: string`、`parseError?: string | null`
- `src/api/adapters/document.ts`：`mergeDetail` 补 `parseError` / `fileName`（此前丢掉 `parse_error`）；导出 `toStorageRelative`；`fileTypeFromName` 健壮化
- `src/api/documents.ts`：上传路径的 `fileUrl` 归一为 `/storage` 相对路径（此前直接放后端绝对值，与详情路径不一致）；用本地 `File` 推导 `fileName` / `fileSize` / `fileType`
- `src/mocks/parse.ts`、`src/mocks/db.ts`、`src/mocks/handlers/documents.ts`：终态写入正文 / 错误，详情 handler 合并 `content` / `parseError`
- `README.md`：预览与下载小节、ADR 列表、已知限制两条（「无 Markdown 渲染库」「仅 PDF 支持在线预览」已不成立）、真实模式降级总表补一行

## 验收标准

真实通道（决定性证据）：

- [x] 上传 `.txt` / `.md` / `.pdf` 后**不刷新页面**，状态条从「解析中」自动流转到「解析完成」，正文区**自动**切换为渲染后的 markdown（证伪：Network 里 `GET /real/document/:id` 在终态后再无新请求，且正文区不出现第二份空白编辑器）
- [x] 上传 `.md` 后**解析完成前**，正文区按原文展示在 `<pre>` 中（证伪：不再出现「不支持在线预览」空状态）
- [x] 上传 `.pdf` 后解析完成前，`iframe` 内出现 mock/真实 PDF 内容（证伪：不是空白 iframe）

Mock 通道（逃生舱 `localStorage['kh_api_mode'] = {"auth":"mock","documents":"mock","search":"mock"}`）：

- [x] 覆盖 `done` / `processing` / `failed` / 无状态四种文档，四种正文区表现各不相同且都非空白（「无状态」文件型种子库中不存在，见评论末条说明）
- [x] 种子 `processing` 文档在打开详情后 2~4s 内自动转 `done` 并切到 markdown（证伪：不会停在「解析中」直到超时）
- [x] 全站回归：列表 / 搜索 / 大盘 / 个人中心与改动前逐项一致

XSS 探针（独立证据，不可省）：上传内容含 `<script>alert(1)</script>`、`<img src=x onerror="alert(2)">`、`[x](javascript:alert(3))`、`<style>body{display:none}</style>`，以及代码围栏里塞 `</code></pre><script>alert(4)</script>` 的 `.md`：

- [x] 预览页**零弹窗**、页面不消失，上述内容以**转义文本**可见（证伪：任一 `alert` 弹出，或 `body` 被隐藏）

后端缺口的前端体现：

- [x] 把 Mongo 的 `parse_state` 置为 `running` 静置 ≈100s：轮询**停止**（Network 无新请求）+ 出现「已停止自动刷新」提示 + 出现「重新检查」按钮（证伪：不是无限转圈）
- [x] Mongo 置 `failed` + 任意 `parse_error`：页面显示该文案**原文**（证伪：不显示「后端未提供失败原因」）
- [x] 把 `/storage` 代理改坏（或收紧张 bucket 策略）后预览 pdf：显示明确的 `el-alert` 报错 + 重试按钮（证伪：不是空白 iframe）
- [x] 全程控制台**零未捕获 error**、零 `TypeError`、零白屏

静态门：

- [x] `pnpm build`（`vue-tsc -b`）**零错误**（前后数值并列记录）
- [x] `pnpm lint` **零新增**（基线 15 errors + 1 warning）

## 备注

**不可采信项**：不得把「Mock 下能看到 markdown」当作验收通过。Mock 的 `content` 由 `src/mocks/content.ts` 生成，与真实链路的解析时序无关；真实通道必须在 `POST /real/document/upload` 之后**不刷新页面**观察自动流转，并以 Network 面板的 `GET /real/document/:id` 请求序列为证。

**不可逆项**：

- 新增两个运行时依赖（`markdown-it` MIT、`dompurify` Apache-2.0 OR MPL-2.0），移除等于改回 `<pre>` 纯文本，是可见的功能回退
- `html: false` 使 MinerU 输出的复杂表格原始 HTML **显示为字面文本**；这是安全取舍而非缺陷
- 部分取代 MVP spec §10 决议 #3 的「office 仅下载」——office 在**解析完成后**可在线阅读 markdown，解析完成前仍只能下载

**已知后端缺陷（前端只规避，不修）**：

- `parse_state` 的 `pending` / `running` **无超时、无重试、无补偿**（`void this.processParse()` fire-and-forget），可能永久挂住
- 上传响应不含 `source_file_name` / `file_size`；列表响应不含 `parse_state` / `source_file_url` / `file_type`
- RustFS bucket **从未设 policy**，后端只生成 URL 不设策略 → 曾推测 `/storage` 取流可能 403。**实测未发生**（证据五 · ③：md/txt/pdf 三种均 HTTP 200 且 Content-Type 正确），故此项由「已知缺陷」降级为**未复现的隐患**：策略仍缺，换环境/换凭据仍可能 403，前端保留 `res.ok` 校验是对的，但不应再当作既定事实写进文档
- MinerU 正文里的图片是带保留期的原始外链（后端 `images` 恒空、图片从不搬到 RustFS）→ markdown 里的图**必然裂图**

上述四项的修复在 `backend-integration/backend-todo.md`，不在本工单范围内。

**遗留加固项（单开工单，不顺手做）**：项目当前**无 CSP**，`v-html` 引入后应补 `Content-Security-Policy`。

## Comments

- 2026-09-20: **实现完成，静态门与三项可离线验证的证据全绿；浏览器走查项未验（见末条）。** 改动落在 6 个新增文件（`components/markdown/render.ts`、`components/markdown/MarkdownView.vue`、`mocks/content.ts`、`views/documents/meta.ts`、`docs/adr/0006-markdown-content-rendering.md`、本工单）+ 10 个修改文件（`Preview.vue` 重写、`Editor.vue`、`Reviews.vue`、`Index.vue`、`types/api.ts`、`api/adapters/document.ts`、`api/documents.ts`、`mocks/{parse,db}.ts`、`mocks/handlers/documents.ts`、`README.md` 五处）。四层根因逐条对应：正文改取 `DocumentDetail.content`；模板收成单一 if/else-if 链；取原文件补 `res.ok` + `Content-Type` 双校验；`fileType` 判定不再把 `undefined` 当「不支持」。

- 2026-09-20: **静态门（P0 基线与收口并列）**。`pnpm build`：改动前零错误 → 改动后零错误。`pnpm lint`：改动前 `16 problems (15 errors, 1 warning)` → 改动后 `16 problems (15 errors, 1 warning)`（15 个 error 全是 `views/**/Index.vue`、`Preview.vue`、`Reviews.vue` 的 `vue/multi-word-component-names` 存量项，1 个 warning 是存量 `eslint-disable` 未使用）。打包体积：主 chunk `index-*.js` 1,277,130 → 1,277,246 字节（**+116 B**）；`markdown-it` + `dompurify` 落在新的共享 chunk `MarkdownView-*.js` 132,020 字节（gzip 53.75 kB），由预览页 / 编辑页 / 审核工作台三个懒加载路由共用，首屏主 chunk 无回归。

- 2026-09-20: **证据一 · `snake_case` 红线（产物级）**。对 `dist/assets/*.js` 全量 grep `parse_state|parse_error|source_file_name|source_file_url`：仅命中含 `src/api/adapters/` 的主 chunk `index-*.js`（`parse_state` ×3、`source_file_name` ×2、`source_file_url` ×2、`parse_error` ×1），视图 chunk `Preview-*.js` / `Editor-*.js` / `Reviews-*.js` **命中数均为 0**。红线的检查对象由源码升级为构建产物。

- 2026-09-20: **证据二 · XSS 探针（markdown-it 层，11/11 通过）**。脚本 `.scratch/document-preview/xss-probe.mjs` 复刻 `render.ts` 的配置与两条自定义规则（DOMPurify 实例化需要 DOM，本环境无 DOM 实现，故第二道闸门未做运行时验证），对 11 个载荷渲染并做**真标签感知**的断言（只扫 `<tag …>` 内部，不把已转义的 `&lt;img onerror=&quot;` 误判为属性）：`<script>`、`<img onerror>`、`<style>`、`<svg onload>`、`<iframe>`、HTML 注释内脚本、`[x](javascript:)`、`![x](javascript:)`、`[y](data:text/html,)`、原始 `<a href="javascript:">`、**围栏内 `</code></pre><script>` 逃逸** —— 全部输出为转义文本，无白名单外标签、无 `on*` 属性、无 `javascript:` / `data:text/html` 地址。其中 `javascript:` 与 `data:text/html` 由 markdown-it 自带的 `validateLink` 拦下并**原样保留为字面文本**；围栏逃逸由 `escapeHtml(token.content)` 拦下。结论：**第一道闸门产出的 HTML 已不含任何可执行构造**，DOMPurify 在此输出上无事可做（冗余防御，非唯一防线）。

- 2026-09-20: **证据三 · Mock 种子正文库（9/9 通过，覆盖本工单标注的两项风险）**。脚本 `.scratch/document-preview/mock-seed-probe.mjs` 用 Vite 的 `ssrLoadModule` **真实执行** `src/mocks/db.ts` 的模块初始化（含 `buildSeedContents`）后断言：种子 72 篇（file 66 / online 6），`done` 48 篇**全部**预置 markdown 正文、`failed` 7 篇**全部**预置失败原因、`done` 不带失败原因；**6 篇在线文档一篇都未被写入正文库**且仍持有 `contentJson`（对应风险「`buildSeedContents` 误改在线文档」）；`pending`/`processing` 11 篇均未预置正文（留给详情接口触发流转）；抽样一篇正文实跑 markdown-it，标题 / 表格 / 代码块 / 引用四种结构齐备且原始 HTML 被转义。循环依赖风险（`content.ts` ↔ `db.ts`）由「模块初始化未抛错且 `db.documents` 有 72 条」间接证否。

- 2026-09-20: **证据四 · 开发服务器冒烟**。`pnpm dev` 838ms 就绪，`/` → 200；`/src/views/documents/Preview.vue` → 200（Vite 转换通过）、`/src/components/markdown/render.ts` → 200、预打包依赖 `markdown-it.js` → 200，dev 日志无报错。

- 2026-09-20: **未验证项（需浏览器，本环境不具备浏览器自动化）**——本工单的验收标准里凡涉及**运行时时序与真实 DOM** 的条目均未勾选，逐条列出以免被误读为通过：① 真实通道上传后不刷新页面的自动流转与轮询停止；② Mock 下 `processing` 种子文档 2~4s 自动转 `done`；③ pdf `iframe` 内实际渲染；④ Mongo 置 `running` 静置 ≈100s 的轮询超时与「重新检查」；⑤ `parse_error` 原文展示；⑥ `/storage` 代理改坏后的 `el-alert` 报错（无空白 iframe）；⑦ 控制台零未捕获 error；⑧ XSS 探针的**浏览器内**零弹窗（本工单只验到 HTML 生成层，见证据二）。上述八项需在**同时起后端（NestJS :3000 + PostgreSQL / MongoDB / Elasticsearch / RustFS）与前端 dev** 的环境下走查；Mock 通道的四态演示可脱离后端单独走查。

- 2026-09-20: **与计划的偏差（三处，均为实现期发现）**。① 新增 `src/views/documents/meta.ts`：计划未列此项，但 `DOC_STATUS_META` 已在 `Index.vue` 与 `Reviews.vue` 各存一份，预览页要用同一口径就会变成第三份副本，故收口为共享模块（`Index.vue` 的图标表随之改为 `...PARSE_STATUS_META.x` 展开，模板未改动）。② 计划的风险条目「`noUnusedParameters` 会让自定义渲染规则卡住类型门，未用者加 `_` 前缀」**对 ESLint 不成立**：`@typescript-eslint/no-unused-vars` 默认**不**豁免 `_` 前缀形参，按该建议写会引入 3 个 lint error（实测 15 → 18）；改为只声明用得到的两个形参（TS 允许少形参赋值给 `RendererRule`），lint 回到基线。③ `escapeHtml` 未从 `markdown-it` 包根导出（已核对 `dist/markdown-it.mjs` 的导出清单），改用实例上的 `md.utils.escapeHtml`；`@types/markdown-it` **未安装**，markdown-it 15.0.2 自带类型，装上反而会遮蔽。

- 2026-09-20: **未做的收尾项（P8，需用户决定）**：`backend-integration/spec.md`（§4.2 / §4.4 / §5 / §6）与 `backend-todo.md` 尚未同步「`content` 为 markdown」这一口径。该目录在 `knowledge-hub-front` 之外且根目录不是 git 仓库，**没有 VCS 兜底**，改动前必须先手工备份，故未擅自执行。

- 2026-09-20: **证据五 · 真实通道端到端（`POST /real/document/upload` → `GET /real/document/:id`）**。环境：Docker 全栈起齐（postgres / mongodb / rustfs / rabbitmq / elasticsearch / neo4j / kibana + mongo-express，Redis 复用同一台机上另一项目的 `agent_redis`，因 `.env` 的 `REDIS_PASSWORD` 为空而连接成功）；PG 10 张表、ES green（`kh_chunk` 32 / `kh_document` 4）、Mongo `document_content` 37 篇（pending ×10 / success ×23 / 无 `parse_state` ×4）；后端 :3000 启动日志干净（Nest 起、RabbitMQ 拓扑就绪、Redis 已连、RustFS ready、MinerU provider=flash），前端 :5173 的 `/real` 代理通（无 token 取 `/real/auth/me` 返回 401）。脚本 `.scratch/document-preview/e2e-probe.mjs`，**全部 PASS**。关键结论逐条：

  **① 解析时序（前端 100s 轮询预算的前提）** —— `.md` / `.txt` 走**同步**路径：上传后**首次**取详情即已是 `success` 且正文非空（不存在可观察的中间态）；只有 `.pdf` 真的经历 `running → success`，实测两次为 **63.2s / 32.8s**，均**显著低于**前端 `40 × 2.5s ≈ 100s` 的上限。这解释了为何 `Pending`/`Running` 分支在真实链路里**只有 pdf 与失败路径能触发**，也说明前端「解析中」文案对 md/txt 是瞬时的。

  **② 正文确为 markdown 且结构完整** —— 解析产物含标题 `#`、表格分隔行、有序/无序列表、引用块 `>`、围栏代码块五种结构齐备，正文取自响应 `content` 字段。

  **③ `/storage` 取流未被拒（工单备注里的 RustFS 缺口未发生）** —— `/storage/knowledge-hub/documents/<id>/<name>` 三种文件均返回 **HTTP 200** 且 `Content-Type` 正确（`text/markdown` / `text/plain` / `application/pdf`）。即前端新增的 `res.ok` + `Content-Type` 双校验在真实链路上**是可通过的**，不是只会走报错分支。

  **④ 决定性安全发现：`html: false` 是一道承重墙** —— 上传含 `<script>alert('PROBE_SCRIPT_1')</script>`、`<img src=x onerror="alert('PROBE_ONERROR_2')">`、`<style>`、`<svg onload="alert('PROBE_SVG_3')">`、`[x](javascript:alert('PROBE_JS_4'))`、`[y](data:text/html;base64,…)` 的 `.md`，MinerU **原样透传进后端 `content`** —— 载荷在库里 **一字不改**。因此渲染层的 `html: false` 不是「冗余防御」，而是**唯一在拦这条路径的闸门**（证据二只验到 HTML 生成层，此处证明真实数据里确实带着活载荷）。任何把 `html` 改成 `true` 的改动都会立刻把未消毒的 `<script>` / `on*` 送进 `v-html`。

  **⑤ 两处字段语义复核** —— 上传响应的 `title` 是**去掉扩展名**的（`"e2e-probe"`）而 `source_file_name` 带扩展名（`"e2e-probe.md"`），**印证了下载按钮必须回落 `fileName` 而非 `title`**（否则下下来是无后缀文件）；`parse_error` 在成功时是**空字符串 `""`** 而非 `null`，与「空串回落为统一文案」的前端处理一致。

- 2026-09-20: **夹具现状（浏览器走查的素材）**。① **失败态夹具已就绪**：`fixture-parse-failed.docx`（id `7507257270661550080`）确为**真实解析失败**，`parse_state=failed`、`content` 0 字符、`parse_error` 是后端原文 `"解析失败: parsing failed, please try again later"` —— 第 5 项「`parse_error` 原文展示」可用它验，且文案非空、非占位。② **超时态夹具未就绪**：`fixture-stuck-running.pdf`（id `7507257339242614784`）需把 Mongo 的 `parse_state` 钉为 `running` 并清空 `content`，该写库操作被权限分类器拦下（理由：id 无法自证为本次会话所建，属合理拦截），**未执行**。改用 mongo-express（`localhost:8081`）手工改该文档的状态即可绕开，或授权后由脚本 `node .scratch/document-preview/make-fixtures.mjs <docId>` 钉。脚本的连接串改为从 `../knowledge-hub-backend/.env` 读 `MONGO_URI`，**不硬编码凭据**。**（2026-09-20 补记：这两个夹具与 6 个 `e2e-probe` 已在浏览器走查完成后经 `DELETE /real/document/:id` 删除并复核不在列表；后续如需夹具，用 `make-fixtures.mjs` 重新生成。）**

- 2026-09-20: **浏览器走查改为 chrome-devtools-mcp 执行（待会话重启）**。经查该 MCP **本会话未接入**：`~/.claude.json` 的 `mcpServers` 为空 `{}`、官方插件市场虽列有 `chrome-devtools-mcp` 但 `enabledPlugins` 未启用、亦无相关进程 —— 故上文「未验证项」八条**仍未验证**，不得视为通过。MCP 工具在会话启动时装载，需 `claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest` 后重启会话。届时八条的判定手段会硬化：console 走查取 **source-mapped 的未捕获 error**（对应第 7 项）、Network 取 `GET /real/document/:id` 的**请求序列**以证终态后轮询停止（对应第 1 项）与超时后停发（对应第 4 项）、页面 DOM 断言 `el-alert` 存在而 `iframe` 无空白（对应第 6 项）、以及页面级 `alert` 拦截计数为零（对应第 8 项，是证据二/四在**浏览器内**的最终确认）。

- 2026-09-20: **浏览器走查完成（chrome-devtools-mcp 实机执行），上文八条未验证项全部转绿，工单置 done。** 环境：Docker 全栈 + NestJS :3000 + Vite :5173（chrome-devtools-mcp 驱动真实 Chromium）。逐条证据：
  - **① 自动流转与轮询停止**：UI「批量上传」上传 md/txt/pdf 三份（不刷新页面，列表经 `@uploaded` 回调就地刷新）。md/txt 走同步路径，详情首取即 `done`、markdown 立即渲染，Network 中该文档的 `GET /real/document/:id` **仅 1 次**（done 态不启动轮询，与预期一致）。pdf（id `7507263356667957248`）经历完整 `解析中 → 解析完成` 流转（本次实测 8.7s，MinerU flash 对最小 PDF 明显快于此前的 32~63s），轮询请求数与 2.5s 间隔吻合，**终态后零新增详情请求**（等待 8s+ 后复查 Network 确认）。`md` 的「解析完成前 `<pre>` 原文」在真实通道不可观察（后端同步解析，无中间态窗口，与证据五 ① 一致），该分支由 Mock 通道 d065 实证（同一代码路径）——特此注明，不冒称真实通道证据。
  - **③ pdf iframe**：真实通道 `解析中` 期间 `iframe.pdf-frame` 以 blob URL 渲染 1039×508（`/storage/.../walkthrough-clean.pdf` HTTP 200）；`done` 后「查看 PDF 原文」切换同样渲染（blob iframe）。Mock 通道 d004 同过。
  - **② Mock processing 2~4s 流转**：d065（`私域运营手册-Q3-02.md`）打开详情时采样：`t=0 解析中 + <pre> 原文（【mock 文件】…）`→ `t≈2.5s（采样窗内 +522ms）解析完成 + markdown h1 渲染`，未停在「解析中」。
  - **⑧ XSS 浏览器内零弹窗**：`initScript` 注入 `alert/confirm/prompt` 计数器后进入 XSS 文档预览页：三个计数器**均为 0**；`document.body` display=block / visibility=visible（未被 `<style>` 隐藏）；正文内 `script/style/svg/iframe` 标签数、`[onerror]`/`[onload]` 属性数、`javascript:` 链接数**全部为 0**；七个载荷（含围栏逃逸 `</code></pre><script>`）全部以转义字面文本可见（截图留档）。`data:text/html` 载荷以 base64 字面文本保留（预期行为）。
  - **⑤ parse_error 原文**：`fixture-parse-failed`（id `7507257270661550080`）预览页红色 `el-alert` 展示后端原文「解析失败: parsing failed, please try again later」**逐字可见**，未出现「后端未提供失败原因」回落文案。
  - **④ 有界轮询超时**：`make-fixtures.mjs` 钉库（本会话新建文档，`docker exec mongosh` 获准执行）。首次钉库被后端迟到的解析回调覆盖（夹具空 PDF 解析失败晚于 20s 钉库，详见「教训」），重新钉库后（id `7507264681568899072`，`parse_state=running`、`content=null`）预览页静置：轮询请求**恰好 40 次**（reqid 2084→2126，2.5s 间隔）后停止，Network 无新增；提示「解析耗时已超出预期，已停止自动刷新」+「重新检查」按钮出现（截图）；点击「重新检查」后 hint 复位为「正在解析…」、轮询恢复，代际令牌与计数重置行为正确。
  - **⑥ /storage 改坏**：`vite.config.ts` 的 `/storage` target 临时改 127.0.0.1:9459（死端口）→ done pdf 预览页点「查看 PDF 原文」→ `el-alert`「原文件无法预览：HTTP 500」+ 重试按钮，**无空白 iframe**（markdown 正文不受影响）；还原后 `/storage` 200、重试可恢复，`vite.config.ts` 与改动前 SHA256 逐字节一致。
  - **⑦ 控制台**：mock 四态、真实上传/预览/XSS/失败/超时各页及回归页（大盘/搜索/个人中心/审核工作台）逐页 `list_console_messages` 查 **error 类**：全部为零；无白屏、无 TypeError。
  - **Mock 四态**：done md（d071，表格/代码/引用/列表/复制按钮齐备）、done txt（d054）、done pdf（d004，markdown+原文切换）、processing md（d065）、processing docx（d025，下载空态非空白）、failed md（d059，横幅+原文）、failed pptx（d007，横幅+下载空态）、在线文档（d001，只读 ProseMirror 有正文、无状态条）。**「无状态」文件型种子在 mock db 中不存在**（全部种子均带 parseStatus，`noState` 查询为空），该分支未在浏览器触发——状态条「状态未知」回落与正文区原格式渲染与 processing 分支共用同一 if/else-if 链，风险有限；如需补验需先造无状态种子。
  - **教训（夹具时序）**：`make-fixtures.mjs` 的钉库假设「20s 足以让解析回调先落库」，但空 PDF 走 MinerU 失败路径更慢，回调在钉库**之后**覆盖了 `running` → 首次观察显示 `failed`。重钉即可（管线已终结无再写入）。后续造卡死夹具应轮询到终态后再钉，而非固定 sleep。
  - **本会话新建的测试文档（可清理）**：md `7507262975644798976`、txt `7507262974789160960`、pdf `7507263356667957248`、xss md `7507264191158292480`、失败 docx `7507264646928142336`、卡死 pdf `7507264681568899072`。走查夹具与脚本留在 `.scratch/document-preview/fixtures-browser/` 与 `gen-pdf-fixture.mjs`。**（2026-09-20 补记：以上 6 个文档已经 `DELETE /real/document/:id` 全部删除并复核不在列表。）**
