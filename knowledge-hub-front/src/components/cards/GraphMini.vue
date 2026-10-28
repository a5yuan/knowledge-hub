<script setup lang="ts">
/**
 * 知识图谱迷你图（catalog: graphMini）。
 *
 * 复用全景页的 GraphCanvas 而非另写一套：同一份 ECharts 配置，
 * 只是开 `mini` 精简边样式与字号，并固定高度适配卡片内嵌。
 */
import { computed } from 'vue'
import GraphCanvas from '@/components/charts/GraphCanvas.vue'
import type { GraphEdge, GraphNode } from '@/api/graph'

const props = defineProps<{
  entities: Array<{ name: string; type: string; description?: string }>
  relations: Array<{ source: string; relation: string; target: string }>
}>()

/** 实体名即节点 id：关系的 source / target 用实体名匹配（与时间线里的旧实现一致） */
const nodes = computed<GraphNode[]>(() =>
  props.entities.map((e) => ({
    id: e.name,
    kind: 'entity',
    name: e.name,
    entityType: e.type as GraphNode['entityType'],
    description: e.description ?? null,
  })),
)

const edges = computed<GraphEdge[]>(() =>
  props.relations.map((r) => ({
    source: r.source,
    target: r.target,
    kind: 'related',
    relation: r.relation,
  })),
)
</script>

<template>
  <div class="gm">
    <div class="gm-head">
      <el-tag size="small" type="warning" effect="light">图谱</el-tag>
      <span class="gm-count">{{ entities.length }} 个实体 · {{ relations.length }} 条关系</span>
    </div>

    <GraphCanvas v-if="nodes.length" :nodes="nodes" :edges="edges" :height="240" mini />
    <p v-else class="gm-empty">未检索到图谱实体。</p>
  </div>
</template>

<style scoped>
.gm {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}

.gm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 6px;
}

.gm-count {
  color: #303133;
}

.gm-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}
</style>
