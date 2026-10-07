<script lang="ts">
import type { GraphNode } from '@/api/graph'

/** 原型图例色板（与 knowledge-graph 全景页共用，12 号工单抽取为共享组件） */
export const GRAPH_CATEGORIES = [
  { name: '文档', color: '#3b82f6' },
  { name: '知识点', color: '#22c55e' },
  { name: '人物', color: '#f59e0b' },
  { name: '组织', color: '#14b8a6' },
  { name: '标签', color: '#8b5cf6' },
]

export function graphCategoryIndex(n: Pick<GraphNode, 'kind' | 'entityType'>): number {
  if (n.kind === 'document') return 0
  if (n.entityType === 'person') return 2
  if (n.entityType === 'org') return 3
  return 1
}

export default {}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EChartsCoreOption } from 'echarts/core'
import VChart from './VChart.vue'
// GraphNode 已在上方 <script lang="ts"> 导入（双块共享模块作用域，勿重复导入）
import type { GraphEdge } from '@/api/graph'

const props = withDefaults(
  defineProps<{
    nodes: GraphNode[]
    edges: GraphEdge[]
    /** 固定高度（px）；缺省撑满父容器（全景页 flex 布局） */
    height?: number
    /** 初始缩放（全景页缩放控件用；mini 卡片用默认 1） */
    zoom?: number
    /** mini 模式：精简边样式/字号，适配时间线卡片内嵌 */
    mini?: boolean
  }>(),
  { zoom: 1, mini: false },
)

const chartRef = ref<InstanceType<typeof VChart>>()

const graphOption = computed<EChartsCoreOption>(() => ({
  tooltip: {
    formatter: (p: { dataType?: string; data?: { id?: string; name?: string; kind?: string; entityType?: string; relation?: string } }) => {
      const d = p.data
      if (!d) return ''
      if (p.dataType === 'edge') return d.relation ? `关联：${d.relation}` : '提及'
      const kind = d.kind === 'document' ? '文档' : (d.entityType === 'person' ? '人物' : d.entityType === 'org' ? '组织' : '知识点')
      return `${kind}：${d.name}`
    },
  },
  series: [
    {
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      zoom: props.zoom,
      scaleLimit: { min: 0.3, max: 4 },
      force: props.mini
        ? { repulsion: 220, edgeLength: [40, 90], gravity: 0.08 }
        : { repulsion: 150, edgeLength: [40, 110], gravity: 0.06 },
      categories: GRAPH_CATEGORIES.map((c) => ({ name: c.name, itemStyle: { color: c.color } })),
      data: props.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        category: graphCategoryIndex(n),
        kind: n.kind,
        entityType: n.entityType,
        symbolSize: n.kind === 'document' ? 30 : props.mini ? 12 : 16,
      })),
      links: props.edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        relation: e.relation,
        lineStyle: e.kind === 'related'
          ? { type: 'dashed', color: '#9ca3af', width: 1.2 }
          : { color: '#3b82f6', width: 1.6 },
      })),
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 7,
      label: { show: true, position: 'right', fontSize: props.mini ? 10 : 11, color: '#606266' },
      emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      left: 10,
      right: 10,
      top: props.mini ? 10 : 20,
      bottom: props.mini ? 10 : 50,
    },
  ],
}))

/** 暴露 ECharts 实例：全景页文档节点点击事件绑定与缩放控件依赖 */
defineExpose({ getInstance: () => chartRef.value?.getInstance() })
</script>

<template>
  <VChart ref="chartRef" :option="graphOption" :style="height ? { height: `${height}px` } : undefined" />
</template>
