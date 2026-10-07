<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, DocumentAdd, Search, User } from '@element-plus/icons-vue'
import { fetchDashboardStats } from '@/api/stats'
import { fetchOperations, type OperationLogView } from '@/api/operations'
import type { DashboardStats, OperationAction } from '@/types/api'
import VChart from '@/components/charts/VChart.vue'
import type { EChartsCoreOption } from 'echarts/core'

/**
 * 首页大盘（工单 09，spec §5.4 / 原型图 1 简化版）：
 * 统计卡 ×4（无 AI 问答卡片）；活跃用户口径=当日登录去重（已决议，mock 于 stats handler 内实现）。
 * 趋势/环形图经 VChart 按需引入 ECharts；操作记录消费 GET /operations（登录即可读）。
 */
type Range = 'today' | '7d' | '30d'

const range = ref<Range>('7d')
const stats = ref<DashboardStats | null>(null)
const ops = ref<OperationLogView[]>([])
const loading = ref(false)

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近7日' },
  { value: '30d', label: '近30日' },
]

const ACTION_META: Record<OperationAction, { label: string; type: 'primary' | 'success' | 'warning' | 'danger' | 'info' }> = {
  upload: { label: '上传', type: 'success' },
  update: { label: '更新', type: 'primary' },
  delete: { label: '删除', type: 'danger' },
  login: { label: '登录', type: 'info' },
  'ai-ask': { label: 'AI 问答', type: 'warning' },
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

onMounted(() => {
  loading.value = true
  void Promise.all([loadStats(), loadOps()]).finally(() => {
    loading.value = false
  })
})
</script>

<template>
  <div class="page dashboard-page" v-loading="loading">
    <!-- 后端无仪表盘统计接口，本页数据恒为 Mock（工单 05：显式标注，避免误解为真实数据） -->
    <h2 class="page-title">首页大盘<el-tag size="small" type="info" effect="plain" style="margin-left: 8px">演示数据</el-tag></h2>

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

    <!-- 近期操作记录 -->
    <el-card shadow="never" class="ops-card">
      <template #header>
        <div class="card-head">
          <span>近期操作记录</span>
        </div>
      </template>
      <el-table :data="ops" stripe>
        <el-table-column label="操作时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="userName" label="用户" width="120" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="ACTION_META[row.action as OperationAction].type" effect="light">
              {{ ACTION_META[row.action as OperationAction].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="内容" min-width="220" show-overflow-tooltip />
        <el-table-column label="相关文档" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.targetTitle || '—' }}</template>
        </el-table-column>
      </el-table>
    </el-card>
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
  margin-top: 16px;
}
</style>
