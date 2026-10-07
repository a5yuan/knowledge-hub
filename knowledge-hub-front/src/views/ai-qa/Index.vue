<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChatDotRound, Clock, Setting } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import AiSessionList from './components/AiSessionList.vue'
import AiChatPanel, { type AiTimelineItem } from './components/AiChatPanel.vue'
import {
  clearMessages,
  fetchMessages,
  fetchSessions,
  streamChat,
  type AiMessageView,
  type AiSessionView,
  type AiSource,
} from '@/api/ai'

/**
 * AI 智能问答页（二期工单 08）：左 nav / 中 会话列表 / 右 对话区（流式）。
 * 左栏入口：新建对话（清空选中态，首条消息自动建会话）/ 历史会话 / 问答记录（占位）/ 模型配置（随请求携带不落库）。
 * 流式经 api/ai.streamChat（手写 SSE 解析），失败降级不报错。
 */
type NavView = 'history' | 'records' | 'model'

const navItems = [
  { key: 'history', label: '历史会话', icon: Clock },
  { key: 'records', label: '问答记录', icon: ChatDotRound, disabled: true },
  { key: 'model', label: '模型配置', icon: Setting },
] as const

const navActive = ref<NavView>('history')

// —— 会话列表 ——
const sessions = ref<AiSessionView[]>([])
const sessionsLoading = ref(false)

async function refreshSessions(): Promise<void> {
  sessionsLoading.value = true
  try {
    const res = await fetchSessions()
    sessions.value = res.list
  } catch {
    ElMessage.warning('会话列表加载失败，请稍后刷新')
  } finally {
    sessionsLoading.value = false
  }
}

// —— 当前会话与消息 ——
const activeSessionId = ref<string | null>(null)
const activeTitle = computed(
  () => sessions.value.find((s) => s.id === activeSessionId.value)?.title ?? '新对话',
)
const messages = ref<AiMessageView[]>([])

async function onSelectSession(id: string): Promise<void> {
  if (streaming.value) return
  activeSessionId.value = id
  navActive.value = 'history'
  try {
    const res = await fetchMessages(id)
    messages.value = res.messages
    suggestions.value = []
    timeline.value = []
    statusText.value = ''
  } catch {
    ElMessage.warning('会话消息加载失败')
  }
}

function onCreate(): void {
  if (streaming.value) return
  activeSessionId.value = null
  messages.value = []
  suggestions.value = []
  timeline.value = []
  statusText.value = ''
  navActive.value = 'history'
}

async function onClear(): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await clearMessages(activeSessionId.value)
    messages.value = []
    suggestions.value = []
    timeline.value = []
    statusText.value = ''
    ElMessage.success('对话已清空')
    void refreshSessions()
  } catch {
    ElMessage.warning('清空失败，请稍后重试')
  }
}

// —— 模型配置（localStorage，随请求携带不落库） ——
const MODEL_KEY = 'kh_ai_model_config'
const modelConfig = ref({ model: 'qwen-plus', temperature: 0.3, enableThinking: false })

onMounted(() => {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    if (raw) modelConfig.value = JSON.parse(raw) as typeof modelConfig.value
  } catch {
    /* 配置损坏按默认 */
  }
  void refreshSessions()
})

function saveModelConfig(): void {
  localStorage.setItem(MODEL_KEY, JSON.stringify(modelConfig.value))
  ElMessage.success('模型配置已保存（本次会话生效）')
}

// —— 流式对话（v2 事件编排：时间线多卡片过程区） ——
const streaming = ref(false)
const streamText = ref('')
const timeline = ref<AiTimelineItem[]>([])
const statusText = ref('')
const streamSources = ref<AiSource[]>([])
const streamError = ref('')
const suggestions = ref<string[]>([])
let abortController: AbortController | null = null
/** 当前 reasoning 段（reasoning-start 新建、delta 追加、end 收口），无 id 映射必要 */
let activeReasoning: Extract<AiTimelineItem, { kind: 'reasoning' }> | null = null

const chatPanelRef = ref<InstanceType<typeof AiChatPanel>>()

async function onSend(text: string): Promise<void> {
  if (streaming.value) return
  streaming.value = true
  streamText.value = ''
  timeline.value = []
  statusText.value = ''
  activeReasoning = null
  streamSources.value = []
  streamError.value = ''
  // 乐观插入 user 消息
  messages.value.push({
    id: `local_user_${Date.now()}`,
    role: 'user',
    content: text,
    sources: null,
    createdAt: new Date().toISOString(),
  })

  abortController = new AbortController()
  try {
    await streamChat(
      {
        content: text,
        sessionId: activeSessionId.value ?? undefined,
        model: modelConfig.value.model,
        temperature: modelConfig.value.temperature,
        enableThinking: modelConfig.value.enableThinking,
      },
      {
        onSession: (d) => {
          if (!activeSessionId.value) activeSessionId.value = d.sessionId
        },
        onStatus: (d) => {
          statusText.value = d.text
        },
        onPlan: (d) => {
          timeline.value.push({ kind: 'plan', intent: d.intent, suggestedTerms: d.suggestedTerms })
          void nextTick(scrollBottom)
        },
        onRetrieve: (d) => {
          timeline.value.push({
            kind: 'retrieve',
            query: d.query,
            items: d.items.map((it) => ({ title: it.documentTitle, excerpt: it.excerpt })),
            done: true,
            collapsed: true,
          })
          void nextTick(scrollBottom)
        },
        onWebSearch: (d) => {
          timeline.value.push({ kind: 'web', query: d.query, results: d.results, done: true, collapsed: true })
          void nextTick(scrollBottom)
        },
        onGraph: (d) => {
          timeline.value.push({
            kind: 'graph',
            query: d.query,
            entities: d.entities,
            relations: d.relations,
            done: true,
            collapsed: true,
          })
          void nextTick(scrollBottom)
        },
        onMemory: (d) => {
          if (d.memories.length === 0) return
          timeline.value.push({ kind: 'memory', memories: d.memories, done: true, collapsed: true })
          void nextTick(scrollBottom)
        },
        onReasoningStart: () => {
          activeReasoning = { kind: 'reasoning', text: '', done: false, collapsed: false }
          timeline.value.push(activeReasoning)
          void nextTick(scrollBottom)
        },
        onReasoningDelta: (d) => {
          if (activeReasoning) activeReasoning.text += d.delta
          void nextTick(scrollBottom)
        },
        onReasoningEnd: () => {
          if (activeReasoning) {
            activeReasoning.done = true
            activeReasoning.collapsed = true
            activeReasoning = null
          }
        },
        onTextDelta: (d) => {
          streamText.value += d.delta
          void nextTick(scrollBottom)
        },
        onSources: (d) => {
          streamSources.value = d.sources
        },
        onFinish: (d) => {
          suggestions.value = d.suggestions ?? []
        },
        onError: (d) => {
          streamError.value = d.message
        },
      },
      abortController.signal,
    )
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      streamError.value = err instanceof Error ? err.message : '网络异常，请稍后重试'
    }
  } finally {
    // 流结束（含中断）：合并 assistant 消息到本地列表
    if (streamText.value || streamSources.value.length || streamError.value) {
      messages.value.push({
        id: `local_ai_${Date.now()}`,
        role: 'assistant',
        content: streamText.value || streamError.value,
        sources: streamSources.value.length ? streamSources.value : null,
        createdAt: new Date().toISOString(),
      })
    }
    streaming.value = false
    streamText.value = ''
    statusText.value = ''
    // 过程时间线保留完成态（卡片可展开回看），下次发送或切换会话时重置
    abortController = null
    void nextTick(scrollBottom)
    void refreshSessions()
  }
}

function onStop(): void {
  abortController?.abort()
}

/** 后端流结束后把服务端持久化的权威消息同步为本地（可选：直接刷新） */
function scrollBottom(): void {
  const flow = chatPanelRef.value?.$el?.querySelector?.('.msg-flow') as HTMLElement | null
  if (flow) flow.scrollTop = flow.scrollHeight
}

function onSuggestion(text: string): void {
  void onSend(text)
}

onBeforeUnmount(() => {
  abortController?.abort()
})
</script>

<template>
  <div class="aiqa-page">
    <!-- 左：AI问答 nav -->
    <aside class="aiqa-nav">
      <div class="nav-label">AI问答</div>
      <button class="nav-item create" @click="onCreate">
        <el-icon>
          <ChatDotRound />
        </el-icon>
        <span>新建对话</span>
      </button>
      <button v-for="item in navItems" :key="item.key" class="nav-item" :class="{ active: navActive === item.key }"
        :disabled="'disabled' in item ? item.disabled : false"
        @click="item.key !== 'records' && (navActive = item.key)">
        <el-icon>
          <component :is="item.icon" />
        </el-icon>
        <span>{{ item.label }}</span>
        <el-tag v-if="'disabled' in item && item.disabled" size="small" type="info" effect="plain">二期</el-tag>
      </button>
    </aside>

    <!-- 中：会话列表 -->
    <section class="aiqa-sessions">
      <AiSessionList :sessions="sessions" :active-id="activeSessionId" :loading="sessionsLoading"
        @select="onSelectSession" @create="onCreate" />
    </section>

    <!-- 右：对话区 / 问答记录占位 / 模型配置 -->
    <section class="aiqa-chat">
      <template v-if="navActive === 'history'">
        <AiChatPanel ref="chatPanelRef" :session-title="activeTitle" :messages="messages" :streaming="streaming"
          :timeline="timeline" :status-text="statusText" :stream-text="streamText" :stream-sources="streamSources"
          :stream-error="streamError" :suggestions="suggestions" @send="onSend" @clear="onClear"
          @suggestion="onSuggestion" @stop="onStop" />
      </template>

      <template v-else-if="navActive === 'records'">
        <div class="panel-card">
          <div class="panel-head">
            <span class="head-title">问答记录</span>
          </div>
          <el-empty description="跨会话问答记录检索建设中，可在历史会话中查看各会话内容" />
        </div>
      </template>

      <template v-else>
        <div class="panel-card">
          <div class="panel-head">
            <span class="head-title">模型配置</span>
          </div>
          <div class="model-form">
            <div class="form-item">
              <div class="form-label">对话模型</div>
              <el-select v-model="modelConfig.model" class="full">
                <el-option value="qwen-plus" label="qwen-plus（均衡）" />
                <el-option value="qwen-max" label="qwen-max（能力最强）" />
                <el-option value="qwen-turbo" label="qwen-turbo（最快）" />
              </el-select>
            </div>
            <div class="form-item">
              <div class="form-label">随机性 temperature：{{ modelConfig.temperature.toFixed(1) }}</div>
              <el-slider v-model="modelConfig.temperature" :min="0" :max="1" :step="0.1" />
            </div>
            <div class="form-item">
              <div class="form-label">深度思考（thinking）</div>
              <el-switch v-model="modelConfig.enableThinking" active-text="开启后模型逐字输出思考过程" />
            </div>
            <el-button type="primary" @click="saveModelConfig">保存配置</el-button>
            <p class="form-tip">配置保存在本机浏览器，随每次提问请求携带；多轮上下文窗口固定最近 10 轮。</p>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.aiqa-page {
  display: flex;
  align-items: stretch;
  gap: 12px;
  height: calc(100vh - 56px - 16px);
  padding: 8px 12px 12px 0;
}

.aiqa-nav {
  width: 180px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nav-label {
  padding: 0 10px 8px;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  color: #303133;
  cursor: pointer;
  text-align: left;
}

.nav-item:hover:not(:disabled) {
  background: #f5f7fa;
}

.nav-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.nav-item:disabled {
  color: #c0c4cc;
  cursor: not-allowed;
}

.aiqa-sessions {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 14px;
}

.aiqa-chat {
  flex: 1;
  min-width: 520px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 14px 16px;
}

.panel-card {
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

.model-form {
  padding: 16px 4px;
  max-width: 460px;
}

.form-item {
  margin-bottom: 20px;
}

.form-label {
  font-size: 13px;
  color: #606266;
  margin-bottom: 8px;
}

.full {
  width: 100%;
}

.form-tip {
  font-size: 12px;
  color: #909399;
  margin-top: 12px;
}
</style>
