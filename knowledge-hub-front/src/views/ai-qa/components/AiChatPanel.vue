<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChatDotRound, Delete, Promotion, Refresh } from '@element-plus/icons-vue'
import MarkdownView from '@/components/markdown/MarkdownView.vue'
import AiProcessTimeline from './AiProcessTimeline.vue'
import type { AiTimelineItem } from './AiProcessTimeline.vue'
import type { AiMessageView, AiSource } from '@/api/ai'

export type { AiTimelineItem }

/**
 * AI 问答右栏对话区（二期工单 08 v2）：Codex/Cursor 风格——
 * 可折叠执行过程时间线（按 data-xx 事件渲染独立卡片：意图识别/思考过程/检索/联网/记忆）
 * + 正文流式 markdown + 引用来源列表（index/excerpt）+ 推荐问题 + 输入区。
 * 纯展示组件：流式运行态由父组件编排（timeline/statusText/streamText）。
 */
const props = defineProps<{
  sessionTitle: string
  messages: AiMessageView[]
  streaming: boolean
  /** 执行过程时间线条目（plan/reasoning/retrieve/web/memory，按事件顺序） */
  timeline: AiTimelineItem[]
  /** 流式期间的过渡状态文本（data-status），流结束清除 */
  statusText: string
  streamText: string
  streamSources: AiSource[]
  streamError: string
  suggestions: string[]
}>()

const emit = defineEmits<{ send: [text: string]; clear: []; suggestion: [text: string]; stop: [] }>()

const input = ref('')
const suggestionOffset = ref(0)

const SUGGESTION_PAGE = 4

const visibleSuggestions = computed(() => {
  if (props.suggestions.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < Math.min(SUGGESTION_PAGE, props.suggestions.length); i++) {
    out.push(props.suggestions[(suggestionOffset.value + i) % props.suggestions.length])
  }
  return out
})

function rotateSuggestions(): void {
  suggestionOffset.value = (suggestionOffset.value + SUGGESTION_PAGE) % Math.max(1, props.suggestions.length)
}

function send(): void {
  const text = input.value.trim()
  if (!text || props.streaming) return
  input.value = ''
  emit('send', text)
}

function onKeydown(e: KeyboardEvent | Event): void {
  const evt = e as KeyboardEvent
  if (evt.key === 'Enter' && !evt.shiftKey) {
    evt.preventDefault()
    send()
  }
}

/** 有可展示的过程内容（流式中或已有条目） */
const hasProcess = computed(() => props.streaming || props.timeline.length > 0 || props.statusText !== '')

/** 最后一条 assistant 消息索引（完成态过程块挂在其气泡顶部，对齐 Codex UI） */
const lastAiIdx = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') return i
  }
  return -1
})

/** 文件类型图标色（按扩展名猜测，简化版引用卡片；12 号：graph 紫色对齐全景图谱标签色） */
function sourceIconColor(s: AiSource): string {
  if (s.kind === 'web') return '#6366f1'
  if (s.kind === 'graph') return '#8b5cf6'
  const ext = s.title.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return '#ef4444'
  if (['xlsx', 'xls'].includes(ext)) return '#22c55e'
  return '#3b82f6'
}

defineExpose({ input })
</script>

<template>
  <div class="chat-panel">
    <!-- 头部：会话标题 + 清空对话 -->
    <div class="panel-head">
      <span class="head-title">{{ sessionTitle || 'AI 问答' }}</span>
      <el-button size="small" :disabled="messages.length === 0 && !streaming" @click="emit('clear')">
        <el-icon class="btn-icon">
          <Delete />
        </el-icon>
        清空对话
      </el-button>
    </div>

    <!-- 消息流 -->
    <div class="msg-flow">
      <el-empty v-if="messages.length === 0 && !streaming" description="开始你的第一次提问吧" :image-size="80" />

      <template v-for="(m, i) in messages" :key="m.id">
        <!-- user 气泡 -->
        <div v-if="m.role === 'user'" class="row user-row">
          <div class="bubble user-bubble">{{ m.content }}</div>
          <div class="avatar user-avatar">我</div>
        </div>
        <!-- assistant 卡片 -->
        <div v-else class="row ai-row">
          <div class="avatar ai-avatar">
            <el-icon>
              <ChatDotRound />
            </el-icon>
          </div>
          <div class="bubble ai-bubble">
            <!-- 完成态过程时间线（回答上方，卡片可展开回看） -->
            <AiProcessTimeline v-if="!streaming && i === lastAiIdx && hasProcess" :streaming="false" :items="timeline"
              :status-text="statusText" />
            <MarkdownView :source="m.content || '（未生成内容）'" />
            <div v-if="m.sources && m.sources.length" class="source-box">
              <div class="source-title">引用来源（{{ m.sources.length }}）</div>
              <div class="source-list">
                <div v-for="s in m.sources" :key="s.index" class="source-item" :title="s.excerpt ?? s.title">
                  <span class="source-idx">{{ s.index }}</span>
                  <span class="source-ico" :style="{ background: sourceIconColor(s) }">{{ s.kind === 'web' ? 'W' :
                    s.kind === 'graph' ? 'G' : 'D'
                    }}</span>
                  <a v-if="s.kind === 'web' && s.url" class="source-name link" :href="s.url" target="_blank"
                    rel="noopener">{{ s.title }}</a>
                  <span v-else class="source-name">{{ s.title }}</span>
                  <el-tag size="small" effect="plain">{{ s.kind === 'web' ? 'Web' : s.kind === 'graph' ? '图谱' : '知识库'
                    }}</el-tag>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 流式进行中：时间线多卡片过程区 + 增量正文 -->
      <div v-if="streaming" class="row ai-row">
        <div class="avatar ai-avatar" :class="{ 'streaming-avatar': streaming }">
          <el-icon>
            <ChatDotRound />
          </el-icon>
        </div>
        <div class="bubble ai-bubble process-bubble">
          <AiProcessTimeline :streaming="true" :items="timeline" :status-text="statusText" />
          <MarkdownView v-if="streamText" :source="streamText" />
          <span v-if="!streamText && !hasProcess" class="thinking">正在思考…</span>
        </div>
      </div>
      <div v-if="streaming" class="flow-bottom-anchor" />
    </div>

    <!-- 推荐问题（有历史消息且非流式时显示） -->
    <div v-if="visibleSuggestions.length && !streaming" class="suggest-bar">
      <span class="suggest-label">你可能还想问</span>
      <button v-for="s in visibleSuggestions" :key="s" class="suggest-chip" @click="emit('suggestion', s)">
        {{ s }}
      </button>
      <button class="suggest-chip rotate" @click="rotateSuggestions">
        <el-icon>
          <Refresh />
        </el-icon>
        换一批
      </button>
    </div>

    <!-- 输入区 -->
    <div class="input-bar">
      <el-input v-model="input" type="textarea" :rows="2" resize="none" placeholder="请输入问题，Shift + Enter 换行"
        :disabled="streaming" @keydown="onKeydown" />
      <el-button v-if="!streaming" type="primary" class="send-btn" :disabled="!input.trim()" @click="send">
        <el-icon>
          <Promotion />
        </el-icon>
        发送
      </el-button>
      <el-button v-else type="warning" class="send-btn" @click="emit('stop')">停止</el-button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.head-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.btn-icon {
  margin-right: 4px;
}

.msg-flow {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.row {
  display: flex;
  gap: 10px;
}

.user-row {
  justify-content: flex-end;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
}

.user-avatar {
  background: var(--el-color-primary);
  font-size: 12px;
}

.ai-avatar {
  background: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}

.streaming-avatar {
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.5;
  }
}

.bubble {
  max-width: 82%;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.7;
}

.user-bubble {
  background: var(--el-color-primary-light-9);
  color: #303133;
  white-space: pre-wrap;
}

.ai-bubble {
  background: #fafafa;
  border: 1px solid #f0f0f0;
  flex: 1;
  min-width: 0;
}

.thinking {
  color: #909399;
  font-size: 13px;
}

.source-box {
  margin-top: 10px;
  padding: 10px;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
}

.source-title {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}

.source-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.source-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  font-size: 12px;
}

.source-idx {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: #f5f7fa;
  color: #606266;
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.source-ico {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.source-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #303133;
}

.source-name.link {
  color: var(--el-color-primary);
}

.flow-bottom-anchor {
  height: 1px;
}

.suggest-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.suggest-label {
  font-size: 13px;
  color: #303133;
  font-weight: 600;
  flex-shrink: 0;
}

.suggest-chip {
  border: 1px solid #e4e7ed;
  background: #fff;
  border-radius: 14px;
  padding: 4px 12px;
  font-size: 12px;
  color: #606266;
  cursor: pointer;
}

.suggest-chip:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
}

.suggest-chip.rotate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--el-color-primary);
}

.input-bar {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid #f0f0f0;
}

.send-btn {
  height: 52px;
}
</style>
