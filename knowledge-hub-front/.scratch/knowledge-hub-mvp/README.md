---
status: current
updated: 2026-09-28
---

# knowledge-hub-mvp

> 本目录 = 前端 MVP 的需求与工单。**整组 `issues/` 状态：`historical`（已完成）。**

## 目录内两件东西，状态不同

| 文件 | status | 说明 |
|---|---|---|
| `spec.md` | **`current`** ⚠️ | MVP 的**唯一事实来源**（数据模型 §6 + REST 契约 §7）。后端实现需与之对齐，**冲突必须显式修订 spec**，不得默默偏离 |
| `issues/01` ~ `issues/13` | `historical` | 已完成的 MVP 工单。**默认不读**，仅在需要回溯「当初为什么这么做」时查阅 |

## 给 AI 工具的提示

- 实现或修改某功能前，读 `spec.md`，**不要**逐份翻 `issues/`。
- 若要了解某个页面/能力的设计意图，issues 里的对应编号可以查，但**以现有代码为准**。
- 单个 issue 文件不再单独标注 frontmatter，以本文件为准。
