<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus'
import {
  Refresh,
  Search,
  Upload,
  FolderAdd,
  List,
  Grid,
  View,
  Download,
  MoreFilled,
  SuccessFilled,
  Loading,
  CircleCloseFilled,
  Clock,
  EditPen,
  InfoFilled,
} from '@element-plus/icons-vue'
import {
  archiveDocument,
  batchDocuments,
  deleteDocument,
  fetchDocument,
  fetchDocuments,
  publishDocument,
  saveDraftDocument,
  type DocumentWithOwner,
} from '@/api/documents'
import { createFolder, fetchFolders } from '@/api/folders'
import { isRealResource } from '@/api/endpoint'
import { useUserStore } from '@/stores/user'
import type { DocStatus, DocZone, FileType, Folder, ParseStatus, Visibility } from '@/types/api'
import { DOC_STATUS_META, PARSE_STATUS_META } from './meta'
import UploadDialog from './components/UploadDialog.vue'
import MetaDialog from './components/MetaDialog.vue'
import MoveDialog from './components/MoveDialog.vue'

const router = useRouter()
const userStore = useUserStore()

/** 真实模式（documents 切真实通道；kh_api_mode 逃生舱可回退） */
const realMode = computed(() => isRealResource('documents'))

/** spec §9 管理权：本人或 admin（UI 隐藏按钮 + mock handler 双重校验） */
function canManage(ownerId: string): boolean {
  return userStore.isAdmin || userStore.user?.id === ownerId
}

// ---------- 四分区（spec §5.2） ----------
interface ZoneMeta {
  key: DocZone
  label: string
  icon: string
}

const ZONES: ZoneMeta[] = [
  { key: 'mine', label: '我的文档', icon: 'Document' },
  { key: 'public', label: '公共文档', icon: 'Files' },
  { key: 'department', label: '部门文档', icon: 'OfficeBuilding' },
  { key: 'archive', label: '文档归档', icon: 'FolderOpened' },
]

// 真实模式隐藏部门分区：后端无用户→部门数据，zone=department 无法翻译成 query（spec 工单 05）
const visibleZones = computed(() => ZONES.filter((z) => z.key !== 'department' || !realMode.value))

const zone = ref<DocZone>('mine')
const folderId = ref<string>()

// ---------- 文件夹树（当前分区；新建动作在工单 05） ----------
interface FolderNode extends Folder {
  children: FolderNode[]
}

const folderTree = ref<FolderNode[]>([])
const treeData = computed<FolderNode[]>(() => [
  {
    id: '',
    name: '全部文档',
    parentId: null,
    zone: zone.value,
    ownerId: null,
    departmentId: null,
    children: folderTree.value,
  },
])

function buildFolderTree(folders: Folder[]): FolderNode[] {
  const nodes = folders.map((f) => ({ ...f, children: [] as FolderNode[] }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const roots: FolderNode[] = []
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

async function loadFolders(): Promise<void> {
  // 真实模式无 folders 后端：目录树显示空态说明而非 Mock 数据（避免与真实文档无关的假层级，spec 工单 05）
  if (realMode.value) {
    folderTree.value = []
    return
  }
  try {
    folderTree.value = buildFolderTree(await fetchFolders({ zone: zone.value }))
  } catch {
    folderTree.value = []
  }
}

function onFolderClick(data: FolderNode): void {
  folderId.value = data.id || undefined
}

async function onCreateFolder(): Promise<void> {
  const { value } = await ElMessageBox.prompt('文件夹名称', '新建文件夹', {
    inputPattern: /\S+/,
    inputErrorMessage: '名称不能为空',
  }).catch(() => ({ value: '' }))
  if (!value?.trim()) return
  try {
    await createFolder({ name: value.trim(), zone: zone.value, parentId: folderId.value ?? null })
    ElMessage.success('文件夹已创建')
    loadFolders()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建文件夹失败')
  }
}

// ---------- 筛选与查询 ----------
const keyword = ref('')
const fileType = ref<FileType>()
const parseStatus = ref<ParseStatus>()
const visibility = ref<Visibility>()
const viewMode = ref<'list' | 'card'>('list')
const loading = ref(false)
const list = ref<DocumentWithOwner[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const sortField = ref<'createdAt' | 'updatedAt'>('createdAt')
const order = ref<'asc' | 'desc'>('desc')

const FILE_TYPE_OPTIONS: { value: FileType; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'pptx', label: 'PPTX' },
  { value: 'md', label: 'MD' },
  { value: 'txt', label: 'TXT' },
]

const PARSE_STATUS_OPTIONS: { value: ParseStatus; label: string }[] = [
  { value: 'done', label: '解析完成' },
  { value: 'processing', label: '解析中' },
  { value: 'failed', label: '解析失败' },
  { value: 'pending', label: '待解析' },
]

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'company', label: '公司可见' },
  { value: 'department', label: '部门可见' },
  { value: 'private', label: '仅本人可见' },
]

const removedArchived = ref(0)

async function fetchList(opts: { silent?: boolean } = {}): Promise<void> {
  if (!opts.silent) loading.value = true
  try {
    const result = await fetchDocuments(
      {
        zone: zone.value,
        folderId: folderId.value,
        keyword: keyword.value.trim() || undefined,
        fileType: fileType.value,
        parseStatus: parseStatus.value,
        visibility: visibility.value,
        sort: sortField.value,
        order: order.value,
        page: page.value,
        pageSize: pageSize.value,
      },
      userStore.user?.id ?? '',
    )
    list.value = result.list
    total.value = result.total
    removedArchived.value = result.removedArchived ?? 0
    selected.value = []
    syncParsePolling()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载文档列表失败')
  } finally {
    loading.value = false
  }
}

/** 从第一页重新查询：页码已是 1 时直接请求，否则改页码由 page watch 触发，避免双重请求 */
function searchFromFirstPage(): void {
  if (page.value === 1) fetchList()
  else page.value = 1
}

let keywordTimer: ReturnType<typeof setTimeout> | undefined
watch(keyword, () => {
  clearTimeout(keywordTimer)
  keywordTimer = setTimeout(searchFromFirstPage, 300)
})
watch([fileType, parseStatus, visibility], searchFromFirstPage)
watch(folderId, searchFromFirstPage)
watch(page, () => fetchList())
watch(pageSize, searchFromFirstPage)

async function switchZone(next: DocZone): Promise<void> {
  if (zone.value === next) return
  zone.value = next
  folderId.value = undefined
  page.value = 1
  loadFolders()
  fetchList()
}

function refreshAll(): void {
  loadFolders()
  fetchList()
}

function onSortChange(info: { prop: string | null; order: string | null }): void {
  const prop = info.prop
  if (prop !== 'createdAt' && prop !== 'updatedAt') return
  sortField.value = prop
  order.value = info.order === 'ascending' ? 'asc' : 'desc'
  fetchList()
}

// ---------- 解析状态轮询（mock 流转：pending → processing → done/failed，见 mocks/parse.ts） ----------
let pollTimer: ReturnType<typeof setInterval> | undefined

function syncParsePolling(): void {
  const transiting = list.value.some((d) => d.parseStatus === 'pending' || d.parseStatus === 'processing')
  if (transiting && pollTimer === undefined) {
    pollTimer = setInterval(() => fetchList({ silent: true }), 2000)
  } else if (!transiting && pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

onUnmounted(() => {
  if (pollTimer !== undefined) clearInterval(pollTimer)
})

onMounted(() => {
  loadFolders()
  fetchList()
})

// ---------- 行内与批量操作 ----------
const tableRef = ref<TableInstance>()
const selected = ref<DocumentWithOwner[]>([])

function onSelectionChange(rows: DocumentWithOwner[]): void {
  selected.value = rows
}

function clearSelection(): void {
  tableRef.value?.clearSelection()
  selected.value = []
}

async function onDownload(doc: DocumentWithOwner): Promise<void> {
  try {
    // 真实列表行无 fileUrl：先拉详情取 source_file_url（spec 工单 05 预览下载降级的前置实现）
    const url = doc.fileUrl ?? (realMode.value ? (await fetchDocument(doc.id)).fileUrl : undefined)
    if (!url) {
      ElMessage.warning('该文档没有可下载的原始文件')
      return
    }
    const blob = await fetch(url).then((r) => r.blob())
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = doc.title
    a.click()
    URL.revokeObjectURL(objectUrl)
  } catch {
    ElMessage.error('下载失败')
  }
}

function onOpenEditor(doc: DocumentWithOwner): void {
  router.push({ name: 'document-editor', params: { id: doc.id } })
}

// ---------- 弹窗接线 ----------
const uploadVisible = ref(false)
const metaVisible = ref(false)
const metaMode = ref<'create' | 'edit'>('create')
const editingDoc = ref<DocumentWithOwner | null>(null)
const moveVisible = ref(false)
const moveIds = ref<string[]>([])

function onCreateOnline(): void {
  metaMode.value = 'create'
  editingDoc.value = null
  metaVisible.value = true
}

function onEditMeta(doc: DocumentWithOwner): void {
  metaMode.value = 'edit'
  editingDoc.value = doc
  metaVisible.value = true
}

function onCreated(doc: DocumentWithOwner): void {
  router.push({ name: 'document-editor', params: { id: doc.id } })
}

function onBatchMove(): void {
  moveIds.value = selected.value.map((d) => d.id)
  moveVisible.value = true
}

/** 单行操作统一入口（下拉 command 与归档区按钮共用） */
function onRowCommand(command: string, doc: DocumentWithOwner): void {
  switch (command) {
    case 'meta':
      onEditMeta(doc)
      break
    case 'publish':
      void onStatusAction(doc, 'publish')
      break
    case 'unpublish':
      void onStatusAction(doc, 'unpublish')
      break
    case 'archive':
      if (realMode.value) void onStatusAction(doc, 'archive')
      else void runBatch('archive', [doc])
      break
    case 'restore':
      void runBatch('restore', [doc])
      break
    case 'delete':
      void onDelete(doc)
      break
  }
}

/** 真实模式状态流转（spec 工单 03）：提交审核 / 下架 / 归档，成功后重拉列表 */
async function onStatusAction(doc: DocumentWithOwner, action: 'publish' | 'unpublish' | 'archive'): Promise<void> {
  const labels = { publish: '提交审核', unpublish: '下架编辑', archive: '归档' } as const
  try {
    if (action === 'publish') await publishDocument(doc.id)
    else if (action === 'unpublish') await saveDraftDocument(doc.id)
    else await archiveDocument(doc.id)
    ElMessage.success(`已${labels[action]}「${doc.title}」`)
    fetchList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : `${labels[action]}失败`)
  }
}

async function onDelete(doc: DocumentWithOwner): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定删除「${doc.title}」？删除后不可恢复`,
    '删除文档',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteDocument(doc.id)
    ElMessage.success('已删除')
    // 当前页仅剩此一条时回退一页，避免停在空页
    if (list.value.length === 1 && page.value > 1) page.value -= 1
    else fetchList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

const BATCH_LABEL: Record<'delete' | 'archive' | 'restore', string> = {
  delete: '删除',
  archive: '归档',
  restore: '恢复',
}

async function runBatch(action: 'delete' | 'archive' | 'restore', targets: DocumentWithOwner[]): Promise<void> {
  if (realMode.value && action !== 'delete') {
    ElMessage.warning('真实模式不支持批量归档/恢复（后端无批量接口，且归档为终态）')
    return
  }
  if (action === 'delete') {
    const confirmed = await ElMessageBox.confirm(
      `确定删除选中的 ${targets.length} 个文档？删除后不可恢复`,
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    ).catch(() => false)
    if (!confirmed) return
  }
  try {
    const { affected } = await batchDocuments({ action, ids: targets.map((d) => d.id) })
    ElMessage.success(`已${BATCH_LABEL[action]} ${affected} 个文档`)
    fetchList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

function onBatch(action: 'delete' | 'archive' | 'restore'): void {
  void runBatch(action, selected.value)
}

// ---------- 展示辅助 ----------
const FILE_BADGE_BG: Partial<Record<FileType, string>> = {
  pdf: '#e35b5b',
  docx: '#3f7bf5',
  xlsx: '#33a06f',
  pptx: '#ef8c46',
  md: '#8a8f99',
  txt: '#b0b6bf',
}

/** 解析状态：文案与配色取自 meta.ts（与预览页同源），图标是列表私有物 */
const STATUS_META: Record<ParseStatus, { label: string; tag: 'success' | 'warning' | 'danger' | 'info'; icon: unknown }> = {
  done: { ...PARSE_STATUS_META.done, icon: SuccessFilled },
  processing: { ...PARSE_STATUS_META.processing, icon: Loading },
  failed: { ...PARSE_STATUS_META.failed, icon: CircleCloseFilled },
  pending: { ...PARSE_STATUS_META.pending, icon: Clock },
}

const VISIBILITY_META: Record<Visibility, { label: string; tag: 'info' | 'primary' | 'success' }> = {
  private: { label: '仅本人可见', tag: 'info' },
  department: { label: '部门可见', tag: 'primary' },
  company: { label: '公司可见', tag: 'success' },
}

function fileTypeText(doc: DocumentWithOwner): string {
  return doc.type === 'online' ? '在线' : (doc.fileType?.toUpperCase() ?? '文件')
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 决议 #3：pdf 原生内嵌预览、在线文档只读查看；office/md/txt 一期仅下载（入口置灰）。
 * 真实模式列表无 fileType，交由详情页按 source_file_name 实际类型处理，入口保持可用 */
function canPreview(doc: DocumentWithOwner): boolean {
  if (realMode.value) return true
  return doc.type === 'online' || doc.fileType === 'pdf'
}

function previewTip(doc: DocumentWithOwner): string {
  return canPreview(doc) ? '预览' : '该格式暂不支持在线预览，请下载查看'
}

function onPreview(doc: DocumentWithOwner): void {
  router.push({ name: 'document-preview', params: { id: doc.id } })
}
</script>

<template>
  <div class="documents-page">
    <!-- 左侧：四分区 + 文件夹树 -->
    <el-aside class="doc-aside" width="200px">
      <div class="aside-title">文档管理</div>
      <div v-for="z in visibleZones" :key="z.key" class="zone-item" :class="{ active: zone === z.key }"
        @click="switchZone(z.key)">
        <el-icon>
          <component :is="z.icon" />
        </el-icon>
        <span>{{ z.label }}</span>
      </div>

      <div class="folder-head">
        文件夹
        <el-tooltip v-if="!realMode" content="后端暂未提供文件夹接口，目录树为演示数据" placement="top">
          <el-icon class="folder-hint">
            <InfoFilled />
          </el-icon>
        </el-tooltip>
      </div>
      <!-- 真实模式：后端无 folders 接口，显示空态说明而非静默空白（spec 工单 05） -->
      <div v-if="realMode" class="folder-empty">后端暂未提供文件夹接口，目录功能暂不可用</div>
      <el-tree v-else class="folder-tree" :data="treeData" node-key="id" :props="{ label: 'name' }" default-expand-all
        highlight-current :current-node-key="''" @current-change="onFolderClick" />
    </el-aside>

    <!-- 右侧：工具栏 + 列表 -->
    <div class="doc-main">
      <div class="toolbar">
        <el-input v-model="keyword" class="search-input" placeholder="搜索文档名称、内容、上传人等" :prefix-icon="Search" clearable />
        <template v-if="zone !== 'archive'">
          <el-button v-permission="'document:create'" :icon="Upload" @click="uploadVisible = true">批量上传</el-button>
          <el-button v-if="!realMode" v-permission="'document:create'" :icon="EditPen"
            @click="onCreateOnline">新建在线文档</el-button>
          <!-- 新建文件夹依赖 folders 后端（真实模式无接口），隐藏避免点了没反应 -->
          <el-button v-if="!realMode" :icon="FolderAdd" @click="onCreateFolder">新建文件夹</el-button>
        </template>
        <div class="toolbar-spacer" />
        <el-select v-model="fileType" class="filter-select" placeholder="文件类型" clearable>
          <el-option v-for="opt in FILE_TYPE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <!-- 真实列表无解析/权限数据，筛选会变成无声空转（后端仅支持 title/状态/公开过滤），隐藏 -->
        <el-select v-if="!realMode" v-model="parseStatus" class="filter-select" placeholder="解析状态" clearable>
          <el-option v-for="opt in PARSE_STATUS_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-if="!realMode" v-model="visibility" class="filter-select" placeholder="权限范围" clearable>
          <el-option v-for="opt in VISIBILITY_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button circle :icon="Refresh" title="刷新" @click="refreshAll" />
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

      <!-- 已归档行过滤提示（后端无法表达「非归档」，mine/public 混入 status=3 属已知偏差，工单 03） -->
      <el-alert v-if="realMode && removedArchived > 0" :title="`已隐藏 ${removedArchived} 条已归档文档（当前分区不含归档）`" type="info"
        :closable="false" class="archived-hint" />

      <!-- 批量操作条（列表视图多选时出现） -->
      <div v-if="selected.length > 0 && viewMode === 'list'" class="batch-bar">
        <span class="batch-count">已选 {{ selected.length }} 项</span>
        <el-button size="small" @click="onBatchMove">移动到…</el-button>
        <el-button v-if="zone !== 'archive'" size="small" @click="onBatch('archive')">批量归档</el-button>
        <el-button v-else size="small" @click="onBatch('restore')">批量恢复</el-button>
        <el-button v-permission="'document:delete'" size="small" type="danger" plain
          @click="onBatch('delete')">批量删除</el-button>
        <el-button size="small" link @click="clearSelection">取消选择</el-button>
      </div>

      <!-- 列表视图 -->
      <el-table v-if="viewMode === 'list'" ref="tableRef" v-loading="loading" :data="list" class="doc-table"
        empty-text="暂无文档" :default-sort="{ prop: 'createdAt', order: 'descending' }" @sort-change="onSortChange"
        @selection-change="onSelectionChange">
        <el-table-column type="selection" width="42" />
        <el-table-column label="文档名称" min-width="260">
          <template #default="{ row }">
            <div class="doc-name">
              <span v-if="row.type === 'online'" class="file-badge online" title="在线文档">
                <el-icon :size="14">
                  <EditPen />
                </el-icon>
              </span>
              <span v-else class="file-badge"
                :style="{ background: FILE_BADGE_BG[row.fileType as FileType] ?? '#b0b6bf' }">
                {{ row.fileType?.toUpperCase() ?? '文件' }}
              </span>
              <span class="doc-title" :title="row.title">{{ row.title }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="文件类型" width="90">
          <template #default="{ row }">{{ fileTypeText(row as DocumentWithOwner) }}</template>
        </el-table-column>
        <!-- 后端固定 created_at DESC，真实模式关闭排序（避免点击无反应的静默失败） -->
        <el-table-column prop="createdAt" label="上传时间" width="180" :sortable="realMode ? false : 'custom'">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="ownerName" label="上传人" width="110">
          <template #default="{ row }">{{ (row as DocumentWithOwner).ownerName || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag v-if="(row as DocumentWithOwner).docStatus !== undefined"
              :type="DOC_STATUS_META[(row as DocumentWithOwner).docStatus as DocStatus].tag" size="small">
              {{ DOC_STATUS_META[(row as DocumentWithOwner).docStatus as DocStatus].label }}
            </el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="解析状态" width="120">
          <template #default="{ row }">
            <!-- 可选链兜底：真实列表行无 parse_state（仅近期上传行有），防 TypeError 白屏（工单 03） -->
            <el-tag v-if="row.parseStatus" :type="STATUS_META[row.parseStatus as ParseStatus]?.tag ?? 'info'"
              size="small" effect="light">
              <el-icon class="status-icon">
                <component :is="STATUS_META[row.parseStatus as ParseStatus]?.icon" />
              </el-icon>
              {{ STATUS_META[row.parseStatus as ParseStatus]?.label ?? '—' }}
            </el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="权限范围" width="120">
          <template #default="{ row }">
            <!-- 可选链兜底：真实行 visibility 仅 private/company，department 永不产生（工单 03） -->
            <el-tag :type="VISIBILITY_META[row.visibility as Visibility]?.tag ?? 'info'" size="small" effect="plain">
              {{ VISIBILITY_META[row.visibility as Visibility]?.label ?? '—' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <template v-if="zone !== 'archive'">
              <el-tooltip :content="previewTip(row as DocumentWithOwner)" placement="top">
                <span class="preview-btn-wrap">
                  <el-button link type="primary" :icon="View" :disabled="!canPreview(row as DocumentWithOwner)"
                    @click="onPreview(row as DocumentWithOwner)" />
                </span>
              </el-tooltip>
              <el-tooltip v-if="realMode || (row as DocumentWithOwner).type === 'file'" content="下载">
                <el-button link type="primary" :icon="Download" @click="onDownload(row as DocumentWithOwner)" />
              </el-tooltip>
              <el-tooltip v-else v-permission="'document:edit'" content="编辑内容">
                <el-button link type="primary" :icon="EditPen" @click="onOpenEditor(row as DocumentWithOwner)" />
              </el-tooltip>
              <el-dropdown v-if="realMode" trigger="click"
                @command="(cmd: string) => onRowCommand(cmd, row as DocumentWithOwner)">
                <el-button link type="primary" :icon="MoreFilled" />
                <template #dropdown>
                  <!-- 真实模式按 docStatus 分支（spec 工单 03）：0 提审 / 1 下架+归档 / 2 等待 / 3 终态 -->
                  <el-dropdown-menu v-if="row.docStatus === 0">
                    <el-dropdown-item command="publish">提交审核</el-dropdown-item>
                    <el-dropdown-item command="meta">编辑信息</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                  <el-dropdown-menu v-else-if="row.docStatus === 1">
                    <el-dropdown-item command="unpublish">下架编辑</el-dropdown-item>
                    <el-dropdown-item command="archive">归档</el-dropdown-item>
                    <el-dropdown-item command="meta" divided>编辑信息</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                  <el-dropdown-menu v-else-if="row.docStatus === 2">
                    <el-dropdown-item command="noop" disabled>等待审核</el-dropdown-item>
                  </el-dropdown-menu>
                  <el-dropdown-menu v-else>
                    <el-dropdown-item command="noop" disabled>已归档（终态）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-dropdown v-else-if="canManage((row as DocumentWithOwner).ownerId)" trigger="click"
                @command="(cmd: string) => onRowCommand(cmd, row as DocumentWithOwner)">
                <el-button link type="primary" :icon="MoreFilled" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="meta">编辑信息</el-dropdown-item>
                    <el-dropdown-item command="archive">归档</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
            <template v-else>
              <!-- 后端归档是终态无恢复接口：真实模式禁用「恢复」并说明（工单 03） -->
              <el-tooltip v-if="realMode" content="后端归档为终态，暂不支持取消归档">
                <span class="preview-btn-wrap">
                  <el-button link type="primary" disabled>恢复</el-button>
                </span>
              </el-tooltip>
              <el-button v-else link type="primary"
                @click="onRowCommand('restore', row as DocumentWithOwner)">恢复</el-button>
              <el-button v-if="canManage((row as DocumentWithOwner).ownerId)" v-permission="'document:delete'" link
                type="danger" @click="onRowCommand('delete', row as DocumentWithOwner)">删除</el-button>
            </template>
          </template>
        </el-table-column>
        <template #empty>暂无文档</template>
      </el-table>

      <!-- 卡片视图 -->
      <div v-else v-loading="loading" class="card-grid">
        <div v-for="doc in list" :key="doc.id" class="doc-card">
          <div class="card-head">
            <span v-if="doc.type === 'online'" class="file-badge online">
              <el-icon :size="14">
                <EditPen />
              </el-icon>
            </span>
            <span v-else class="file-badge"
              :style="{ background: FILE_BADGE_BG[doc.fileType as FileType] ?? '#b0b6bf' }">
              {{ doc.fileType?.toUpperCase() }}
            </span>
            <span class="card-title" :title="doc.title">{{ doc.title }}</span>
          </div>
          <div class="card-tags">
            <el-tag v-if="doc.parseStatus" :type="STATUS_META[doc.parseStatus]?.tag ?? 'info'" size="small">
              {{ STATUS_META[doc.parseStatus]?.label ?? '—' }}
            </el-tag>
            <el-tag v-if="doc.docStatus !== undefined" :type="DOC_STATUS_META[doc.docStatus].tag" size="small">
              {{ DOC_STATUS_META[doc.docStatus].label }}
            </el-tag>
            <el-tag :type="VISIBILITY_META[doc.visibility]?.tag ?? 'info'" size="small" effect="plain">
              {{ VISIBILITY_META[doc.visibility]?.label ?? '—' }}
            </el-tag>
          </div>
          <div class="card-meta">
            <span>{{ doc.ownerName || '—' }}</span>
            <span>{{ formatDateTime(doc.createdAt) }}</span>
          </div>
        </div>
        <el-empty v-if="list.length === 0" description="暂无文档" class="card-empty" />
      </div>

      <div class="list-footer">
        <span class="total-text">共 {{ total }} 篇</span>
        <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total"
          :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, jumper" background />
      </div>
    </div>

    <!-- 弹窗：批量上传 / 新建在线文档·编辑信息 / 批量移动 -->
    <UploadDialog v-model:visible="uploadVisible" :zone="zone" :folder-id="folderId" @uploaded="searchFromFirstPage" />
    <MetaDialog v-model:visible="metaVisible" :mode="metaMode" :doc="editingDoc" :zone="zone" @created="onCreated"
      @saved="fetchList()" />
    <MoveDialog v-model:visible="moveVisible" :ids="moveIds" @moved="fetchList()" />
  </div>
</template>

<style scoped>
.preview-btn-wrap {
  display: inline-flex;
}

.preview-btn-wrap :deep(.el-button.is-disabled) {
  color: #c0c4cc;
}

.documents-page {
  display: flex;
  gap: 12px;
  padding: 16px;
  align-items: flex-start;
}

.doc-aside {
  background: #fff;
  border-radius: 6px;
  padding: 16px 10px;
  flex-shrink: 0;
}

.aside-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  padding: 0 10px 12px;
}

.zone-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 4px;
  font-size: 14px;
  color: #303133;
  cursor: pointer;
  margin-bottom: 2px;
}

.zone-item:hover {
  background: #f5f7fa;
}

.zone-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

.folder-head {
  font-size: 12px;
  color: #909399;
  padding: 14px 10px 6px;
  border-top: 1px solid #f0f2f5;
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.folder-hint {
  cursor: help;
  font-size: 12px;
}

.folder-empty {
  padding: 10px;
  font-size: 12px;
  color: #a8abb2;
  line-height: 1.6;
}

.folder-tree {
  --el-tree-node-content-height: 30px;
  background: transparent;
}

.folder-tree :deep(.el-tree-node__content) {
  border-radius: 4px;
}

.doc-main {
  flex: 1;
  min-width: 0;
  background: #fff;
  border-radius: 6px;
  padding: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.search-input {
  width: 260px;
}

.toolbar-spacer {
  flex: 1;
}

.filter-select {
  width: 110px;
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--el-color-primary-light-9);
  border-radius: 4px;
}

.batch-count {
  font-size: 13px;
  color: var(--el-color-primary);
  font-weight: 500;
}

.doc-table {
  width: 100%;
}

.doc-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.doc-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  height: 22px;
  padding: 0 5px;
  border-radius: 4px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.file-badge.online {
  background: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}

.status-icon {
  margin-right: 2px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  min-height: 200px;
}

.doc-card {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: box-shadow 0.2s;
}

.doc-card:hover {
  box-shadow: 0 4px 12px rgb(0 0 0 / 8%);
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.card-title {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-tags {
  display: flex;
  gap: 6px;
}

.card-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #909399;
}

.card-empty {
  grid-column: 1 / -1;
}

.list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}

.total-text {
  font-size: 13px;
  color: #606266;
}
</style>
