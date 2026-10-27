# AGENTS.md

> 给 **AI 编码工具**的地图。人类读者请看 `README.md`。
> 校验日期：2026-10-27。**若发现本文件与实际不符，先把差异报告给用户，再动手。**

## 0 工作区

企业级知识库（Knowledge Hub）：NestJS 11 后端 + Vue 3 前端，RAG + 知识图谱双链路。

| 目录 | 说明 |
|---|---|
| `knowledge-hub-backend/` | 后端，`src/` 113 个 ts |
| `knowledge-hub-front/` | 前端，`src/` 78 个源文件 |
| `docs/engineering/` | **工程规范与陷阱（AI 读，本文件的二级文档）** |
| `docs/demo/`、`docs/images/` | 演示录屏 / 讲稿 / 截图（**给人看的素材，不是文档**） |
| `backend-integration/` | 联调层 `spec.md` + 32 份工单 —— **本地私有、已 gitignore、不在仓库里** |

⚠️ **单仓库模式**：只有根 `.git`，两个子项目直接纳入根仓库 `main` 分支。提交时不要 `cd` 进子目录以为在另一个仓库 —— `git rev-parse --show-toplevel` 一律返回根目录。

扫描排除：`**/node_modules/`（约 9.9 万文件）、`knowledge-hub-backend/volumes/`（916 MB）、`**/dist/`、`**/.run-build/`。行尾统一 LF（`.gitattributes` + `core.autocrlf=input`）。

## 1 命令

包管理器 **pnpm**，不是 npm。

```bash
# 后端
cd knowledge-hub-backend
docker compose -f docker.compose.yml up -d   # 注意不是 docker-compose.yml
pnpm install && pnpm run start:dev           # http://localhost:3000

# 前端
cd knowledge-hub-front
pnpm install && pnpm dev                     # http://localhost:5173（用 localhost，不要 [::1]）
```

后端无全局路由前缀、无响应包装、无 Swagger。演示账号 `admin` / `li` / `qian` / `wang`，密码均 `123456`。

**启动后端遇到 `nest start` 卡住，或需要跑最新代码** → 先读 `docs/engineering/pitfalls.md` §一.5（`.run-build` 绕行法，无 watch）。

## 2 路由表：干什么活先读什么

| 你要做的事 | 先读 |
|---|---|
| 写 / 改后端代码（任何模块） | `docs/engineering/code-standards.md` |
| 改前端 API 层、通道、适配器 | `docs/engineering/subsystems/api.md` |
| 改 Agent 循环 / 工具 / 预算 / SSE | `docs/engineering/subsystems/ai.md` |
| 改鉴权 / 角色 / 权限码 | `docs/engineering/subsystems/auth.md` |
| 改文档 CRUD / 审核流转 | `docs/engineering/subsystems/document.md` |
| **写任何时间边界、时区相关逻辑** | `docs/engineering/pitfalls.md` §三 **必读** |
| 本机怪象（代理 / 中文乱码 / 启动慢 / 容器 / lint） | `docs/engineering/pitfalls.md` §一~§二 |
| 找设计背景（"当初为什么这么设计"） | `knowledge-hub-backend/.trae/documents/`（12 份，已入库） |
| 找前端架构决策 | `knowledge-hub-front/docs/adr/`（0001~0006，已入库） |
| 找历史工单 / 联调契约 | `backend-integration/issues/`、`spec.md`（**本地私有，不在仓库**） |

## 3 静默致命红线

违反后**不会立刻报错**，但后果需要人工排查才能发现。完整理由见 `code-standards.md`。

1. **雪花 ID 必须经 `normalizeSnowflakeId` 转字符串出参** —— 否则前端精度丢失，本地测不出
2. **不加 Repository 抽象层、不加拦截器 / 异常过滤器 / 响应包装** —— 能跑，架构却已破
3. **静态子路径必须声明在 `@Get(':id')` 之前** —— 否则 404，排查半天
4. **snake_case 只允许出现在 `src/api/adapters/`** —— 视图层出现即隔离失守
5. **前端 URL 一律经 `endpoint(resource, suffix)`** —— 不写字面量路径
6. **写时间边界前读 `pitfalls.md` §三** —— 两套时钟基准并存（25F 完成前）
7. **不要跑 `pnpm run lint`** —— 实测一次重排 63 个无关文件；校验用 `pnpm run build` + `pnpm test`

## 4 文档约定

- 设计 / 工单文档头部统一 YAML frontmatter：`status: current | evolving | historical` + `updated: YYYY-MM-DD`
- **只索引 `current`**；未列出者默认不读（失败方向安全：漏标 → AI 不读，而不是读到过期内容）。一条命令拉地图：`grep -rn "^status:" --include="*.md" .`
- **`historical` = 已完成工单的设计记录。改代码时以代码为准，不要照文档改代码**
- 本文件的路由表**按目录指向，不逐个列文件名** —— 新增文档不需要回来改本文件

## 5 兜底

- 路由表里找不到对应任务：**先写文档，再写代码**。空缺本身就是问题
- 两份文档冲突：以 `docs/engineering/code-standards.md` 为准，并记录另一份待修
- 本文件与代码冲突：**以代码为准**，并报告差异
- **本文件行数上限 80 行**。超了说明该拆到 `docs/engineering/`，不是该继续加
