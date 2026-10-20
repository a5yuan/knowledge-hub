<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Document, DocumentAdd, Search, User } from '@element-plus/icons-vue'
import { fetchDashboardStats } from '@/api/stats'
import { fetchOperations, type OperationLogView } from '@/api/operations'
import { fetchAnnouncements } from '@/api/announcements'
import type { Announcement, DashboardStats } from '@/types/api'
import VChart from '@/components/charts/VChart.vue'
import type { EChartsCoreOption } from 'echarts/core'

/**
 * 首页大盘（工单 09，spec §5.4 / 原型图 1 简化版）：
 * 统计卡 ×4（无 AI 问答卡片）；活跃用户口径=当日登录去重（已决议，mock 于 stats handler 内实现）。
 * 趋势/环形图经 VChart 按需引入 ECharts；操作记录消费 GET /operations（登录即可读）。
 * 21 号工单：新增「系统公告」卡片，数据来自 GET /announcement?enabled=true（启用且未过期）。
 */
type Range = 'today' | '7d' | '30d'

const range = ref<Range>('7d')
const stats = ref<DashboardStats | null>(null)
const ops = ref<OperationLogView[]>([])
const announcements = ref<Announcement[]>([])
const loading = ref(false)

/** 大盘只露前 3 条，更多去管理页（工单 21 的展示位口径） */
const ANNOUNCEMENT_LIMIT = 3

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近7日' },
  { value: '30d', label: '近30日' },
]

type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'

/**
 * 动作 → 标签（19 号工单）。
 *
 * 覆盖后端 `OPERATION_ACTIONS` 全量（21 种）。用 Record<string, …> 而非
 * Record<OperationAction, …>：后者会让「后端新增了 action」变成 TS 报错的静默缺口，
 * 前者配合 `actionMeta()` 兜底，漏配只会显示原始英文串，不会白屏。
 */
const ACTION_META: Record<string, { label: string; type: TagType }> = {
  // 文档域
  upload: { label: '上传', type: 'success' },
  update: { label: '更新', type: 'primary' },
  delete: { label: '删除', type: 'danger' },
  publish: { label: '发布', type: 'success' },
  archive: { label: '归档', type: 'warning' },
  'review-approve': { label: '审核通过', type: 'success' },
  'review-reject': { label: '审核驳回', type: 'danger' },
  // 认证域
  login: { label: '登录', type: 'info' },
  // AI 域
  'ai-ask': { label: 'AI 问答', type: 'warning' },
  // 检索域
  search: { label: '搜索', type: 'info' },
  // 管理域：用户
  'user-create': { label: '新增用户', type: 'primary' },
  'user-edit': { label: '编辑用户', type: 'primary' },
  'user-delete': { label: '删除用户', type: 'danger' },
  // 管理域：团队
  'team-create': { label: '新建团队', type: 'primary' },
  'team-edit': { label: '编辑团队', type: 'primary' },
  'team-delete': { label: '删除团队', type: 'danger' },
  // 管理域：目录
  'folder-create': { label: '新建目录', type: 'primary' },
  'folder-delete': { label: '删除目录', type: 'warning' },
  // 管理域：公告（21 号工单）
  'announcement-create': { label: '新建公告', type: 'primary' },
  'announcement-update': { label: '编辑公告', type: 'primary' },
  'announcement-delete': { label: '删除公告', type: 'danger' },
}

/**
 * 未知 action 的兜底渲染。
 * 后端 action 列是自由 varchar，前端穷举清单必然滞后 —— 显示原始串比抛 TypeError 让整页白屏好。
 */
function actionMeta(action: string): { label: string; type: TagType } {
  return ACTION_META[action] ?? { label: action || '未知操作', type: 'info' }
}

const statCards = computed(() => [
  { key: 'docTotal', label: '文档总数', value: stats.value?.totals.docTotal, icon: Document, color: '#1a66ff' },
  { key: 'todayNew', label: '今日新增文档', value: stats.value?.totals.todayNew, icon: DocumentAdd, color: '#52c41a' },
  { key: 'searchCount', label: '用户搜索次数', value: stats.value?.totals.searchCount, icon: Search, color: '#fa8c16' },
  { key: 'activeUsers', label: '活跃用户数', value: stats.value?.totals.activeUsers, icon: User, color: '#722ed1' },
])

const trendOption = computed<EChartsCoreOption>(() => {
  const points = stats.value?.trend.points ?? []
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 16, top: 24, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: points.map((p) => p.label) },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed' } } },
    series: [
      {
        name: '访问量',
        type: 'line',
        smooth: true,
        data: points.map((p) => p.value),
        itemStyle: { color: '#1a66ff' },
        areaStyle: { color: 'rgba(26, 102, 255, 0.12)' },
      },
    ],
  }
})

const PIE_COLORS = ['#1a66ff', '#52c41a', '#fa8c16', '#722ed1', '#13c2c2']

/** 环形中心叠加的总数（与 categoryRatio 同口径求和） */
const pieTotal = computed(() => (stats.value?.categoryRatio ?? []).reduce((sum, c) => sum + c.count, 0))

const pieOption = computed<EChartsCoreOption>(() => {
  const items = stats.value?.categoryRatio ?? []
  const total = items.reduce((sum, c) => sum + c.count, 0)
  return {
    tooltip: { trigger: 'item', formatter: '{b}：{c} 篇（{d}%）' },
    // 对齐原型图 1：环形居左、中心显示文档总数，图例居右带数量与占比
    legend: {
      orient: 'vertical',
      right: 8,
      top: 'middle',
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      formatter: (name: string) => {
        const it = items.find((c) => c.name === name)
        const pct = total ? Math.round(((it?.count ?? 0) / total) * 1000) / 10 : 0
        return `${name}  ${it?.count ?? 0}  ${pct}%`
      },
    },
    // 对齐原型图 1：环形居左、图例居右带数量与占比；中心总数由模板层叠加（VChart 未注册 title 组件）
    color: PIE_COLORS,
    series: [
      {
        name: '文档分类',
        type: 'pie',
        radius: ['42%', '62%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        data: items.map((c) => ({ name: c.name, value: c.count })),
      },
    ],
  }
})

async function loadStats(): Promise<void> {
  try {
    stats.value = await fetchDashboardStats(range.value)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '大盘数据加载失败')
  }
}

function onRangeChange(): void {
  void loadStats()
}

async function loadOps(): Promise<void> {
  try {
    const page = await fetchOperations({ page: 1, pageSize: 10 })
    ops.value = page.list
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作记录加载失败')
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

/** 公告卡片只显示日期（时间精度对公告没有意义，反而占宽） */
function formatDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function loadAnnouncements(): Promise<void> {
  try {
    // enabled=true 由后端保证「启用 + 已到发布时间 + 未过期」，前端不再二次过滤
    const list = await fetchAnnouncements({ enabled: true })
    announcements.value = list.slice(0, ANNOUNCEMENT_LIMIT)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '公告加载失败')
  }
}

/** 点标题看全文（纯文本；富文本渲染不在工单 21 范围） */
function showAnnouncementDetail(item: Announcement): void {
  void ElMessageBox.alert(item.content, item.title, {
    confirmButtonText: '知道了',
    customClass: 'announcement-detail',
  })
}

onMounted(() => {
  loading.value = true
  void Promise.all([loadStats(), loadOps(), loadAnnouncements()]).finally(() => {
    loading.value = false
  })
})
</script>

<template>
  <div class="page dashboard-page" v-loading="loading">
    <!-- 19/20 号工单：stats 与 operations 均已接真实后端，「演示数据」标注至此全部解除 -->
    <h2 class="page-title">首页大盘</h2>

    <!-- 统计卡 ×4 -->
    <div class="stat-grid">
      <el-card v-for="card in statCards" :key="card.key" shadow="never" class="stat-card">
        <div class="stat-body">
          <el-icon class="stat-icon" :size="30" :style="{ color: card.color }">
            <component :is="card.icon" />
          </el-icon>
          <div class="stat-text">
            <div class="stat-value">{{ card.value ?? '—' }}</div>
            <div class="stat-label">{{ card.label }}</div>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 趋势折线 + 分类环形 -->
    <div class="chart-grid">
      <el-card shadow="never" class="chart-card">
        <template #header>
          <div class="card-head">
            <span>访问趋势</span>
            <el-radio-group v-model="range" size="small" @change="onRangeChange">
              <el-radio-button v-for="opt in RANGE_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <VChart v-if="stats" :option="trendOption" />
      </el-card>

      <el-card shadow="never" class="chart-card">
        <template #header>
          <div class="card-head">
            <span>文档分类占比</span>
          </div>
        </template>
        <div class="pie-wrap">
          <VChart v-if="stats" :option="pieOption" />
          <div class="pie-center">
            <div class="pie-total">{{ pieTotal }}</div>
            <div class="pie-sub">文档总数</div>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 底部：近期操作记录 + 系统公告（21 号工单新增展示位） -->
    <div class="bottom-grid">
      <el-card shadow="never" class="ops-card">
        <template #header>
          <div class="card-head">
            <span>近期操作记录</span>
          </div>
        </template>
        <el-table :data="ops" stripe>
          <el-table-column label="操作时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column prop="userName" label="用户" width="100" />
          <el-table-column label="类型" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="actionMeta(row.action).type" effect="light">
                {{ actionMeta(row.action).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="内容" min-width="200" show-overflow-tooltip />
          <el-table-column label="相关文档" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ row.targetTitle || '—' }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="notice-card">
        <template #header>
          <div class="card-head">
            <span>系统公告</span>
          </div>
        </template>
        <el-empty v-if="!announcements.length" description="暂无公告" :image-size="60" />
        <ul v-else class="notice-list">
          <li v-for="item in announcements" :key="item.id" @click="showAnnouncementDetail(item)">
            <span class="notice-title" :title="item.title">{{ item.title }}</span>
            <span class="notice-time">{{ formatDate(item.publishTime ?? item.createdAt) }}</span>
          </li>
        </ul>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card :deep(.el-card__body) {
  padding: 20px;
}

.stat-body {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-icon {
  flex-shrink: 0;
}

.stat-value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
}

.stat-label {
  margin-top: 4px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.chart-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  margin-top: 16px;
}

.chart-card :deep(.el-card__body) {
  height: 320px;
}

.pie-wrap {
  position: relative;
  height: 100%;
}

.pie-center {
  position: absolute;
  left: 35%;
  top: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  pointer-events: none;
}

.pie-total {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
}

.pie-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ops-card {
  min-width: 0;
}

/* 21 号工单：操作记录（宽）与系统公告（窄）并列一行 */
.bottom-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  margin-top: 16px;
}

.notice-card :deep(.el-card__body) {
  padding: 8px 20px 12px;
}

.notice-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notice-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
}

.notice-list li:last-child {
  border-bottom: none;
}

.notice-list li:hover .notice-title {
  color: var(--el-color-primary);
}

.notice-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.2s;
}

.notice-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
