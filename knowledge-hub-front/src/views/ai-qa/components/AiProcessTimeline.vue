<script lang="ts">
/** 时间线条目（按 data-xx 事件一对一渲染：意图识别 / 思考过程 / 知识库检索 / 联网搜索 / 知识图谱 / 记忆回忆） */
export type AiTimelineItem =
  | { kind: 'plan'; intent: string; suggestedTerms: string[] }
  | { kind: 'reasoning'; text: string; done: boolean; collapsed: boolean }
  | {
    kind: 'retrieve'
    query: string
    items: Array<{ title: string; excerpt?: string }>
    done: boolean
    collapsed: boolean
  }
  | { kind: 'web'; query: string; results: Array<{ title: string; url?: string }>; done: boolean; collapsed: boolean }
  | {
    kind: 'graph'
    query: string
    entities: Array<{ name: string; type: string; description?: string }>
    relations: Array<{ source: string; relation: string; target: string }>
    done: boolean
    collapsed: boolean
  }
  | { kind: 'memory'; memories: Array<{ layer: 'user' | 'session'; text: string }>; done: boolean; collapsed: boolean }

export default {}
</script>

<script setup lang="ts">
/**
 * Codex 风格执行过程时间线：左侧圆点连接线，每个 data-xx 事件一张独立卡片。
 * 意图识别卡（建议检索词/范围）· 思考过程卡（可多段）· 知识库/联网/记忆卡（计数 + 可展开列表）
 * · 图谱卡（12 号：mini ECharts 力导图 + 实体关系列表）。
 * data-status 过渡状态仅流式期间在末尾显示一行，流结束消失。
 */
import { Loading } from '@element-plus/icons-vue'
import GraphCanvas from '@/components/charts/GraphCanvas.vue'
import type { GraphEdge, GraphNode } from '@/api/graph'

/** 图谱事件数据 → mini 力导图节点（12 号工单；source/target 用实体名匹配） */
function graphNodesOf(entities: Array<{ name: string; type: string; description?: string }>): GraphNode[] {
  return entities.map((e) => ({
    id: e.name,
    kind: 'entity',
    name: e.name,
    entityType: e.type as GraphNode['entityType'],
    description: e.description ?? null,
  }))
}

/** 图谱事件关系 → mini 力导图边 */
function graphEdgesOf(relations: Array<{ source: string; relation: string; target: string }>): GraphEdge[] {
  return relations.map((r) => ({ source: r.source, target: r.target, kind: 'related', relation: r.relation }))
}

const props = defineProps<{
  streaming: boolean
  items: AiTimelineItem[]
  /** 流式期间的过渡状态文本（data-status），空=不显示 */
  statusText: string
}>()

/** 意图 → 动作标题（意图识别卡头部） */
const ACTION_LABELS: Record<string, string> = {
  chitchat: '直接回答',
  preference: '直接回答',
  knowledge: '知识库检索',
  web: '联网搜索',
  knowledge_then_web: '知识库检索 + 联网搜索',
}

const PLAN_TAG_TIPS: Record<string, string> = {
  chitchat: '闲聊寒暄，无需检索',
  preference: '个人偏好，直接回答',
}

function actionLabel(intent: string): string {
  return ACTION_LABELS[intent] ?? '知识库检索'
}

/** 范围 chips：意图通道高亮（知识库 / 联网） */
function channelOn(item: Extract<AiTimelineItem, { kind: 'plan' }>, channel: 'kb' | 'web'): boolean {
  if (channel === 'kb') return item.intent === 'knowledge' || item.intent === 'knowledge_then_web'
  return item.intent === 'web' || item.intent === 'knowledge_then_web'
}

function isLast(i: number): boolean {
  return i === props.items.length - 1
}

function toggle(item: AiTimelineItem): void {
  if (item.kind === 'plan') return
  item.collapsed = !item.collapsed
}
</script>

<template>
  <div class="tl">
    <div v-for="(item, i) in items" :key="i" class="tl-row">
      <div class="tl-rail">
        <span class="dot" :class="{ active: streaming && isLast(i) }" />
      </div>
      <div class="tl-card">
        <!-- 意图识别卡（data-plan）：建议检索词 + 范围 -->
        <template v-if="item.kind === 'plan'">
          <div class="card-head">
            <el-tag size="small" type="primary" effect="plain">意图识别</el-tag>
            <span class="head-title">{{ actionLabel(item.intent) }}</span>
          </div>
          <div class="card-body">
            <div class="kv">
              <span class="kv-label">建议检索词</span>
              <span class="kv-value">{{ item.suggestedTerms.join('、') || '—' }}</span>
            </div>
            <div class="kv">
              <span class="kv-label">范围</span>
              <span class="kv-value scope">
                <el-tag v-if="channelOn(item, 'kb')" size="small" type="primary" effect="light">知识库</el-tag>
                <span v-else class="scope-off">知识库</span>
                <el-tag v-if="channelOn(item, 'web')" size="small" type="primary" effect="light">联网</el-tag>
                <span v-else class="scope-off">联网</span>
                <span v-if="PLAN_TAG_TIPS[item.intent]" class="scope-tip">{{ PLAN_TAG_TIPS[item.intent] }}</span>
              </span>
            </div>
          </div>
        </template>

        <!-- 思考过程卡（reasoning-*）：可多段，展开看全文 -->
        <template v-else-if="item.kind === 'reasoning'">
          <div class="card-head toggle" @click="toggle(item)">
            <span class="head-label">思考过程</span>
            <span class="head-state" :class="{ done: item.done }">{{ item.done ? '已完成' : '思考中…' }}</span>
            <span class="fold-arrow">{{ item.collapsed ? '⌄' : '⌃' }}</span>
          </div>
          <div v-show="!item.collapsed" class="card-body">
            <div class="reasoning-text">{{ item.text }}</div>
          </div>
        </template>

        <!-- 知识库卡（data-retrieve） -->
        <template v-else-if="item.kind === 'retrieve'">
          <div class="card-head toggle" @click="toggle(item)">
            <el-tag size="small" type="primary" effect="light">知识库</el-tag>
            <span class="head-text">{{ item.done ? (item.items.length ? '已检索知识库文档' : '知识库中未检索到相关文档') : '正在检索知识库…'
              }}</span>
            <span v-if="item.items.length" class="head-count">{{ item.items.length }}</span>
            <span class="fold-arrow">{{ item.collapsed ? '⌄' : '⌃' }}</span>
          </div>
          <div v-show="!item.collapsed" class="card-body">
            <ol class="result-list">
              <li v-for="(it, j) in item.items" :key="j" :title="it.excerpt ?? it.title">{{ it.title }}</li>
            </ol>
          </div>
        </template>

        <!-- 联网卡（data-web-search） -->
        <template v-else-if="item.kind === 'web'">
          <div class="card-head toggle" @click="toggle(item)">
            <el-tag size="small" type="success" effect="light">联网</el-tag>
            <span class="head-text">{{ item.done ? (item.results.length ? '已搜索公开信息' : '未搜索到公开信息') : '正在搜索公开信息…'
            }}</span>
            <span v-if="item.results.length" class="head-count">{{ item.results.length }}</span>
            <span class="fold-arrow">{{ item.collapsed ? '⌄' : '⌃' }}</span>
          </div>
          <div v-show="!item.collapsed" class="card-body">
            <ol class="result-list">
              <li v-for="(r, j) in item.results" :key="j">
                <a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{ r.title }}</a>
                <span v-else>{{ r.title }}</span>
              </li>
            </ol>
          </div>
        </template>

        <!-- 图谱卡（data-graph，12 号工单）：mini 力导图 + 实体/关系列表 -->
        <template v-else-if="item.kind === 'graph'">
          <div class="card-head toggle" @click="toggle(item)">
            <el-tag size="small" effect="light" class="graph-tag">图谱</el-tag>
            <span class="head-text">{{ item.done ? (item.relations.length ? '已检索知识图谱' : '未检索到相关图谱') : '正在检索知识图谱…'
            }}</span>
            <span v-if="item.relations.length" class="head-count">{{ item.relations.length }}</span>
            <span class="fold-arrow">{{ item.collapsed ? '⌄' : '⌃' }}</span>
          </div>
          <div v-show="!item.collapsed" class="card-body graph-body">
            <GraphCanvas v-if="item.entities.length" class="graph-mini" :nodes="graphNodesOf(item.entities)"
              :edges="graphEdgesOf(item.relations)" :height="230" mini />
            <ol v-if="item.relations.length" class="result-list graph-rels">
              <li v-for="(r, j) in item.relations" :key="j">
                {{ r.source }} <span class="rel-word">{{ r.relation }}</span> {{ r.target }}
              </li>
            </ol>
            <p v-else class="graph-empty">图谱中未命中相关实体关系，可展开文档检索结果查看。</p>
          </div>
        </template>

        <!-- 记忆卡（data-memory） -->
        <template v-else>
          <div class="card-head toggle" @click="toggle(item)">
            <el-tag size="small" type="warning" effect="light">记忆</el-tag>
            <span class="head-text">{{ item.done ? `已回忆 ${item.memories.length} 条记忆` : '正在回忆相关记忆…' }}</span>
            <span v-if="item.memories.length" class="head-count">{{ item.memories.length }}</span>
            <span class="fold-arrow">{{ item.collapsed ? '⌄' : '⌃' }}</span>
          </div>
          <div v-show="!item.collapsed" class="card-body">
            <ol class="result-list">
              <li v-for="(m, j) in item.memories" :key="j">{{ m.layer === 'user' ? '长期' : '会话' }} · {{ m.text }}</li>
            </ol>
          </div>
        </template>
      </div>
    </div>

    <!-- 状态行（data-status）：仅流式期间显示 -->
    <div v-if="streaming && statusText" class="tl-row">
      <div class="tl-rail">
        <span class="dot active" />
      </div>
      <div class="tl-status">
        <el-icon class="tool-spin">
          <Loading />
        </el-icon>
        <span>{{ statusText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
}

.tl-row {
  display: flex;
  gap: 10px;
  position: relative;
  padding-bottom: 8px;
}

/* 左侧圆点 + 连接线 */
.tl-rail {
  width: 10px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 14px;
}

.tl-rail::after {
  content: '';
  position: absolute;
  top: 22px;
  bottom: 0;
  width: 1px;
  background: #e4e7ed;
}

.tl-row:last-child .tl-rail::after {
  display: none;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid #c0c4cc;
  background: #fff;
  position: relative;
  z-index: 1;
}

.dot.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary);
  animation: dot-pulse 1.2s ease-in-out infinite;
}

@keyframes dot-pulse {

  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.35);
  }

  50% {
    box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.15);
  }
}

/* 卡片 */
.tl-card {
  flex: 1;
  min-width: 0;
  background: #fff;
  border: 1px solid #ececec;
  border-radius: 8px;
  overflow: hidden;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  min-height: 34px;
  box-sizing: border-box;
}

.card-head.toggle {
  cursor: pointer;
  user-select: none;
}

.card-head.toggle:hover {
  background: #fafafa;
}

.head-title {
  font-weight: 600;
  color: #303133;
}

.head-label {
  color: #909399;
}

.head-state {
  font-weight: 600;
  color: #303133;
}

.head-state:not(.done) {
  color: var(--el-color-primary);
  font-weight: 400;
}

.head-text {
  color: #303133;
}

.head-count {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}

/* 无计数时箭头推到最右；有计数时紧随计数 */
.fold-arrow {
  margin-left: auto;
  color: #909399;
  font-size: 12px;
}

.head-count+.fold-arrow {
  margin-left: 4px;
}

.card-body {
  padding: 0 12px 10px;
  border-top: 1px solid #f5f5f5;
  padding-top: 8px;
}

.kv {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}

.kv:last-child {
  margin-bottom: 0;
}

.kv-label {
  color: #909399;
  flex-shrink: 0;
  width: 62px;
}

.kv-value {
  color: #303133;
}

.scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.scope-off {
  color: #c0c4cc;
}

.scope-tip {
  color: #909399;
}

.reasoning-text {
  font-size: 12px;
  color: #71717a;
  white-space: pre-wrap;
  font-style: italic;
  max-height: 160px;
  overflow-y: auto;
}

.result-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: #606266;
}

.result-list li {
  margin-bottom: 2px;
}

.result-list a {
  color: var(--el-color-primary);
  text-decoration: none;
}

.result-list a:hover {
  text-decoration: underline;
}

/* 图谱卡（12 号工单） */
.graph-tag {
  color: #8b5cf6;
  background: #f5f3ff;
  border-color: #ddd6fe;
}

.graph-mini {
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  background: #fafafa;
}

.graph-rels {
  margin-top: 8px;
}

.rel-word {
  color: #8b5cf6;
  font-weight: 600;
}

.graph-empty {
  margin: 0;
  font-size: 12px;
  color: #909399;
}

/* 状态行 */
.tl-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #606266;
  padding-top: 5px;
}

.tool-spin {
  animation: spin 1s linear infinite;
  color: var(--el-color-primary);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
