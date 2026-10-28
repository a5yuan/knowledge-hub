<script setup lang="ts">
/**
 * 联网搜索结果链接列表（catalog: webLinks）。
 *
 * 与 KnowledgeCards 同样只吃 props、不认识事件与请求 —— 换触发方式不用改本文件。
 */
withDefaults(
  defineProps<{
    /** 实际检索词（可能经过改写），让用户核对检索意图 */
    query?: string
    results: Array<{ title: string; url?: string }>
  }>(),
  { query: '' },
)
</script>

<template>
  <div class="wl">
    <div class="wl-head">
      <el-tag size="small" type="info" effect="light">联网</el-tag>
      <span class="wl-count">{{ results.length ? `检索到 ${results.length} 条结果` : '未检索到结果' }}</span>
      <span v-if="query" class="wl-query" :title="query">「{{ query }}」</span>
    </div>

    <p v-if="!results.length" class="wl-empty">未检索到相关网页。</p>

    <ul v-else class="wl-list">
      <li v-for="(r, i) in results" :key="i" class="wl-item">
        <a
          v-if="r.url"
          class="wl-title"
          :href="r.url"
          target="_blank"
          rel="noopener noreferrer"
          :title="r.title"
        >{{ r.title || '（无标题）' }}</a>
        <span v-else class="wl-title">{{ r.title || '（无标题）' }}</span>
        <span v-if="r.url" class="wl-url" :title="r.url">{{ r.url }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.wl {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}

.wl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}

.wl-count {
  color: #303133;
  flex-shrink: 0;
}

.wl-query {
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.wl-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}

.wl-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wl-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid #f5f5f5;
  border-radius: 6px;
  padding: 7px 10px;
  background: #fafafa;
}

.wl-item:hover {
  border-color: var(--el-color-primary-light-7);
}

.wl-title {
  font-size: 13px;
  color: var(--el-color-primary);
  font-weight: 500;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wl-title:hover {
  text-decoration: underline;
}

.wl-url {
  font-size: 11px;
  color: #a8abb2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
