<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { fetchDocument, updateDocument, type DocumentWithOwner } from '@/api/documents'
import { isRealResource, rawCall } from '@/api/endpoint'
import { EMPTY_DOC, type EditorJSON } from '@/components/editor/json'
import RichEditor from '@/components/editor/RichEditor.vue'
import MarkdownView from '@/components/markdown/MarkdownView.vue'
import type { Visibility } from '@/types/api'

/**
 * 在线文档编辑页（工单 06 / 工单 03 降级）：
 * - Mock 模式：仅 type=online 可编辑，标题/内容防抖自动保存（1.5s），beforeunload keepalive 兜底
 * - 真实模式：后端 UpdateDocumentDto 无正文字段（contentJson 被静默剥离 = 数据丢失），
 *   降级为只读预览 + 顶部告警条，仅标题可改（PATCH title）；正文按 markdown 渲染（ADR-0006）
 */
const route = useRoute()
const router = useRouter()

const realMode = computed(() => isRealResource('documents'))

const doc = ref<DocumentWithOwner | null>(null)
const title = ref('')
const content = ref<EditorJSON>(EMPTY_DOC)
/** 真实模式正文（Mongo markdown 纯文本，非 TipTap JSON） */
const contentText = ref('')

const SAVE_DEBOUNCE_MS = 1500
type SaveState = 'saved' | 'dirty' | 'saving'
const saveState = ref<SaveState>('saved')

let baseline = { title: '', json: '' }
let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false
let notifyFailure = true

function currentJson(): string {
  return JSON.stringify(content.value)
}

function isDirty(): boolean {
  // 真实模式正文不可改：仅标题参与脏判定
  if (realMode.value) return title.value !== baseline.title
  return title.value !== baseline.title || currentJson() !== baseline.json
}

function scheduleSave(): void {
  saveState.value = 'dirty'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS)
}

function onTitleInput(): void {
  if (!doc.value) return
  scheduleSave()
}

function onContentChange(json: EditorJSON): void {
  if (!doc.value || realMode.value) return
  content.value = json
  scheduleSave()
}

async function flushSave(): Promise<void> {
  if (!doc.value) return
  if (saving) {
    scheduleSave()
    return
  }
  if (!isDirty()) {
    saveState.value = 'saved'
    return
  }
  saving = true
  saveState.value = 'saving'
  try {
    // 真实模式仅保存标题（contentJson 会被后端静默剥离，工单 03 最严重单点风险）
    const payload = realMode.value
      ? { title: title.value }
      : { title: title.value, contentJson: content.value as Record<string, unknown> }
    const updated = await updateDocument(doc.value.id, payload)
    baseline = realMode.value
      ? { title: updated.title, json: baseline.json }
      : { title: updated.title, json: JSON.stringify(updated.contentJson ?? content.value) }
    doc.value = updated
    notifyFailure = true
    // 保存期间可能又有输入：仍脏则继续调度，否则落定为已保存
    if (isDirty()) scheduleSave()
    else saveState.value = 'saved'
  } catch {
    saveState.value = 'dirty'
    if (notifyFailure) {
      ElMessage.error('自动保存失败，将自动重试')
      notifyFailure = false
    }
    scheduleSave()
  } finally {
    saving = false
  }
}

/** 兜底：页面关闭/刷新时用 keepalive fetch 尽力保存，并让浏览器弹出离开确认。
 * rawCall 复用通道路径与鉴权决策；真实模式仅标题体 */
function flushKeepalive(): void {
  if (!doc.value) return
  const call = rawCall('documents', `/${doc.value.id}`)
  const body = realMode.value
    ? { title: title.value }
    : { title: title.value, contentJson: content.value }
  void fetch(call.url, {
    method: 'PATCH',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      ...(call.authHeader ? { Authorization: call.authHeader } : {}),
    },
    body: JSON.stringify(body),
  })
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!doc.value || !isDirty()) return
  flushKeepalive()
  event.preventDefault()
  event.returnValue = ''
}

// 站内路由离开：等待在途保存落盘（SPA 不卸载页面，PATCH 会正常完成）
onBeforeRouteLeave(async () => {
  if (!isDirty()) return true
  clearTimeout(saveTimer)
  await flushSave()
  return true
})

const SAVE_STATE_META: Record<SaveState, { label: string; cls: string }> = {
  saved: { label: '已保存', cls: 'saved' },
  saving: { label: '保存中…', cls: 'saving' },
  dirty: { label: '待自动保存', cls: 'dirty' },
}

const VISIBILITY_LABEL: Record<Visibility, string> = {
  company: '公司可见',
  department: '部门可见',
  private: '仅本人可见',
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  try {
    const loaded = await fetchDocument(route.params.id as string)
    if (realMode.value) {
      // 真实模式：正文为 markdown 纯文本，只读展示（不再按 type=online 拦截跳回，工单 03）
      doc.value = loaded
      title.value = loaded.title
      contentText.value = (loaded as DocumentWithOwner & { content?: string | null }).content ?? '（无正文）'
      baseline = { title: loaded.title, json: '' }
      return
    }
    if (loaded.type !== 'online') {
      ElMessage.warning('上传文件仅支持预览与下载，不支持在线编辑')
      void router.replace('/documents')
      return
    }
    doc.value = loaded
    title.value = loaded.title
    content.value = (loaded.contentJson as EditorJSON | undefined) ?? EMPTY_DOC
    baseline = { title: loaded.title, json: currentJson() }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '文档加载失败')
    void router.replace('/documents')
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearTimeout(saveTimer)
})
</script>

<template>
  <div class="editor-page">
    <!-- 真实模式：后端 UpdateDocumentDto 无正文字段，正文只读（工单 03 不可逆降级项） -->
    <el-alert v-if="realMode" title="后端暂未提供正文写入接口：正文只读，仅标题可保存"
      type="warning" :closable="false" class="real-mode-alert" show-icon />
    <div class="editor-head">
      <div class="head-main">
        <el-input v-model="title" class="title-input" maxlength="80" placeholder="请输入文档标题"
          @input="onTitleInput" />
        <div class="meta-line">
          <span>{{ doc?.ownerName || '—' }}</span>
          <span>最近更新：{{ doc ? formatDateTime(doc.updatedAt) : '—' }}</span>
          <el-tag size="small" effect="plain">{{ doc ? VISIBILITY_LABEL[doc.visibility] : '—' }}</el-tag>
        </div>
      </div>
      <div v-if="!realMode" class="save-state" :class="SAVE_STATE_META[saveState].cls">
        <span class="state-dot" />
        {{ SAVE_STATE_META[saveState].label }}
      </div>
    </div>
    <RichEditor v-if="doc && !realMode" :model-value="content" @update:model-value="onContentChange" />
    <!-- 真实模式：markdown 只读渲染（ADR-0006，与预览页/审核工作台同源） -->
    <MarkdownView v-else-if="doc" :source="contentText" class="content-readonly" />
  </div>
</template>

<style scoped>
.real-mode-alert {
  margin-bottom: 12px;
}

/* 真实模式正文容器（内层排版由 MarkdownView 自持） */
.content-readonly {
  margin: 0;
  padding: 16px;
  background: #fafafa;
  border-radius: 4px;
  min-height: 200px;
}

.editor-page {
  background: #fff;
  border-radius: 6px;
  padding: 16px 20px;
  min-height: calc(100vh - 120px);
  max-width: 980px;
  margin: 0 auto;
}

.editor-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f2f5;
  margin-bottom: 16px;
}

.head-main {
  flex: 1;
  min-width: 0;
}

.title-input :deep(.el-input__wrapper) {
  box-shadow: none;
  padding-left: 0;
}

.title-input :deep(.el-input__inner) {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

.meta-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.save-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  flex-shrink: 0;
  padding-top: 8px;
}

.save-state.saved {
  color: #67c23a;
}

.save-state.saving {
  color: var(--el-color-primary);
}

.save-state.dirty {
  color: #909399;
}

.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
</style>
