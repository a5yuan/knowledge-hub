# 09 首页大盘（简化版）

Status: done
Blocked by: 02
Spec: §5.4（原型图 1）

## 目标

对齐原型图 1 的简化大盘，AI 卡片与子页面不做。

## 范围

- 统计卡 × 4：文档总数 / 今日新增文档 / 用户搜索次数 / 活跃用户数（口径=当日登录去重数，已决议）；**无 AI 问答次数卡片**
- 访问趋势折线图（今日/近7日/近30日切换，ECharts 或轻量图表库）
- 文档分类占比环形图（五类）
- 近期操作记录表（消费 05 写入的 OperationLog，字段对齐原型图 1）
- 数据全部来自 `GET /stats/dashboard` 与 `GET /operations` mock

## 验收标准

- [x] 四卡片数值与 mock 种子一致
- [x] 趋势图时间范围切换正常
- [x] 操作记录与 05 产生的日志一致
- [x] 图表库按需引入不影响包体积（按需注册）

## 备注

图表库选型在工单内定（推荐 ECharts 按需引入），涉及渲染层不影响数据契约。

## Comments

- 2026-09-08 选型：ECharts 6.1.0，经 `echarts/core` 按需注册（Line/Pie 图 + Grid/Tooltip/Legend 组件 + CanvasRenderer），封装于 `src/components/charts/VChart.vue`（单根容器：init/setOption(notMerge)/ResizeObserver/dispose）。
- 2026-09-08 验收记录：
  - 四卡片实测 30 / 1 / 946 / 1：文档总数=非归档 seed 全量；今日新增=seed daysAgo(0) 的 d008；搜索次数 946 = 种子热搜计数精确和；活跃用户=当日 login 去重（seed 仅 u-li 当日登录）。
  - 趋势切换：今日（24 小时点，当前时段后为 0）/ 近7日（7 点）/ 近30日（30 点）各发独立 `?range=` 请求且重绘正确。
  - 操作记录：与 seedOperations 顺序一致（最新在前），字段「操作时间/用户/类型/内容/相关文档」齐全，类型以彩色 tag 映射（上传/更新/删除/登录/AI 问答）。
  - 体积：echarts 按需模块随大盘路由懒加载分包（537KB / gzip 185KB），不进首屏 vendor chunk。
- 2026-09-08 契约调整（对工单 05 守卫的显式变更）：`GET /operations` 由 requireAdmin 放宽为「登录即可读」——spec §5.4 将近期操作记录置于全员可见的首页大盘，member 访问 403 会使大盘缺块；管理端（工单 11）复用同端点。
- 2026-09-08 口径说明：大盘统计为全库口径（docTotal/categoryRatio 含他人 private 文档的计数，不含归档），与文档列表按观看者权限过滤不同；spec §5.4 未约定按权限过滤，二期接真实数据时可再决议。
