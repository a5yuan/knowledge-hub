<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import {
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncementPage,
  updateAnnouncement,
} from '@/api/announcements'
import type { Announcement } from '@/types/api'

/**
 * 系统管理-公告管理（21 号工单）。
 *
 * 权限：`announcement:manage`（v-permission 控制新建/编辑/删除按钮）。
 * 读接口只要登录即可 —— 公告要有前台展示位，读被锁死就没有意义。
 *
 * 本页不做「过期过滤」：列表拿的是全量（含停用、过期），方便管理员看到并处理；
 * 前台大盘走 `?enabled=true`，过期与停用由**后端**过滤，两处口径不重复。
 */
const loading = ref(false)
const list = ref<Announcement[]>([])
const total = ref(0)
const query = reactive({ page: 1, pageSize: 10, title: '' })

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const result = await fetchAnnouncementPage({
      title: query.title.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    })
    list.value = result.list
    total.value = result.total
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '公告列表加载失败')
  } finally {
    loading.value = false
  }
}

function onSearch(): void {
  query.page = 1
  void loadList()
}

function onReset(): void {
  query.title = ''
  query.page = 1
  void loadList()
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

// ---------- 新建 / 编辑 ----------
const formVisible = ref(false)
const formRef = ref<FormInstance>()
const editingId = ref<string | null>(null)
const form = reactive({ title: '', content: '', enabled: true, sort: 0 })

const rules: FormRules = {
  title: [
    { required: true, message: '请输入公告标题', trigger: 'blur' },
    { max: 200, message: '标题不超过 200 字', trigger: 'blur' },
  ],
  content: [{ required: true, message: '请输入公告正文', trigger: 'blur' }],
}

function resetForm(): void {
  form.title = ''
  form.content = ''
  form.enabled = true
  form.sort = 0
  formRef.value?.clearValidate()
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  formVisible.value = true
}

function openEdit(row: Announcement): void {
  editingId.value = row.id
  form.title = row.title
  form.content = row.content
  form.enabled = row.enabled
  form.sort = row.sort ?? 0
  formRef.value?.clearValidate()
  formVisible.value = true
}

async function onSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  try {
    if (editingId.value) {
      await updateAnnouncement(editingId.value, {
        title: form.title.trim(),
        content: form.content.trim(),
        enabled: form.enabled,
        sort: form.sort,
      })
      ElMessage.success('公告已更新')
    } else {
      await createAnnouncement({
        title: form.title.trim(),
        content: form.content.trim(),
        enabled: form.enabled,
        sort: form.sort,
      })
      ElMessage.success('公告已创建')
    }
    formVisible.value = false
    void loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// ---------- 启停 / 删除 ----------
async function onToggle(row: Announcement): Promise<void> {
  const next = !row.enabled
  try {
    await updateAnnouncement(row.id, { enabled: next })
    ElMessage.success(next ? '已启用' : '已停用')
    void loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

async function onDelete(row: Announcement): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除公告「${row.title}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return // 取消
  }
  try {
    await deleteAnnouncement(row.id)
    ElMessage.success('公告已删除')
    // 删掉最后一条时回退一页，避免停在空页
    if (list.value.length === 1 && query.page > 1) query.page -= 1
    void loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

onMounted(() => {
  void loadList()
})
</script>

<template>
  <div class="page announcement-page">
    <div class="toolbar">
      <el-input
        v-model="query.title"
        placeholder="按标题搜索"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-button type="primary" @click="onSearch">查询</el-button>
      <el-button @click="onReset">重置</el-button>
      <div class="toolbar-grow" />
      <el-button v-permission="'announcement:manage'" type="primary" :icon="Plus" @click="openCreate">
        新建公告
      </el-button>
    </div>

    <el-table v-loading="loading" :data="list" stripe>
      <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.enabled ? 'success' : 'info'" effect="light">
            {{ row.enabled ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发布时间" width="190">
        <template #default="{ row }">
          {{ formatDateTime(row.publishTime ?? row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button v-permission="'announcement:manage'" link type="primary" @click="openEdit(row as Announcement)">
            编辑
          </el-button>
          <el-button v-permission="'announcement:manage'" link type="primary" @click="onToggle(row as Announcement)">
            {{ row.enabled ? '停用' : '启用' }}
          </el-button>
          <el-button v-permission="'announcement:manage'" link type="danger" @click="onDelete(row as Announcement)">
            删除
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无公告" :image-size="80" />
      </template>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @current-change="loadList"
        @size-change="onSearch"
      />
    </div>

    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑公告' : '新建公告'"
      width="640px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="200" show-word-limit placeholder="公告标题" />
        </el-form-item>
        <el-form-item label="正文" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            maxlength="20000"
            show-word-limit
            placeholder="公告正文（纯文本）"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="9999" />
          <span class="hint">数值小的排前面</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="onSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.toolbar-grow {
  flex: 1;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
