<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Delete, Grid, List, Refresh } from '@element-plus/icons-vue'
import { fetchHotSearch, getSearchHistory, addSearchHistory, clearSearchHistory, search } from '@/api/search'
import { fetchCategories } from '@/api/categories'
import { isRealResource } from '@/api/endpoint'
import type { Category, FileType, SearchResultItem, Visibility } from '@/types/api'
import HighlightText from './components/HighlightText.vue'

/**
 * 智能搜索（工单 08 / 工单 04 对接降级）：
 * - 真实通道：ES 全文检索仅支持 q/page/pageSize（高级筛选面板禁用并标注），
 *   结果无分类/标签/权限/fileType——对应占位与标签显式隐藏，时间语义为发布时间
 * - Mock 通道：行为与 MVP 完全一致（含相关度排序与权限过滤）
 * - 搜索历史为 localStorage（spec §8）；热门搜索钉在 Mock 通道（后端无 /search/hot）
 * - 真实检索仅覆盖已发布文档（ES 索引仅 status=1），搜不到草稿属正确行为
 */
const router = useRouter()

const realMode = computed(() => isRealResource('search'))

const keyword = ref('')
const executedQuery = ref('') // 已执行的关键词（用于结果高亮）
const advancedVisible = ref(false)
const fileType = ref<FileType>()
const categoryId = ref<string>()
const visibility = ref<Visibility>()
const dateRange = ref<[string, string]>()

const loading = ref(false)
const list = ref<SearchResultItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const viewMode = ref<'list' | 'card'>('list')
const searched = ref(false) // 是否执行过搜索（区分初始引导态与空结果态）

const hot = ref<{ keyword: string; count: number }[]>([])
const history = ref<string[]>([])

const categories = ref<Category[]>([])

const FILE_TYPE_OPTIONS: { value: FileType; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'pptx', label: 'PPTX' },
  { value: 'md', label: 'MD' },
  { value: 'txt', label: 'TXT' },
]

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'private', label: '仅本人可见' },
  { value: 'department', label: '部门可见' },
  { value: 'company', label: '公司可见' },
]

const VISIBILITY_TAG: Record<Visibility, { label: string; type: 'info' | 'warning' | 'success' }> = {
  private: { label: '仅本人', type: 'info' },
  department: { label: '部门可见', type: 'warning' },
  company: { label: '公司可见', type: 'success' },
}

async function doSearch(): Promise<void> {
  const q = keyword.value.trim()
  if (!q) return
  loading.value = true
  try {
    const result = await search({
      q,
      page: page.value,
      pageSize: pageSize.value,
      fileType: fileType.value,
      categoryId: categoryId.value,
      visibility: visibility.value,
      dateFrom: dateRange.value?.[0],
      dateTo: dateRange.value?.[1],
    })
    list.value = result.list
    total.value = result.total
    executedQuery.value = q
    searched.value = true
    addSearchHistory(q)
    history.value = getSearchHistory()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '搜索失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

function onSearchClick(): void {
  page.value = 1
  void doSearch()
}

function onFilterSearch(): void {
  page.value = 1
  void doSearch()
}

function resetFilters(): void {
  fileType.value = undefined
  categoryId.value = undefined
  visibility.value = undefined
  dateRange.value = undefined
}

function onAdvancedToggle(): void {
  advancedVisible.value = !advancedVisible.value
}

function searchBy(keywordText: string): void {
  keyword.value = keywordText
  page.value = 1
  void doSearch()
}

function clearHistory(): void {
  clearSearchHistory()
  history.value = []
}

function openDoc(item: SearchResultItem): void {
  void router.push({ name: 'document-preview', params: { id: item.id } })
}

/** 类型徽标：已知扩展名显示大写；未知类型显示「文档」（真实结果无 fileType，「在线」文案误导，工单 04） */
function fileTypeText(item: SearchResultItem): string {
  return item.fileType ? item.fileType.toUpperCase() : '文档'
}

onMounted(async () => {
  history.value = getSearchHistory()
  try {
    hot.value = await fetchHotSearch()
  } catch {
    hot.value = []
  }
  try {
    categories.value = await fetchCategories()
  } catch {
    categories.value = []
  }
})
</script>

<template>
  <div class="page search-page">
    <h2 class="page-title">智能搜索</h2>

    <!-- 大搜索框 + 高级搜索 -->
    <div class="search-hero">
      <div class="search-bar">
        <el-input v-model="keyword" size="large" class="search-input" placeholder="搜索文档标题、摘要、标签…" clearable
          @keyup.enter="onSearchClick">
          <template #prefix>
            <el-icon>
              <Search />
            </el-icon>
          </template>
        </el-input>
        <el-button size="large" type="primary" @click="onSearchClick">搜索</el-button>
        <el-button size="large" :type="advancedVisible ? 'primary' : 'default'" plain @click="onAdvancedToggle">
          高级搜索
        </el-button>
      </div>

      <div v-show="advancedVisible" class="advanced-panel">
        <!-- 真实通道 SearchQueryDto 仅收 q/page/pageSize，其余参数被静默剥离（工单 04：禁用并标注，避免无声空转） -->
        <el-alert v-if="realMode" title="当前后端仅支持关键词检索，以下筛选暂不生效" type="info" :closable="false" class="filter-hint"
          show-icon />
        <el-select v-model="fileType" placeholder="文件类型" clearable class="filter-item" :disabled="realMode">
          <el-option v-for="opt in FILE_TYPE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至"
          start-placeholder="更新起始" end-placeholder="更新截止" class="filter-item" :disabled="realMode" />
        <el-select v-model="categoryId" placeholder="文档分类" clearable class="filter-item" :disabled="realMode">
          <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-select v-model="visibility" placeholder="权限范围" clearable class="filter-item" :disabled="realMode">
          <el-option v-for="opt in VISIBILITY_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button type="primary" :icon="Search" :disabled="realMode" @click="onFilterSearch">筛选</el-button>
        <el-button :icon="Refresh" @click="resetFilters">重置</el-button>
      </div>

      <!-- 热门搜索 + 搜索历史 -->
      <div class="assist-row">
        <span class="assist-label">热门搜索：</span>
        <el-tag v-for="h in hot" :key="h.keyword" class="assist-tag hot" effect="plain" @click="searchBy(h.keyword)">
          {{ h.keyword }} <span class="hot-count">{{ h.count }}</span>
        </el-tag>
      </div>
      <div v-if="history.length > 0" class="assist-row">
        <span class="assist-label">搜索历史：</span>
        <el-tag v-for="h in history" :key="h" class="assist-tag" effect="plain" @click="searchBy(h)">
          {{ h }}
        </el-tag>
        <el-button link type="danger" size="small" :icon="Delete" @click="clearHistory">清空历史</el-button>
      </div>
    </div>

    <!-- 结果区 -->
    <div v-if="!searched" class="empty-hint">
      <el-empty description="输入关键词开始搜索" />
    </div>
    <template v-else>
      <div class="result-head">
        <span class="result-total">
          共 <b>{{ total }}</b> 条与“<span class="q-text">{{ executedQuery }}</span>”相关的结果
        </span>
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="list">
            <el-icon>
              <List />
            </el-icon>
          </el-radio-button>
          <el-radio-button value="card">
            <el-icon>
              <Grid />
            </el-icon>
          </el-radio-button>
        </el-radio-group>
      </div>

      <div v-loading="loading">
        <!-- 列表视图 -->
        <div v-if="viewMode === 'list'" class="result-list">
          <div v-for="item in list" :key="item.id" class="result-item" @click="openDoc(item)">
            <div class="item-title">
              <span class="file-badge" :class="{ online: item.fileType === undefined && !realMode }">
                {{ fileTypeText(item) }}
              </span>
              <HighlightText class="title-text" :text="item.title" :keyword="executedQuery" />
            </div>
            <div class="item-summary">
              <HighlightText :text="item.summary" :keyword="executedQuery" />
            </div>
            <div class="item-meta">
              <!-- 真实结果无分类/标签/权限数据：隐藏对应占位而非显示误导文案（工单 04） -->
              <span v-if="!realMode" class="crumb">{{ item.categoryName || '未分类' }}</span>
              <template v-if="!realMode">
                <el-tag v-for="tag in item.tags" :key="tag" size="small" effect="plain" class="item-tag">
                  <HighlightText :text="tag" :keyword="executedQuery" />
                </el-tag>
              </template>
              <span class="meta-time">发布于 {{ new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })
              }}</span>
              <!-- 可选链兜底 + 真实模式隐藏：后端结果无 visibility，undefined.tag 会白屏（工单 04 崩溃点） -->
              <el-tag v-if="item.visibility" size="small" :type="VISIBILITY_TAG[item.visibility]?.type" effect="light">
                {{ VISIBILITY_TAG[item.visibility]?.label }}
              </el-tag>
            </div>
          </div>
          <el-empty v-if="list.length === 0"
            :description="realMode ? '未找到相关文档。真实检索仅覆盖已发布文档（草稿与待审核不参与检索）' : '未找到相关文档，换个关键词试试'" />
        </div>

        <!-- 卡片视图 -->
        <div v-else class="card-grid">
          <div v-for="item in list" :key="item.id" class="result-card" @click="openDoc(item)">
            <div class="item-title">
              <span class="file-badge" :class="{ online: item.fileType === undefined && !realMode }">
                {{ fileTypeText(item) }}
              </span>
              <HighlightText class="title-text" :text="item.title" :keyword="executedQuery" />
            </div>
            <div class="item-summary card-summary">
              <HighlightText :text="item.summary" :keyword="executedQuery" />
            </div>
            <div class="card-meta">
              <el-tag v-if="item.visibility" size="small" :type="VISIBILITY_TAG[item.visibility]?.type" effect="light">
                {{ VISIBILITY_TAG[item.visibility]?.label }}
              </el-tag>
              <span class="meta-time">发布于 {{ new Date(item.updatedAt).toLocaleDateString('zh-CN') }}</span>
            </div>
          </div>
          <el-empty v-if="list.length === 0"
            :description="realMode ? '未找到相关文档。真实检索仅覆盖已发布文档（草稿与待审核不参与检索）' : '未找到相关文档，换个关键词试试'" class="card-empty" />
        </div>

        <div class="list-footer">
          <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total"
            :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" background @current-change="doSearch"
            @size-change="onSearchClick" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.search-page {
  max-width: 960px;
  margin: 0 auto;
}

.search-hero {
  background: #fff;
  border-radius: 6px;
  padding: 20px;
  margin-bottom: 16px;
}

.search-bar {
  display: flex;
  gap: 12px;
}

.search-input {
  flex: 1;
}

.advanced-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 14px;
  padding: 14px;
  background: #f5f7fa;
  border-radius: 6px;
}

.filter-hint {
  width: 100%;
}

.filter-item {
  width: 200px;
}

.assist-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.assist-label {
  font-size: 13px;
  color: #909399;
  flex-shrink: 0;
}

.assist-tag {
  cursor: pointer;
}

.assist-tag.hot .hot-count {
  margin-left: 2px;
  font-size: 11px;
  color: #f56c6c;
}

.empty-hint {
  background: #fff;
  border-radius: 6px;
  padding: 40px 0;
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.result-total {
  font-size: 13px;
  color: #606266;
}

.q-text {
  color: var(--el-color-primary);
  font-weight: 600;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.result-item,
.result-card {
  background: #fff;
  border-radius: 6px;
  padding: 16px 20px;
  cursor: pointer;
  transition: box-shadow 0.2s;
}

.result-item:hover,
.result-card:hover {
  box-shadow: 0 2px 12px rgb(0 0 0 / 8%);
}

.item-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.file-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: #b0b6bf;
  border-radius: 4px;
  padding: 1px 6px;
}

.file-badge.online {
  background: var(--el-color-primary);
}

.item-summary {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: #606266;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}

.crumb {
  color: var(--el-color-primary);
}

.crumb::before {
  content: '分类：';
  color: #909399;
}

.meta-time {
  margin-left: auto;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  min-height: 200px;
}

.card-summary {
  -webkit-line-clamp: 3;
}

.card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.card-empty {
  grid-column: 1 / -1;
}

.list-footer {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}
</style>
