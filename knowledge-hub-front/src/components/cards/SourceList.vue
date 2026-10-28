<script setup lang="ts">
/**
 * 引用来源列表（catalog: sourceList）。
 *
 * `index` 与正文里的 `[n]` 严格对应 —— 这是评测 agent-trace 判断「引用是否越界」的依据，
 * 不要在这里重排序或重新编号。
 */
defineProps<{
  sources: Array<{
    index: number
    kind: 'knowledge' | 'web' | 'graph'
    title: string
    ref?: string
    url?: string
    excerpt?: string
  }>
}>()

const KIND_LABEL: Record<string, string> = { knowledge: '知识库', web: 'Web', graph: '图谱' }
const KIND_TAG: Record<string, 'primary' | 'info' | 'warning'> = {
  knowledge: 'primary',
  web: 'info',
  graph: 'warning',
}
</script>

<template>
  <div class="sl">
    <div class="sl-head">
      <el-tag size="small" type="success" effect="light">来源</el-tag>
      <span class="sl-count">引用 {{ sources.length }} 处</span>
    </div>

    <ol v-if="sources.length" class="sl-list">
      <li v-for="s in sources" :key="s.index" class="sl-item" :title="s.excerpt || s.title">
        <span class="sl-idx">{{ s.index }}</span>
        <el-tag size="small" :type="KIND_TAG[s.kind] ?? 'info'" effect="plain">
          {{ KIND_LABEL[s.kind] ?? s.kind }}
        </el-tag>
        <a
          v-if="s.kind === 'web' && s.url"
          class="sl-title link"
          :href="s.url"
          target="_blank"
          rel="noopener noreferrer"
        >{{ s.title || '（无标题）' }}</a>
        <span v-else class="sl-title">{{ s.title || '（无标题）' }}</span>
      </li>
    </ol>

    <p v-else class="sl-empty">本轮回答未引用来源。</p>
  </div>
</template>

<style scoped>
.sl {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}

.sl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.sl-count {
  color: #303133;
}

.sl-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}

.sl-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sl-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}

.sl-idx {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 50%;
  background: #f0f2f5;
  color: #606266;
  font-size: 11px;
}

.sl-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #303133;
  min-width: 0;
}

.sl-title.link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.sl-title.link:hover {
  text-decoration: underline;
}
</style>
