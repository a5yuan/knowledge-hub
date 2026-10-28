---
status: current
updated: 2026-10-27
---

# 子系统：前端 API 层（`knowledge-hub-front/src/api/`）

改这个目录下的代码前必读。

## 职责

**负责**：把「资源名 → 走哪个通道、URL 长什么样、带哪个 token」这三件事收敛成唯一决策点。

**不负责**：组件状态、页面逻辑、Mock 数据的内容（那是 `src/mocks/`）。也不负责字段名转换的业务含义 —— 它只提供 `adapters/` 这个唯一的转换边界。

## 不变量

1. **任何 API 模块不得写字面量路径。** 一律 `endpoint(resource, suffix)` 取 `{ baseURL, url }`。
2. **`baseURL` 编码"走哪个通道"，`url` 编码"资源路径"。** `/api` = MSW Mock，`/real` = 真实后端（Vite 代理剥前缀转 3000）。复数→单数的重写留在 `REAL_ROOT` 常量内，不下放到业务代码。
3. **snake_case 不得越过 `src/api/`。** 本层内部允许出现（与后端对话是本职），`adapters/` 负责集中转换；漏到 `views/` / `components/` / `stores/` 即隔离失守。
4. **`/api` 永不配置代理。** 它是 Mock 的保留命名空间。
5. **`server.proxy` 与 `preview.proxy` 必须成对配置。** 构建产物经 preview 或 nginx 部署时不存在 `server.proxy`，漏配则所有真实请求落到 SPA fallback（返回 index.html）。

## 依赖方向

```
views/ ──→ api/ ──→ endpoint.ts / http.ts / session.ts
                     └──→ adapters/（唯一允许碰后端字段名的地方）

api/ 不依赖 views/、不依赖 router/、不依赖任何 store
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `endpoint.ts` | 资源模式表 `DEFAULT_MODE` + 路径重写表 `REAL_ROOT` + `endpoint()` / `isReal()` / `rawCall()` |
| `http.ts` | axios 实例，负责拆 `{code, data, message}` 包 |
| `session.ts` | access/refresh token 存取、`initSession()` 版本闸、mock token 桥 |
| `adapters/` | snake_case ↔ camelCase 的集中转换层（api 模块内联转换同样合规） |

## 已知陷阱

### `VITE_ENABLE_MOCK` 不控制通道，只控制 MSW 是否启动

通道由 `endpoint.ts` 的 `DEFAULT_MODE` 决定，**当前 16 个资源全是 `'real'`**。`VITE_ENABLE_MOCK=false` 的作用是卸载 Service Worker 拦截层，不是"切换后端"。

（2026-10-27 实测：关掉 MSW 后 `navigator.serviceWorker.getRegistrations()` 返回空数组，7 个页面全部直接读真实数据。）

### 后端未实现的接口要显式钉在 Mock 通道

`endpoint(resource, suffix, modeOverride)` 的第三个参数就是为此存在（如早期的 `auth/profile`）。不要靠改 `DEFAULT_MODE` 来实现单接口降级。

### `isReal()` 是拆包决策源

`http.ts` 靠 `config.baseURL === '/real'` 判断要不要拆 `{code,data,message}`。改变通道前缀会**静默影响拆包行为**。

### 逃生舱不要当成常规手段

`localStorage['kh_api_mode']` 可单资源回退 Mock，无需改代码重启。这是排障用的，不要写进业务流程。

### 本文件是编译期没有护栏的

`endpoint.ts` 是全项目**单文件改动最频繁**的文件（git 历史 8 次，2026-10 统计）。它不是"写一次就不动"的配置 —— 每加一个资源域都要改 `REAL_ROOT` + `DEFAULT_MODE` 两张表，改漏任何一张都会静默走错通道。

## 测试方式

前端无测试框架。验证靠浏览器实测：

1. 请求经 Vite 代理探测：`curl --noproxy '*' -X POST http://localhost:5173/real/auth/login -d ...`
2. 页面级验证用 puppeteer-core + 系统 Chrome（见 `../pitfalls.md` §五）
3. 浏览器里确认 SW 是否已卸载：`navigator.serviceWorker.getRegistrations()`
