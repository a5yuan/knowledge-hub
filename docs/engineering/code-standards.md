---
status: current
updated: 2026-10-27
---

# 代码标准

硬性标准，不是建议。写代码、审代码前必读。

**收录门槛**：违反后**不会立刻报错**、但后果需要人工排查才能发现的约束。会立刻编译失败或 401 的规则不在这里（AI 会自己撞到）。

---

## 一、架构边界

### 不加 Repository 抽象层

Controller → Service → **直接注入** `Repository<T>` / `Model<T>`。中间加一层 Repository 会让 TypeORM/Mongoose 的类型推导断掉，且本项目不存在"将来换 ORM"的场景。

### 不加拦截器 / 异常过滤器 / 响应包装

接口**直接返回业务对象**。`{code, data, message}` 外壳是**前端 Mock 独有**的协议，不是后端约定 —— 前端 `http.ts` 负责拆包，后端不要"配合"它。

### 校验分工

- 接口入参一律 **class-validator**（DTO + `ValidationPipe`）
- **zod 仅用于 LLM 结构化输出**（模型的返回是不可信的第三方输出，与 HTTP 入参不是一个问题）

---

## 二、数据访问

### 雪花 ID 一律转字符串出参

所有对外的 `id` 必须经 `normalizeSnowflakeId` 转 string。JS 的 `Number` 安全整数上限是 2^53-1，雪花 ID 超出该范围 —— 不转会在前端静默变成另一个数，本地跑测试完全发现不了。

### 禁止开启 TypeORM `synchronize`

表结构靠 `init-scripts/postgresql/init.sql` 手工维护。开 `synchronize` 会让实体变更直接改表，历史数据无法回滚。

### 构造 `where` 必须显式判 `!== undefined`

```ts
// ✗ 错：status=0、is_public=false 会被当成"没传"
if (dto.status) where.status = dto.status

// ✓ 对
if (dto.status !== undefined) where.status = dto.status
```

### TypeORM 0.3 取部分列必须用对象形式

```ts
select: { id: true }      // ✓
select: ['id']            // ✗ 报 TS2559
```

---

## 三、路由声明顺序

**静态子路径必须声明在 `@Get(':id')` 之前**，否则被 `:id` 吃掉，返回 404 或把 `"reviews"` 当成 ID 去查库。

已在 `document.controller.ts` 验证的既有顺序：

```
@Get('reviews/pending/count')   ← 必须在 :id 之前
@Get('reviews/pending')         ← 必须在 :id 之前
@Get(':id/reviews')
@Get(':id')
```

同款约束：`/department/tree`。新增任何 `/xxx/固定子路径` 时先确认位置。

---

## 四、前端

### snake_case 红线

后端字段名（`parse_state` / `is_public` / `author_id` …）**只允许出现在 `src/api/adapters/` 一个目录内**。视图层出现 snake_case 即等于隔离失守 —— 代码能跑，但后端改字段名时会连锁炸到页面。

### 组件只依赖 `src/api/`

视图层不直接 import `axios`，不拼 URL。URL 一律经 `endpoint(resource, suffix)` 取得（见 `subsystems/api.md`）。

### 代码风格

无分号 / 单引号 / printWidth 100；主色 `#1a66ff`。

---

## 五、提交

- conventional commits + 中文描述 + 工单编号：`feat(ai): ...（工单12）`
- 一个 commit 只做一件事；message 说"为什么"，diff 已经说明"是什么"

---

## 附：本文件未收录但常被问到的规则

| 规则 | 为什么不在本文件 |
|---|---|
| 所有接口默认需登录、`@Public()` 放行 | 违反会立刻 401，见 `subsystems/auth.md` |
| 时间戳两套时钟 | 属于「当前缺陷」而非「标准」，见 `pitfalls.md` §时间语义 |
| `ai/tools/` 工具层契约 | 模块级不变量，见 `subsystems/ai.md` |
