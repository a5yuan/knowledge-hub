<script setup lang="ts">
import { ArrowDown, Plus, Refresh } from '@element-plus/icons-vue'
import type { AiSessionView } from '@/api/ai'

/**
 * AI 问答中栏：会话列表（标题 + 摘要副标题 + 时间），复刻原型图。
 * 新建对话 = emit('create')（父组件清空当前选中态，延迟到首条消息自动建会话）。
 */
defineProps<{
  sessions: AiSessionView[]
  activeId: string | null
  loading: boolean
}>()

const emit = defineEmits<{ select: [id: string]; create: [] }>()

function formatTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
</script>

<template>
  <div class="session-list">
    <div class="panel-head">
      <span class="panel-title">会话列表</span>
      <el-icon class="panel-icon"><Refresh /></el-icon>
    </div>
    <el-button class="create-btn" @click="emit('create')">
      <el-icon><Plus /></el-icon>
      新建对话
    </el-button>

    <div v-loading="loading" class="list-body">
      <div v-for="s in sessions" :key="s.id" class="session-item" :class="{ active: s.id === activeId }"
        @click="emit('select', s.id)">
        <div class="item-top">
          <span class="item-title">{{ s.title }}</span>
          <span class="item-time">{{ formatTime(s.updatedAt) }}</span>
        </div>
        <div class="item-preview">{{ s.preview || 'AI 会话' }}</div>
      </div>
      <el-empty v-if="!loading && sessions.length === 0" description="暂无会话" :image-size="60" />
    </div>

    <div v-if="sessions.length > 0" class="list-footer">
      <span class="more-link">查看更多会话</span>
      <el-icon class="more-arrow"><ArrowDown /></el-icon>
    </div>
  </div>
</template>

<style scoped>
.session-list {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.panel-icon {
  color: #909399;
  cursor: pointer;
}

.create-btn {
  width: 100%;
  margin-bottom: 12px;
}

.list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}

.session-item:hover {
  background: #f5f7fa;
}

.session-item.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
}

.item-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.session-item.active .item-title {
  color: var(--el-color-primary);
}

.item-time {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.item-preview {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-footer {
  padding: 10px 0 2px;
  text-align: center;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
</style>
