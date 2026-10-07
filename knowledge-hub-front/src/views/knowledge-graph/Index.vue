<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { ECElementEvent } from 'echarts/core'
import GraphCanvas, { GRAPH_CATEGORIES } from '@/components/charts/GraphCanvas.vue'
import GraphSearchBar from './components/GraphSearchBar.vue'
import GraphStatsPanel from './components/GraphStatsPanel.vue'
import { fetchGraphOverview, searchGraph, type GraphEdge, type GraphNode, type GraphOverview } from '@/api/graph'

/**
 * 知识图谱 · 全景图谱页（二期工单 07）：左 nav / 中 搜索区+力导图 / 右 统计区。
 * 进入拉 overview 全图；检索走 /kg/search 命中子图（实体+关联边+文档直连边）；
 * 画布边数为前端动态值；点击文档节点跳转文档预览。
 * 12 号工单：力导图 option 抽取为共享 GraphCanvas 组件（ai-qa 时间线图谱卡共用）。
 */
const router = useRouter()

// —— 状态 ——
const loading = ref(false)
const searching = ref(false)
const keyword = ref('')
const type = ref('')

const overview = ref<GraphOverview | null>(null)
const canvasNodes = ref<GraphNode[]>([])
const canvasEdges = ref<GraphEdge[]>([])
const canvasEdgeCount = computed(() => canvasEdges.value.length)

const chartRef = ref<InstanceType<typeof GraphCanvas>>()
const zoom = ref(1)

// —— 数据加载 ——
async function loadOverview(): Promise<void> {
  loading.value = true
  try {
    const data = await fetchGraphOverview()
    overview.value = data
    canvasNodes.value = data.nodes
    canvasEdges.value = data.edges
    if (data.truncated) ElMessage.warning(`节点数超出上限，已按提及数截断（当前 ${data.nodes.length} 个）`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '图谱加载失败')
  } finally {
    loading.value = false
  }
}

async function onSearch(): Promise<void> {
  const q = keyword.value.trim()
  if (!q) {
    ElMessage.warning('请输入检索关键词')
    return
  }
  searching.value = true
  try {
    const res = await searchGraph({ q, type: (type.value || undefined) as undefined, pageSize: 50 })
    const nodes: GraphNode[] = res.entities.map((e) => ({
      id: `entity:${e.type}:${e.name}`,
      kind: 'entity',
      name: e.name,
      entityType: e.type as GraphNode['entityType'],
      description: e.description,
    }))
    // type=document：图侧为空，用 ES 命中文档画孤立文档节点
    if (type.value === 'document') {
      for (const it of res.docs.items ?? []) {
        if (it.doc_id && !nodes.some((n) => n.id === `document:${it.doc_id}`)) {
          nodes.push({ id: `document:${it.doc_id}`, kind: 'document', name: it.title ?? it.doc_id, docId: it.doc_id })
        }
      }
    }
    const docIds = new Set<string>()
    for (const de of res.docEdges) {
      if (!docIds.has(de.docId)) {
        docIds.add(de.docId)
        nodes.push({ id: `document:${de.docId}`, kind: 'document', name: de.title, docId: de.docId })
      }
    }
    const edges: GraphEdge[] = res.edges.map((e) => ({
      source: `entity:${e.sourceType}:${e.sourceName}`,
      target: `entity:${e.targetType}:${e.targetName}`,
      kind: 'related',
      relation: e.relation,
    }))
    for (const de of res.docEdges) {
      edges.push({ source: `document:${de.docId}`, target: `entity:${de.entityType}:${de.entityName}`, kind: 'mentions' })
    }
    canvasNodes.value = nodes
    canvasEdges.value = edges
    zoom.value = 1
    if (!nodes.length) ElMessage.info('无匹配节点')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '检索失败')
  } finally {
    searching.value = false
  }
}

function onReset(): void {
  keyword.value = ''
  type.value = ''
  void loadOverview()
}

function onExport(): void {
  if (!canvasNodes.value.length) {
    ElMessage.warning('当前画布为空，无可导出数据')
    return
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    keyword: keyword.value.trim() || null,
    nodeCount: canvasNodes.value.length,
    edgeCount: canvasEdges.value.length,
    nodes: canvasNodes.value,
    edges: canvasEdges.value,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kg-graph-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('图谱数据已导出')
}

// —— 缩放控件（实例级 merge setOption，不触发力布局重排） ——
function applyZoom(next: number): void {
  zoom.value = next
  chartRef.value?.getInstance()?.setOption({ series: [{ zoom: next }] })
}

function zoomIn(): void {
  applyZoom(Math.min(4, Math.round(zoom.value * 1.25 * 100) / 100))
}

function zoomOut(): void {
  applyZoom(Math.max(0.3, Math.round((zoom.value / 1.25) * 100) / 100))
}

function zoomReset(): void {
  applyZoom(1)
}

// —— 文档节点点击 → 文档预览 ——
let clickBound = false

function bindGraphEvents(): void {
  const chart = chartRef.value?.getInstance()
  if (!chart || clickBound) return
  clickBound = true
  chart.on('click', (params: ECElementEvent) => {
    const data = params.data as { kind?: string; docId?: string } | undefined
    if (params.dataType === 'node' && data?.kind === 'document' && data.docId) {
      void router.push(`/documents/${data.docId}/preview`)
    }
  })
}

onMounted(async () => {
  await loadOverview()
  await nextTick()
  bindGraphEvents()
})
</script>

<template>
  <div class="kg-page">
    <!-- 左：知识图谱 nav -->
    <aside class="kg-aside">
      <div class="aside-label">知识图谱</div>
      <el-menu default-active="overview" class="aside-menu">
        <el-menu-item index="overview">
          <el-icon>
            <Share />
          </el-icon>
          <span>全景图谱</span>
        </el-menu-item>
      </el-menu>
    </aside>

    <!-- 中：搜索区 + 力导图 -->
    <main v-loading="loading" class="kg-main">
      <GraphSearchBar v-model:keyword="keyword" v-model:type="type" :searching="searching" @search="onSearch"
        @reset="onReset" @export="onExport" />

      <div class="canvas-wrap">
        <template v-if="canvasNodes.length">
          <GraphCanvas ref="chartRef" :nodes="canvasNodes" :edges="canvasEdges" :zoom="zoom" />
          <div class="zoom-ctl">
            <el-button size="small" @click="zoomIn">＋</el-button>
            <el-button size="small" @click="zoomOut">－</el-button>
            <el-button size="small" title="复位" @click="zoomReset">
              <el-icon>
                <Aim />
              </el-icon>
            </el-button>
          </div>
        </template>
        <el-empty v-else-if="!loading" description="无匹配节点" />
      </div>

      <div class="legend-bar">
        <span v-for="c in GRAPH_CATEGORIES" :key="c.name" class="legend-item">
          <span class="dot" :style="{ background: c.color }" />{{ c.name }}
        </span>
        <span class="legend-item"><span class="line mentions" />提及</span>
        <span class="legend-item"><span class="line related" />关联</span>
        <span class="legend-item muted"><span class="line note" />标注（预留）</span>
        <span class="legend-tip">可拖拽节点，滚轮缩放；点击文档节点打开正文</span>
      </div>
    </main>

    <!-- 右：统计区（独立滚动） -->
    <aside class="kg-right">
      <GraphStatsPanel
        :stats="overview?.stats ?? { docNodes: 0, entities: 0, relatedEdges: 0, mentionEdges: 0, tags: 0 }"
        :canvas-edge-count="canvasEdgeCount" :type-dist="overview?.typeDist ?? []"
        :hot-top5="overview?.hotTop5 ?? []" />
    </aside>
  </div>
</template>

<style scoped>
.kg-page {
  display: flex;
  align-items: stretch;
  gap: 12px;
  height: calc(100vh - 56px - 16px);
  padding: 8px 12px 12px 0;
}

.kg-aside {
  width: 180px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding-top: 8px;
}

.aside-label {
  padding: 8px 20px 6px;
  font-size: 13px;
  color: #909399;
}

.aside-menu {
  border-right: none;
}

.kg-main {
  flex: 1;
  min-width: 520px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: 12px;
}

.zoom-ctl {
  position: absolute;
  right: 16px;
  bottom: 48px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zoom-ctl .el-button {
  margin: 0;
  width: 36px;
  padding: 0;
}

.legend-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 8px 4px 0;
  font-size: 12px;
  color: #606266;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.legend-item.muted {
  color: #c0c4cc;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}

.line {
  width: 20px;
  height: 0;
  display: inline-block;
}

.line.mentions {
  border-top: 2px solid #3b82f6;
}

.line.related {
  border-top: 2px dashed #9ca3af;
}

.line.note {
  border-top: 2px dotted #8b5cf6;
}

.legend-tip {
  margin-left: auto;
  color: #909399;
}

.kg-right {
  width: 300px;
  flex-shrink: 0;
  overflow-y: auto;
}
</style>
