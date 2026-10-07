<script setup lang="ts">
import { computed } from 'vue'
import VChart from '@/components/charts/VChart.vue'
import type { EChartsCoreOption } from 'echarts/core'
import type { GraphStats, HotEntity, TypeDistItem } from '@/api/graph'

/**
 * 全景图谱右侧统计区（二期工单 07）：图谱数据统计 6 卡片 + 知识点类型分布环形图 + 热点 TOP5。
 * 画布边数为前端动态值（当前渲染子图边数），其余来自后端 stats。
 */
const props = defineProps<{
  stats: GraphStats
  canvasEdgeCount: number
  typeDist: TypeDistItem[]
  hotTop5: HotEntity[]
}>()

/** 类型 → 展示名（与节点分类口径一致） */
const TYPE_NAME: Record<string, string> = {
  person: '人物',
  org: '组织',
  tech: '技术',
  location: '地点',
  term: '术语',
  other: '其他',
}

/** 类型 → 环形图色（person/org 与节点分类色一致，knowledge 类绿系分档） */
const TYPE_COLOR: Record<string, string> = {
  person: '#f59e0b',
  org: '#14b8a6',
  tech: '#22c55e',
  location: '#16a34a',
  term: '#4ade80',
  other: '#86efac',
}

function typeName(type: string): string {
  return TYPE_NAME[type] ?? type
}

function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? '#94a3b8'
}

const cards = computed(() => [
  { label: '文档节点', value: props.stats.docNodes },
  { label: '知识点', value: props.stats.entities },
  { label: '实体关系', value: props.stats.relatedEdges },
  { label: '文档提及', value: props.stats.mentionEdges },
  { label: '当前标签', value: props.stats.tags },
  { label: '画布边数', value: props.canvasEdgeCount },
])

const pieOption = computed<EChartsCoreOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
  series: [
    {
      type: 'pie',
      radius: ['45%', '72%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      label: { show: true, fontSize: 11, color: '#606266', formatter: '{b}' },
      data: props.typeDist.map((t) => ({
        name: typeName(t.type),
        value: t.count,
        itemStyle: { color: typeColor(t.type) },
      })),
    },
  ],
}))
</script>

<template>
  <div class="stats-panel">
    <el-card shadow="never" class="block">
      <h3 class="block-title">图谱数据统计</h3>
      <div class="stat-grid">
        <div v-for="c in cards" :key="c.label" class="stat-card">
          <div class="stat-value">{{ c.value }}</div>
          <div class="stat-label">{{ c.label }}</div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <h3 class="block-title">知识点类型分布</h3>
      <div class="pie-wrap">
        <VChart v-if="typeDist.length" :option="pieOption" />
        <el-empty v-else description="暂无数据" :image-size="60" />
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <h3 class="block-title">热点 TOP5</h3>
      <ol v-if="hotTop5.length" class="hot-list">
        <li v-for="(h, i) in hotTop5" :key="h.name" class="hot-item">
          <span class="hot-rank" :class="`rank-${i + 1}`">{{ i + 1 }}</span>
          <span class="hot-name" :title="h.name">{{ h.name }}</span>
          <el-tag size="small" effect="plain">{{ typeName(h.entityType) }}</el-tag>
          <span class="hot-count">{{ h.mentionCount }} 次提及</span>
        </li>
      </ol>
      <el-empty v-else description="暂无数据" :image-size="60" />
    </el-card>
  </div>
</template>

<style scoped>
.stats-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.block-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.stat-card {
  background: #f5f7fa;
  border-radius: 8px;
  padding: 12px 8px;
  text-align: center;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--el-color-primary);
  line-height: 1.2;
}

.stat-label {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.pie-wrap {
  height: 220px;
}

.hot-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hot-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hot-rank {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f5f7fa;
  color: #909399;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.rank-1 {
  background: #fde68a;
  color: #92400e;
}

.rank-2 {
  background: #e5e7eb;
  color: #374151;
}

.rank-3 {
  background: #fed7aa;
  color: #9a3412;
}

.hot-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #303133;
}

.hot-count {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}
</style>
