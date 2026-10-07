<script setup lang="ts">
import { Download, Search } from '@element-plus/icons-vue'

/**
 * 全景图谱搜索区（二期工单 07）：关键词 + 节点类型 + 日期范围（禁用，后端缺口）+ 检索/重置/导出。
 * 复刻原型：第一行 筛选条件，第二行 检索（左）+ 导出图谱（右）。
 */
const keyword = defineModel<string>('keyword', { required: true })
const type = defineModel<string>('type', { default: '' })
defineProps<{ searching: boolean }>()

const emit = defineEmits<{ search: []; reset: []; export: [] }>()

const TYPE_OPTIONS = [
  { value: '', label: '节点类型' },
  { value: 'person', label: '人物' },
  { value: 'org', label: '组织' },
  { value: 'knowledge', label: '知识点' },
  { value: 'document', label: '文档' },
]

const DATE_GAP_TIP = 'Neo4j 节点无时间属性，日期筛选待后端支持'
</script>

<template>
  <div class="search-panel">
    <div class="row">
      <el-input v-model="keyword" placeholder="搜索实体、文档" clearable class="kw" :prefix-icon="Search"
        @keyup.enter="emit('search')" />
      <el-select v-model="type" class="type-sel">
        <el-option v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
      </el-select>
      <el-tooltip :content="DATE_GAP_TIP" placement="top">
        <el-date-picker type="date" placeholder="开始日期" disabled class="date" />
      </el-tooltip>
      <span class="date-sep">→</span>
      <el-tooltip :content="DATE_GAP_TIP" placement="top">
        <el-date-picker type="date" placeholder="结束日期" disabled class="date" />
      </el-tooltip>
      <el-button @click="emit('reset')">重 置</el-button>
    </div>
    <div class="row second">
      <el-button type="primary" :loading="searching" @click="emit('search')">检 索</el-button>
      <div class="spacer" />
      <el-button @click="emit('export')">
        <el-icon class="btn-icon"><Download /></el-icon>
        导出图谱
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.kw {
  width: 260px;
}

.type-sel {
  width: 140px;
}

.date {
  width: 150px;
}

.date-sep {
  color: #909399;
}

.second {
  margin-top: 2px;
}

.spacer {
  flex: 1;
}

.btn-icon {
  margin-right: 4px;
}
</style>
