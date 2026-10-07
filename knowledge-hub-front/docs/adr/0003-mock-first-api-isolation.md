---
status: current
updated: 2026-09-04
---

# Mock 先行：MSW 拦截 + API 层隔离，数据模型由前端规格主导

配套后端（knowledge-hub-backend）仅有空壳 document 模块，若等 API 定型再开发前端将阻塞全部工作。我们决定前端以 MSW（Mock Service Worker）拦截全部 REST 端点先行开发，组件只依赖 `src/api/` 接口层；联调时仅切换 baseURL 与拦截器，不改组件。数据模型（Document/Folder/visibility/parseStatus 等契约）以 `.scratch/knowledge-hub-mvp/spec.md` §6 为单一事实源，后端跟随实现。

## Consequences

- 后端字段命名/行为与本规格冲突时，以规格为准或显式修订规格，不允许静默分叉
- mock 种子数据对齐原型示例（分类占比、操作记录等），保证演示真实感
