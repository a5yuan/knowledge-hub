<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  approveDocument,
  fetchDocument,
  fetchPendingReviews,
  fetchReviewHistory,
  rejectDocument,
  type DocumentWithOwner,
} from '@/api/documents'
import type { PendingReview, ReviewRecord } from '@/api/adapters/document'
import { DOC_STATUS_META } from './meta'
import MarkdownView from '@/components/markdown/MarkdownView.vue'

/**
 * 审核工作台（工单 03 核心新增）：后端已有能力的前端入口，无 Mock 演示数据。
 * - 待审队列为裸数组，前端客户端分页（默认 20/页）；软删文档 title=null 行隐藏并扣减计数
 * - 详情走 GET /document/:id：content 为 markdown，经 MarkdownView 渲染（ADR-0006）+ 原文件链接
 * - 动作成功后从队列移除该行并 invalidate 角标，不整表重拉（避免竞态）
 * - GET /auth/reviewer-ids 在此 UI 用不到：后端从 token 取审核人身份
 */

const queue = ref<PendingReview[]>([])
const loading = ref(false)
const selected = ref<PendingReview | null>(null)
const detail = ref<(DocumentWithOwner & { content?: string | null }) | null>(null)
const detailLoading = ref(false)
const history = ref<ReviewRecord[]>([])

const PAGE_SIZE = 20
const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(queue.value.length / PAGE_SIZE)))
const pageRows = computed(() => queue.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function loadQueue(): Promise<void> {
  loading.value = true
  try {
    // 软删文档 title=null（后端 LEFT JOIN 已知缺陷）：隐藏并扣减计数
    const rows = await fetchPendingReviews()
    queue.value = rows.filter((r) => r.title != null)
    if (page.value > totalPages.value) page.value = 1
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '待审队列加载失败')
  } finally {
    loading.value = false
  }
}

async function onSelect(row: PendingReview): Promise<void> {
  selected.value = row
  detailLoading.value = true
  detail.value = null
  history.value = []
  try {
    const [d, h] = await Promise.all([fetchDocument(row.documentId), fetchReviewHistory(row.documentId)])
    detail.value = d as DocumentWithOwner & { content?: string | null }
    history.value = h
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '文档详情加载失败')
  } finally {
    detailLoading.value = false
  }
}

/** 动作成功：从队列移除该行（不整表重拉，避免竞态）+ invalidate 角标 */
function removeFromQueue(reviewId: string): void {
  queue.value = queue.value.filter((r) => r.id !== reviewId)
  if (selected.value?.id === reviewId) {
    selected.value = null
    detail.value = null
    history.value = []
  }
  window.dispatchEvent(new CustomEvent('kh:pending-review-changed'))
}

async function onApprove(row: PendingReview): Promise<void> {
  const { value } = await ElMessageBox.prompt('审核意见（可选）', `通过「${row.title}」`, {
    inputPlaceholder: '通过可不填意见',
    confirmButtonText: '通过',
    cancelButtonText: '取消',
  }).catch(() => ({ value: undefined as string | undefined }))
  if (value === undefined) return // 取消
  try {
    await approveDocument(row.documentId, value.trim() || undefined)
    ElMessage.success(`已通过「${row.title}」`)
    removeFromQueue(row.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '审核通过失败')
  }
}

async function onReject(row: PendingReview): Promise<void> {
  const { value } = await ElMessageBox.prompt('驳回意见（必填）', `驳回「${row.title}」`, {
    inputPlaceholder: '请填写驳回原因',
    inputValidator: (v: string) => (v?.trim() ? true : '驳回意见不能为空'),
    confirmButtonText: '驳回',
    cancelButtonText: '取消',
  }).catch(() => ({ value: undefined as string | undefined }))
  if (value === undefined) return
  try {
    await rejectDocument(row.documentId, value.trim())
    ElMessage.success(`已驳回「${row.title}」`)
    removeFromQueue(row.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '驳回失败')
  }
}

const RESULT_META: Record<number, { label: string; tag: 'success' | 'danger' }> = {
  1: { label: '通过', tag: 'success' },
  2: { label: '驳回', tag: 'danger' },
}

onMounted(() => {
  void loadQueue()
})
</script>

<template>
  <div class="reviews-page">
    <div class="page-head">
      <h2 class="page-title">审核工作台</h2>
      <span class="head-note">数据来自真实后端（无 Mock 演示数据）</span>
    </div>

    <div class="reviews-body">
      <!-- 左：待审队列 -->
      <div class="queue-panel">
        <div class="panel-head">
          <span>待审队列</span>
          <span class="queue-count">{{ queue.length }} 篇</span>
        </div>
        <div v-loading="loading" class="queue-list">
          <div v-if="queue.length === 0 && !loading" class="queue-empty">
            <p>队列为空</p>
            <p class="empty-hint">若后端未开启审核（REVIEW_ENABLED=false），发布将直接生效，不会产生待审记录</p>
          </div>
          <div v-for="row in pageRows" :key="row.id" class="queue-item" :class="{ active: selected?.id === row.id }"
            @click="onSelect(row)">
            <div class="item-title" :title="row.title ?? ''">{{ row.title }}</div>
            <div class="item-meta">
              <el-tag size="small" effect="plain" type="warning">提审自「草稿」</el-tag>
              <span>{{ formatDateTime(row.createdAt) }}</span>
            </div>
            <div class="item-actions">
              <el-button size="small" type="primary" @click.stop="onApprove(row)">通过</el-button>
              <el-button size="small" type="danger" plain @click.stop="onReject(row)">驳回</el-button>
            </div>
          </div>
        </div>
        <el-pagination v-if="totalPages > 1" v-model:current-page="page" :total="queue.length" :page-size="PAGE_SIZE"
          layout="prev, pager, next" background class="queue-pager" />
      </div>

      <!-- 右：文档详情 -->
      <div v-loading="detailLoading" class="detail-panel">
        <template v-if="detail">
          <h3 class="detail-title">{{ detail.title }}</h3>
          <div class="detail-meta">
            <span>状态：{{ detail.docStatus !== undefined ? DOC_STATUS_META[detail.docStatus].label : '—' }}</span>
            <span>更新：{{ formatDateTime(detail.updatedAt) }}</span>
            <el-tag size="small" effect="plain">
              {{ detail.visibility === 'company' ? '公司可见' : '仅本人可见' }}
            </el-tag>
          </div>
          <div v-if="detail.fileUrl" class="detail-file">
            <a :href="detail.fileUrl" target="_blank" rel="noopener">打开原文件</a>
          </div>
          <!-- markdown 正文（ADR-0006：与预览页、编辑页同一渲染口径） -->
          <MarkdownView v-if="detail.content" :source="detail.content" class="detail-content" />
          <div v-else class="detail-content detail-empty">（无正文）</div>

          <div v-if="history.length > 0" class="history">
            <div class="history-head">审核历史</div>
            <div v-for="h in history" :key="h.id" class="history-item">
              <el-tag size="small" :type="h.reviewResult ? RESULT_META[h.reviewResult].tag : 'info'">
                {{ h.reviewResult ? RESULT_META[h.reviewResult].label : '待审' }}
              </el-tag>
              <span class="history-reviewer">{{ h.reviewerName ?? '—' }}</span>
              <span class="history-comment">{{ h.reviewComment ?? '' }}</span>
              <span class="history-time">{{ formatDateTime(h.reviewedAt ?? h.createdAt) }}</span>
            </div>
          </div>
        </template>
        <el-empty v-else-if="!detailLoading" description="从左侧选择待审文档" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.reviews-page {
  padding: 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.head-note {
  font-size: 12px;
  color: #909399;
}

.reviews-body {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.queue-panel {
  width: 380px;
  flex-shrink: 0;
  background: #fff;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  padding: 14px 16px;
  font-weight: 600;
  color: #303133;
  border-bottom: 1px solid #f0f2f5;
}

.queue-count {
  font-weight: 400;
  color: #909399;
}

.queue-list {
  flex: 1;
  overflow: auto;
  padding: 8px;
}

.queue-empty {
  text-align: center;
  color: #909399;
  padding: 48px 16px;
}

.empty-hint {
  font-size: 12px;
  color: #a8abb2;
  line-height: 1.6;
}

.queue-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
}

.queue-item:hover {
  background: #f5f7fa;
}

.queue-item.active {
  background: var(--el-color-primary-light-9);
}

.item-title {
  font-size: 14px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
}

.item-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

.queue-pager {
  padding: 10px;
  justify-content: center;
}

.detail-panel {
  flex: 1;
  background: #fff;
  border-radius: 6px;
  padding: 20px;
  overflow: auto;
}

.detail-title {
  margin: 0 0 8px;
  font-size: 17px;
  color: #303133;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  color: #909399;
  margin-bottom: 12px;
}

.detail-file {
  margin-bottom: 12px;
}

.detail-file a {
  color: var(--el-color-primary);
  font-size: 13px;
}

.detail-content {
  margin: 0;
  padding: 16px;
  background: #fafafa;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  color: #303133;
  min-height: 200px;
}

.detail-empty {
  color: #909399;
}

.history {
  margin-top: 20px;
}

.history-head {
  font-weight: 600;
  color: #303133;
  margin-bottom: 10px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f5f7fa;
  font-size: 13px;
}

.history-reviewer {
  color: #303133;
}

.history-comment {
  color: #606266;
  flex: 1;
}

.history-time {
  color: #909399;
  font-size: 12px;
}
</style>
