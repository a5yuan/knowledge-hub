# 01 项目脚手架与布局壳

Status: done
Blocked by: -
Spec: §4 信息架构、§9 技术栈与约束

## 目标

建立可运行的工程基座和全局布局壳，后续所有工单在此之上开发。

## 范围

- Vite + Vue 3（script setup）+ TypeScript + Pinia + vue-router + Element Plus 初始化
- ESLint + Prettier 配置
- 目录结构：`src/{api,components,composables,layouts,router,stores,styles,views,mocks}`
- 全局布局壳：顶栏（Logo + 一级导航 + 通知/用户下拉）+ 内容区，视觉对齐原型图 1 顶栏（蓝色主色、卡片化）
- 一级路由占位：七个模块的空路由与菜单（首页大盘/文档管理/智能搜索/AI智能问答/知识图谱/个人中心/系统管理-仅管理员可见）
- Element Plus 主题变量定制（主色对齐原型）

## 验收标准

- [x] `pnpm dev` 可启动，导航切换路由正常
- [x] 七个菜单项渲染，系统管理对非管理员隐藏（暂用本地模拟角色）
- [x] `pnpm build` 通过，TS 无错误

## Comments

- 2026-09-04 完成并验收通过。
- 验收证据：`vue-tsc -b` 0 错误；`vite build` 成功（17.98s，主包 1.2MB——Element Plus 全量引入所致，按需引入优化留待后续工单）；dev server 启动 HTTP 200；浏览器实测：member 视图 6 个菜单（系统管理隐藏），切换 admin 后第 7 项出现，点击导航路由跳转正常（/dashboard → /documents）。
- 环境备注：沙箱内运行 pnpm 需 `--store-dir` 指向可写路径并禁用 verify-deps-before-run；`@vue/eslint-config-typescript` 实际采用 ^14.5.0（0.14.5 版本线已废弃）。
- 附加修正：`@types/node`（vite.config 使用 node:url）、tsconfig.app.json types 补 `vite/client`（router 使用 import.meta.env）。
- 已知事项：eslint 9.39.5 有 deprecation 警告（上游版本线问题，不影响使用）；esbuild postinstall 被 pnpm 默认拦截，构建正常（二进制来自 @esbuild/win32-x64 平台包）。
