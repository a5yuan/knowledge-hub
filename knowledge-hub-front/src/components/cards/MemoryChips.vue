<script setup lang="ts">
/**
 * 命中的记忆要点（catalog: memoryChips）。
 *
 * 只展示「这次回答参考了哪些记忆」，不提供编辑入口 —— 记忆管理在个人中心。
 */
defineProps<{
  memories: Array<{ layer: 'user' | 'session'; text: string }>
}>()

const LAYER_LABEL: Record<string, string> = { user: '长期', session: '本轮' }
</script>

<template>
  <div class="mc">
    <div class="mc-head">
      <el-tag size="small" type="warning" effect="light">记忆</el-tag>
      <span class="mc-count">{{ memories.length ? `命中 ${memories.length} 条` : '未命中记忆' }}</span>
    </div>

    <ul v-if="memories.length" class="mc-list">
      <li v-for="(m, i) in memories" :key="i" class="mc-chip">
        <span class="mc-layer">{{ LAYER_LABEL[m.layer] ?? m.layer }}</span>
        <span class="mc-text">{{ m.text }}</span>
      </li>
    </ul>

    <p v-else class="mc-empty">本轮未使用记忆。</p>
  </div>
</template>

<style scoped>
.mc {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}

.mc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.mc-count {
  color: #303133;
}

.mc-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}

.mc-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mc-chip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  background: #fafafa;
  border: 1px solid #f5f5f5;
  border-radius: 6px;
  padding: 6px 10px;
}

.mc-layer {
  flex-shrink: 0;
  font-size: 11px;
  color: #b88230;
  background: #fdf6ec;
  border-radius: 4px;
  padding: 0 5px;
  line-height: 18px;
}

.mc-text {
  color: #606266;
  line-height: 1.6;
  min-width: 0;
  word-break: break-word;
}
</style>
