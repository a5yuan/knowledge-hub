---
status: current
updated: 2026-10-27
---

# 已知陷阱与当前缺陷

**收录门槛**：踩过一次、且不知道就会重复踩的东西。每条都标注来源（实测日期 / 工单号 / 文件位置）。

**本文件不是待办清单。** 待修项的工单在 `backend-integration/issues/`（本地私有，不入库）。

---

## 一、本机工具链坑（换机器就会重复踩）

### 1. Git Bash 下 `curl -d '(中文)'` 会逐字节损坏中文

请求体里的中文会被破坏成乱码，服务端存进去的就是乱码，而且**与真中文不相等** —— 导致唯一约束/重名判定得出完全错误的结论（曾因此误判"重名返回 409"为通过）。

**做法**：凡请求体含中文，一律用 Write 落地 UTF-8 文件 + `--data-binary @file`，不要内联进命令行。

### 2. `docker logs` 里 PG 的日志走 stderr

`execFileSync('docker', [...])` 只回收 stdout 会得到空串，误以为"没有日志"。
用 `execSync('docker logs ... 2>&1')` 才能读到。

### 3. `curl 127.0.0.1:PORT` 受本机代理干扰

本机跑着 mihomo（7890/7891），不加 `--noproxy '*'` 会拿到 502。
所有本地探测统一加 `--noproxy '*'`。

### 4. vite dev 只监听 `[::1]`，浏览器必须用 `localhost`

用 `http://[::1]:5173` 访问会**白屏**：MSW 的路径解析把 `[::1]:` 里的冒号当成路径参数占位符，抛 `TypeError: Missing parameter name at 9`，随后所有 `/src/*.vue` 模块请求被 SW 返回 500。

用主机名 `localhost` 即可绕过（仍连到 ::1）。

### 5. `nest start` 的 `deleteOutDir: true` 会卡在沙箱的批量删除确认

本地绕行：

```bash
npx tsc --outDir ./.run-build
node .run-build/src/main.js
```

⚠️ 绕行产物**没有 watch**。改代码后不重编译就会跑到旧代码上 —— 启动前先核对「有无运行期 `.ts` 比 `.run-build/src/main.js` 新」：

```bash
find src -name "*.ts" -newer .run-build/src/main.js
```

### 6. 不要跑 `pnpm run lint`

它带 `eslint --fix` + prettier，配置与现存代码风格不一致，**实测一次重排 63 个无关文件**。校验用 `pnpm run build` + `pnpm test`。（另：该仓库 lint 本身当前也不通过，约 171 项既有类型解析报错。）

### 7. `src/storage/rustfs.service.ts` 的 `onModuleInit` 缺兜底

`HeadBucketCommand` 失败后走 catch，而 `CreateBucketCommand` 没有 try/catch —— RustFS 未就绪时抛未捕获异常，**整个进程 `exit 1`**。

排障特征：`TimeoutError: socket hang up`（`$metadata.attempts`）。临时恢复：`docker restart knowledge_hub_rustfs`。

### 8. 启动慢 ≠ 卡死

本机内存紧张时（Docker 的 WSL2 虚拟机可占 ~5 GB 且不归还宿主），Node 同步加载依赖图会因缺页抖动拖到 **3~4 分钟，期间没有任何日志输出**（事件循环被阻塞）。

先看 `Pages Input/sec` 与可用内存，不要误判成死锁去重启。

### 9. Docker / WSL 维护顺序

**先 `docker desktop stop`，再 `wsl --shutdown`，最后启动 Docker Desktop。**

在 Docker 运行时直接 `wsl --shutdown` 会破坏宿主→容器的端口转发（TCP 能连、握手被空响应 / ECONNRESET）。Docker 重启后部分容器（rabbitmq/redis/rustfs/neo4j）可能不自启，需 `docker start` 补起。

---

## 二、命名陷阱（找文件/查容器时会绕远路）

| 易错点 | 实际值 |
|---|---|
| 后端 compose 文件名 | `docker.compose.yml`（**不是** `docker-compose.yml`） |
| Compose 服务名 | Elasticsearch 的服务名是 **`es`**，不是 `elasticsearch` |
| PG 容器名 | `knowledge_hub_postgres`（**下划线**） |
| PG 用户 | `user`（不是 `postgres`） |
| Redis 端口 | 6379 归 `knowledge_hub_redis` **独占**，不要再起冲突实例 |
| 同名控制器 | `rag/ai.controller.ts` 与 `ai/ai.controller.ts` **同名不同模块**，改之前先确认路径 |

---

## 三、时间语义（最高危，写任何时间边界前必读）

### 现状：两套时钟基准并存

| 字段 | 写入方 | 列里存的时钟读数 |
|---|---|---|
| `kh_document.created_at`、`kh_operation_log.created_at` | DB `DEFAULT now()`（会话 `Etc/UTC`） | **UTC 字面** |
| `kh_user.last_login_at` | 应用 `new Date()` | **本地字面** |

**根因**：列类型是 `timestamp without time zone` → 丢时区；node-postgres 把 `Date` 参数按**本地字段**序列化成 `...+08:00`；PostgreSQL 对 `timestamp` **静默忽略**该偏移。

**做法**：按字段基准传字符串，用 `stats.service.ts` 的 `utcLiteral()` / `localLiteral()`。**别用 `MoreThanOrEqual(Date)` 赌驱动行为。**

**已观察到的后果**：`created_at` 出参经 pg 按本地解析后再 `toISOString()`，导致**前端展示早 8 小时**（2026-10-27 实测：15:02 的登录在大盘显示为 `07:02:27`）。

### ⚠️ 本条目的失效条件

修复工单集已就绪：`backend-integration/issues/25-timezone-unification.md`（含 25A–25F 六张，`status: evolving`）。

- **25F 完成前**：按上面的"传字符串"方式写
- **25F 完成后**：本条**整段失效**。届时改为「查 `init.sql` 确认列类型是 `timestamptz`」，`utcLiteral()` / `localLiteral()` 应已删除
- 25F 前的任何时间相关改动，先读 25 号工单的阻塞图，确认自己没绕过影子列

**风险提示（来自 25 号工单）**：把 C 类列（`publish_time` / `expire_time`，语义未定）当 A 类回填 = **数据偏移 8 小时且不可逆**。

---

## 四、已知缺陷（不修，但要知道）

| 缺陷 | 位置 | 影响 |
|---|---|---|
| MQ 消费失败**仅记日志并 ack**，无 DLQ、无重投 | `pipeline/` 消费者（代码内已标 TODO） | 消息丢失不可察觉 |
| refresh Token **无服务端吊销** | `auth/` | 泄露窗口 = refresh 有效期（默认 7d） |
| 文档 CRUD 未做归属校验；`author_id` / `create_by` 取自请求体而非 Token | `document/` | 可越权伪造作者 |
| 无 Swagger / 无健康检查模块 / 无 Dockerfile / 无 CI | 全局 | 运维与排障靠手工 |

---

## 五、验证方式（本机）

前端自动化验收用 **puppeteer-core + 系统 Chrome**（不下载 Chromium）：

```bash
npm i puppeteer-core --prefix ~/.workbuddy/binaries/node/workspace
# executablePath: C:\Program Files\Google\Chrome\Application\chrome.exe
# 运行时带 NODE_PATH=<workspace>/node_modules
```

- 后端登录响应是**扁平**结构 `{ accessToken, refreshToken, tokenType, expiresIn, userInfo }`，不是 `{data:{token}}`
- 演示账号：`admin` / `li` / `qian` / `wang`，密码均 `123456`
