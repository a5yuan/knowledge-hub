---
status: current
updated: 2026-09-04
---

# 采用 Vue 3 + Vite + TypeScript + Pinia + Element Plus 技术基座

企业知识库前端从零建设，需要管理后台型组件的全覆盖与长期可维护性。我们选择 Vue 3（Composition API + script setup）+ Vite + TypeScript + Pinia + vue-router + Element Plus 作为固定基座，因为团队生态一致、Element Plus 对中后台场景组件覆盖最全且中文文档成熟。

## Considered Options

- Naive UI / Arco Design / Ant Design Vue：组件质量相当，但团队既有经验与社区中文资料密度不如 Element Plus
- React 系（Ant Design）：与本项目工具链和团队技能栈不符

## Consequences

UI 视觉以原型为基准做 Element Plus 主题定制；组件能力边界（如树形控件、表格虚拟滚动）在遇到性能瓶颈时才允许引入第三方补充。
