<script setup lang="ts">
/**
 * 知识库文档卡片列表（catalog: knowledgeCards）。
 *
 * 数据全员来自 surface 的 props，本组件不认识 Agent、不认识事件、不做任何请求——
 * 它只负责「给定 items 就画出来」。这正是把展示从事件里拆出去的收益：
 * 换一种触发方式（模型主动调用 / 定时生成 / 回放重建）都不用改这个文件。
 */
withDefaults(
  defineProps<{
    /** 检索词，用于让用户核对检索意图 */
    query?: string
    items: Array<{ documentId: string; documentTitle: string; excerpt?: string }>
  }>(),
  { query: '' },
)
</script>

<template>
  <div class="kc">
    <div class="kc-head">
      <el-tag size="small" type="primary" effect="light">知识库</el-tag>
      <span class="kc-count">{{ items.length ? `命中 ${items.length} 篇文档` : '未命中文档' }}</span>
      <span v-if="query" class="kc-query" :title="query">「{{ query }}」</span>
    </div>

    <p v-if="!items.length" class="kc-empty">知识库中未检索到相关文档。</p>

    <ul v-else class="kc-list">
      <li v-for="it in items" :key="it.documentId" class="kc-item">
        <div class="kc-name" :title="it.documentTitle">
          {{ it.documentTitle || '（无标题文档）' }}
        </div>
        <div v-if="it.excerpt" class="kc-excerpt">{{ it.excerpt }}</div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.kc {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}

.kc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}

.kc-count {
  color: #303133;
  flex-shrink: 0;
}

.kc-query {
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.kc-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}

.kc-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kc-item {
  border: 1px solid #f5f5f5;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fafafa;
}

.kc-item:hover {
  border-color: var(--el-color-primary-light-7);
}

.kc-name {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kc-excerpt {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #606266;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
