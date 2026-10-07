<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Download, Refresh } from '@element-plus/icons-vue'
import { fetchDocument, type DocumentDetail } from '@/api/documents'
import { EMPTY_DOC, type EditorJSON } from '@/components/editor/json'
import RichEditor from '@/components/editor/RichEditor.vue'
import MarkdownView from '@/components/markdown/MarkdownView.vue'
import { DOC_STATUS_META, PARSE_STATUS_META } from './meta'

/**
 * 文档预览页（工单 01 重写）。正文取哪一份，由解析状态与文件类型共同决定：
 *
 * | parse_state          | 正文区                                    |
 * | -------------------- | ----------------------------------------- |
 * | done + content 非空  | markdown 渲染（ADR-0006；pdf 可切「原文」） |
 * | pending / processing | 原格式视图（pdf 内嵌 / txt·md 原文 / 其余下载）|
 * | failed               | 原格式视图 + 失败原因横幅                   |
 * | 无状态               | 原格式视图                                 |
 *
 * 四条硬约束（bug 根因反写）：
 * 1. 正文必须取自 `DocumentDetail.content`（后端 Mongo 的 markdown），**不再读 `contentJson`** ——
 *    真实通道的适配层从不产出 `contentJson`，此前正文恒为空对象。
 * 2. 模板是**单一 if/else-if 链**，不再出现 `v-if` 接在 `v-else-if` 之后把一个文档渲染两遍。
 * 3. 取原文件一律校验 `res.ok` 与 `Content-Type` —— `/storage` 代理 403/404 或返回 SPA
 *    fallback 的 HTML 时若不校验，表现是**空白 iframe 且无任何报错**。
 * 4. 轮询**有界**（40 × 2.5s ≈ 100s）且带代际令牌：后端 `processParse` 是 fire-and-forget、
 *    无超时无重试，可能永久停在 running，前端必须把它体现为「已停止刷新 + 重新检查」而非无限转圈。
 */
const route = useRoute()
const router = useRouter()

const POLL_INTERVAL = 2500
const MAX_POLLS = 40

const doc = ref<DocumentDetail | null>(null)
const loading = ref(true)
/** 在线文档的 TipTap JSON（Mock 通道） */
const contentJson = ref<EditorJSON>(EMPTY_DOC)
/** 解析产物：后端 Mongo document_content.content */
const markdown = ref('')
const pdfSrc = ref<string>()
const pdfError = ref('')
const pdfLoading = ref(false)
const textSource = ref('')
const textError = ref('')
/** 解析态已显示 markdown 时，pdf 仍可切回原文（决议 #3 的原生内嵌能力不因解析完成而消失） */
const pdfOverride = ref(false)
const polling = ref(false)
const pollTimedOut = ref(false)

const isFile = computed(() => doc.value?.type === 'file')
const fileType = computed(() => doc.value?.fileType)
const parseStatus = computed(() => doc.value?.parseStatus)
const parseMeta = computed(() => (parseStatus.value ? PARSE_STATUS_META[parseStatus.value] : null))
const hasMarkdown = computed(() => markdown.value.trim().length > 0)
const transiting = computed(() => parseStatus.value === 'pending' || parseStatus.value === 'processing')

/** 解析完成且正文非空 → markdown；否则一律原格式（正文空而状态为 done 时不能显示空白） */
const showMarkdown = computed(() => parseStatus.value === 'done' && hasMarkdown.value)
const showPdf = computed(
  () => isFile.value && fileType.value === 'pdf' && (!showMarkdown.value || pdfOverride.value),
)
const showText = computed(
  () => isFile.value && !showMarkdown.value && (fileType.value === 'txt' || fileType.value === 'md'),
)
const showEditor = computed(() => doc.value?.type === 'online')

const docStatusLabel = computed(() => {
  const status = doc.value?.docStatus
  return status === undefined ? '' : DOC_STATUS_META[status].label
})

const statusHint = computed(() => {
  if (parseStatus.value === 'done') {
    return hasMarkdown.value ? '正文已按 markdown 渲染' : '解析完成，但未取得正文'
  }
  if (transiting.value) {
    return pollTimedOut.value
      ? '解析耗时已超出预期，已停止自动刷新'
      : '正在解析，完成后自动切换为 markdown 正文'
  }
  if (parseStatus.value === 'failed') return '正文解析失败，可下载原文件查看'
  return '暂无解析状态（列表响应不含解析状态，仅详情接口返回）'
})

const unsupportedHint = computed(() =>
  fileType.value
    ? `${fileType.value.toUpperCase()} 无法在浏览器中直接渲染，解析完成后可在线阅读；当前可下载查看`
    : '未能识别文件格式，解析完成后可在线阅读；当前可下载查看',
)

// ---------- 详情加载与有界轮询 ----------

/** 页面实例代际：路由切换 / 重新加载会自增，在途响应凭它判定是否过期 */
let loadSeq = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let polls = 0
const pollSeq = ref(0)

function stopPolling(): void {
  pollSeq.value += 1
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }
  polling.value = false
}

function schedulePoll(): void {
  if (polls >= MAX_POLLS) {
    polling.value = false
    pollTimedOut.value = true
    ElMessage.warning('解析耗时已超出预期，已停止自动刷新')
    return
  }
  polls += 1
  const seq = pollSeq.value
  pollTimer = setTimeout(() => void pollOnce(seq), POLL_INTERVAL)
}

function startPollingIfNeeded(): void {
  stopPolling()
  polls = 0
  pollTimedOut.value = false
  if (!transiting.value) return
  polling.value = true
  schedulePoll()
}

async function pollOnce(seq: number): Promise<void> {
  // 代际已在 stopPolling 里作废（卸载 / 切换文档）时，醒来直接退出，不再排下一次
  if (seq !== pollSeq.value) return
  try {
    await load({ silent: true })
  } catch {
    // 单次失败不终止轮询：解析中的偶发 5xx 不该让页面停在半途
  }
  if (seq !== pollSeq.value) return
  pollTimer = undefined
  if (!transiting.value) {
    polling.value = false
    return
  }
  schedulePoll()
}

function onLoadError(error: unknown): void {
  stopPolling()
  ElMessage.error(error instanceof Error ? error.message : '文档加载失败')
  void router.replace('/documents')
}

async function load(options: { silent?: boolean } = {}): Promise<void> {
  const run = (loadSeq += 1)
  const id = String(route.params.id ?? '')
  if (!options.silent) loading.value = true
  try {
    const loaded = await fetchDocument(id)
    if (run !== loadSeq) return
    doc.value = loaded
    markdown.value = loaded.content ?? ''
    contentJson.value = (loaded.contentJson as EditorJSON | undefined) ?? EMPTY_DOC
    void syncOriginal()
    if (!options.silent) startPollingIfNeeded()
  } finally {
    if (run === loadSeq) loading.value = false
  }
}

function onRecheck(): void {
  originalKey = '' // 连同原文件读取一并重试
  void load().catch(onLoadError)
}

// ---------- 原格式视图（pdf 内嵌 / txt·md 原文） ----------

/**
 * 已加载的原文件标识（文档 + 视图形态）。同一文档在 markdown 与原格式之间来回切换时不重复下载。
 * 每次写入前都校验它没被新请求顶掉，避免旧响应覆盖新文档的正文。
 */
let originalKey = ''

function revokePdf(): void {
  if (pdfSrc.value) {
    URL.revokeObjectURL(pdfSrc.value)
    pdfSrc.value = undefined
  }
}

async function syncOriginal(): Promise<void> {
  const key = [doc.value?.id, doc.value?.fileUrl, showPdf.value, showText.value].join('|')
  if (key === originalKey) return
  originalKey = key
  revokePdf()
  pdfError.value = ''
  textSource.value = ''
  textError.value = ''
  if (showPdf.value) await ensurePdfBlob(key)
  else if (showText.value) await ensureText(key)
}

/**
 * pdf → blob URL。iframe 首次导航不受 Service Worker 控制，直连 /storage 会被 SPA fallback 接管，
 * 故必须先 fetch 成 blob。校验两件事：`res.ok`（403/404）与 `Content-Type`（拿到 HTML 说明被 fallback 接管）。
 */
async function ensurePdfBlob(key: string): Promise<void> {
  const url = doc.value?.fileUrl
  if (!url) {
    pdfError.value = '该文档没有可用的原文件地址'
    return
  }
  pdfLoading.value = true
  try {
    const res = await fetch(url)
    if (key !== originalKey) return
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('pdf')) throw new Error(`返回的不是 PDF（Content-Type: ${type || '缺失'}）`)
    const blob = await res.blob()
    if (key !== originalKey) return
    pdfSrc.value = URL.createObjectURL(blob)
  } catch (error) {
    if (key !== originalKey) return
    pdfError.value = error instanceof Error ? error.message : '原文件获取失败'
  } finally {
    pdfLoading.value = false
  }
}

/** txt / md 解析完成前按原文展示（此前被误判为「不支持预览」而只能下载） */
async function ensureText(key: string): Promise<void> {
  const url = doc.value?.fileUrl
  if (!url) {
    textError.value = '该文档没有可用的原文件地址'
    return
  }
  try {
    const res = await fetch(url)
    if (key !== originalKey) return
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (key !== originalKey) return
    textSource.value = text
  } catch (error) {
    if (key !== originalKey) return
    textError.value = error instanceof Error ? error.message : '原文件读取失败'
  }
}

function onRetryOriginal(): void {
  originalKey = ''
  void syncOriginal()
}

// ---------- 其他动作 ----------

async function onDownload(): Promise<void> {
  const current = doc.value
  if (!current) return
  if (!current.fileUrl) {
    ElMessage.warning('该文档没有可用的原文件地址')
    return
  }
  // 下载要带扩展名：真实通道的 title 已被后端去掉后缀，必须用原始文件名
  const name = current.fileName?.trim() || current.title
  try {
    const res = await fetch(current.fileUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    // 同步 revoke 在部分浏览器会取消尚未开始的下载，放到下一轮事件循环
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (error) {
    ElMessage.error(`下载失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function goBack(): void {
  void router.push('/documents')
}

onMounted(() => {
  void load().catch(onLoadError)
})

// 预览页之间直接跳转（不同 id 复用同一组件实例）时，正文与原文件都要重新取
watch(
  () => route.params.id,
  () => {
    stopPolling()
    pdfOverride.value = false
    originalKey = ''
    doc.value = null
    markdown.value = ''
    revokePdf()
    void load().catch(onLoadError)
  },
)

// 视图形态变化（解析完成切 markdown、pdf 切原文）时同步原文件
watch([showPdf, showText], () => void syncOriginal())

onBeforeUnmount(() => {
  stopPolling()
  loadSeq += 1
  revokePdf()
})
</script>

<template>
  <div class="preview-page">
    <div class="preview-head">
      <el-button :icon="ArrowLeft" circle title="返回列表" @click="goBack" />
      <div class="head-info">
        <span class="doc-title" :title="doc?.title">{{ doc?.title ?? '加载中…' }}</span>
        <span class="doc-meta">{{ doc?.ownerName || '—' }}</span>
      </div>
      <el-button v-if="isFile" :icon="Download" @click="onDownload">下载</el-button>
    </div>

    <!-- 状态条：解析状态只在文件文档上成立（在线文档无解析管道） -->
    <div v-if="doc && isFile" class="status-bar">
      <el-tag v-if="parseMeta" :type="parseMeta.tag" size="small" effect="dark">{{ parseMeta.label }}</el-tag>
      <el-tag v-else size="small" type="info" effect="plain">状态未知</el-tag>
      <span class="status-hint">{{ statusHint }}</span>
      <el-button v-if="pollTimedOut" link type="primary" :icon="Refresh" @click="onRecheck">重新检查</el-button>
      <span class="status-spacer" />
      <el-button v-if="showMarkdown && fileType === 'pdf'" link type="primary" @click="pdfOverride = !pdfOverride">
        {{ pdfOverride ? '返回解析正文' : '查看 PDF 原文' }}
      </el-button>
      <el-tag v-if="docStatusLabel" size="small" type="info" effect="plain">{{ docStatusLabel }}</el-tag>
    </div>

    <!-- 解析失败：把 parse_error 原文摊开（后端成功时写空串，故空串回落为统一文案） -->
    <el-alert
      v-if="doc && isFile && parseStatus === 'failed'"
      type="error"
      :closable="false"
      show-icon
      title="正文解析失败"
      class="parse-alert"
    >
      <template #default>{{ doc.parseError || '后端未提供失败原因' }}</template>
    </el-alert>

    <div v-loading="loading" class="preview-body-wrap">
      <!-- 1. 解析完成 → markdown 正文 -->
      <MarkdownView v-if="showMarkdown && !pdfOverride" :source="markdown" class="preview-body" />

      <!-- 2. pdf 原格式：浏览器原生内嵌（blob URL） -->
      <template v-else-if="showPdf">
        <el-alert
          v-if="pdfError"
          type="error"
          :closable="false"
          show-icon
          :title="`原文件无法预览：${pdfError}`"
          class="parse-alert"
        >
          <template #default>
            <el-button link type="primary" :icon="Refresh" @click="onRetryOriginal">重试</el-button>
          </template>
        </el-alert>
        <iframe v-else-if="pdfSrc" :src="pdfSrc" class="pdf-frame" title="PDF 预览" />
        <div v-else v-loading="pdfLoading" class="pdf-placeholder" />
      </template>

      <!-- 3. txt / md 原格式：解析完成前按原文展示 -->
      <template v-else-if="showText">
        <el-alert
          v-if="textError"
          type="error"
          :closable="false"
          show-icon
          :title="`原文件读取失败：${textError}`"
          class="parse-alert"
        >
          <template #default>
            <el-button link type="primary" :icon="Refresh" @click="onRetryOriginal">重试</el-button>
          </template>
        </el-alert>
        <pre v-else class="text-source">{{ textSource || '（读取中…）' }}</pre>
      </template>

      <!-- 4. 在线文档：只读渲染（Mock 通道） -->
      <RichEditor v-else-if="showEditor" :model-value="contentJson" :editable="false" class="readonly-editor" />

      <!-- 5. office / 未知格式：解析完成前浏览器无渲染能力，只能下载 -->
      <el-empty v-else-if="doc" :description="unsupportedHint" class="unsupported">
        <el-button type="primary" :icon="Download" @click="onDownload">下载查看</el-button>
      </el-empty>
    </div>
  </div>
</template>

<style scoped>
.preview-page {
  background: #fff;
  border-radius: 6px;
  padding: 16px 20px;
  min-height: calc(100vh - 120px);
  max-width: 1080px;
  margin: 0 auto;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f2f5;
  margin-bottom: 16px;
}

.head-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.doc-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-meta {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #fafafa;
  border: 1px solid #f0f2f5;
  border-radius: 4px;
}

.status-hint {
  font-size: 12px;
  color: #606266;
}

.status-spacer {
  flex: 1;
}

.parse-alert {
  margin-bottom: 12px;
}

.pdf-frame {
  width: 100%;
  height: calc(100vh - 260px);
  border: 1px solid #e4e7ed;
  border-radius: 4px;
}

.pdf-placeholder {
  min-height: calc(100vh - 260px);
}

.text-source {
  margin: 0;
  padding: 12px 14px;
  max-height: calc(100vh - 260px);
  overflow: auto;
  background: #fafafa;
  border: 1px solid #f0f2f5;
  border-radius: 4px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
  white-space: pre-wrap;
  word-break: break-word;
}

.readonly-editor {
  border: none;
}

.unsupported {
  padding: 60px 0;
}
</style>
