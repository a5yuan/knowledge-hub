<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { fetchUsers, createUser, updateUser, deleteUser, type UserView } from '@/api/users'
import { fetchDepartments } from '@/api/departments'
import { useUserStore } from '@/stores/user'
import type { Department, UserStatus, UserRole } from '@/types/api'

/**
 * 系统管理-用户管理（工单 11，spec §5.5 决议 #1：一期仅用户管理；分类/标签/公告二期）。
 * 删除保护由 handler 校验（不可删自己 1413 / 最后一名管理员 1414），前端提示服务端消息。
 */
const userStore = useUserStore()

const loading = ref(false)
const list = ref<UserView[]>([])
const total = ref(0)
const departments = ref<Department[]>([])

const query = reactive({
  keyword: '',
  role: undefined as UserRole | undefined,
  departmentId: undefined as string | undefined,
  status: undefined as UserStatus | undefined,
  page: 1,
  pageSize: 20,
})

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'admin', label: '管理员' },
  { value: 'member', label: '成员' },
]
const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'active', label: '正常' },
  { value: 'disabled', label: '已禁用' },
]

const ROLE_TAG: Record<UserRole, { label: string; type: 'danger' | 'info' }> = {
  admin: { label: '管理员', type: 'danger' },
  member: { label: '成员', type: 'info' },
}

// ---------- 列表 ----------
async function loadList(): Promise<void> {
  loading.value = true
  try {
    const result = await fetchUsers({ ...query })
    list.value = result.list
    total.value = result.total
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '用户列表加载失败')
  } finally {
    loading.value = false
  }
}

function onSearch(): void {
  query.page = 1
  void loadList()
}

function resetQuery(): void {
  query.keyword = ''
  query.role = undefined
  query.departmentId = undefined
  query.status = undefined
  query.page = 1
  void loadList()
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

// ---------- 新增 ----------
const createVisible = ref(false)
const createForm = reactive({
  username: '',
  displayName: '',
  password: '',
  role: 'member' as UserRole,
  departmentId: undefined as string | undefined,
})

function openCreate(): void {
  createForm.username = ''
  createForm.displayName = ''
  createForm.password = ''
  createForm.role = 'member'
  createForm.departmentId = departments.value[0]?.id
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!createForm.username.trim() || !createForm.displayName.trim()) {
    ElMessage.warning('用户名与姓名不能为空')
    return
  }
  try {
    await createUser({
      username: createForm.username.trim(),
      displayName: createForm.displayName.trim(),
      password: createForm.password.trim() || undefined,
      role: createForm.role,
      departmentId: createForm.departmentId ?? departments.value[0]?.id ?? '',
    })
    ElMessage.success('用户创建成功')
    createVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败')
  }
}

// ---------- 编辑（角色/部门） ----------
const editVisible = ref(false)
const editForm = reactive({ id: '', username: '', role: 'member' as UserRole, departmentId: '' })

function openEdit(row: UserView): void {
  editForm.id = row.id
  editForm.username = row.username
  editForm.role = row.role
  editForm.departmentId = row.departmentId
  editVisible.value = true
}

async function submitEdit(): Promise<void> {
  try {
    await updateUser(editForm.id, { role: editForm.role, departmentId: editForm.departmentId })
    ElMessage.success('已保存')
    editVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// ---------- 重置密码 ----------
async function resetPassword(row: UserView): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(`为用户「${row.displayName}」设置新密码`, '重置密码', {
      inputValue: '123456',
      inputPattern: /\S+/,
      inputErrorMessage: '密码不能为空',
    })
    await updateUser(row.id, { password: value.trim() })
    ElMessage.success('密码已重置')
  } catch (error) {
    if (error !== 'cancel' && error instanceof Error) ElMessage.error(error.message)
  }
}

// ---------- 启用/禁用 ----------
async function onStatusChange(row: UserView, status: UserStatus): Promise<void> {
  try {
    await updateUser(row.id, { status })
    ElMessage.success(status === 'active' ? '已启用' : '已禁用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  } finally {
    await loadList() // 失败时以服务端状态回显
  }
}

// ---------- 删除 ----------
async function onDelete(row: UserView): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定删除用户「${row.displayName}（${row.username}）」吗？删除后不可恢复。`,
    '删除用户',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteUser(row.id)
    ElMessage.success('已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  } finally {
    await loadList()
  }
}

onMounted(async () => {
  void loadList()
  try {
    departments.value = await fetchDepartments()
  } catch {
    // 部门下拉加载失败不阻塞列表
  }
})
</script>

<template>
  <div class="page admin-page">
    <!-- 后端无用户管理接口，本页数据恒为 Mock（工单 05：显式标注，避免误解为真实数据） -->
    <h2 class="page-title">系统管理<el-tag size="small" type="info" effect="plain" style="margin-left: 8px">演示数据</el-tag></h2>

    <el-card shadow="never">
      <!-- 筛选工具栏 -->
      <div class="toolbar">
        <el-input v-model="query.keyword" placeholder="搜索用户名、姓名" clearable class="toolbar-item keyword-input"
          @keyup.enter="onSearch">
          <template #prefix>
            <el-icon>
              <Search />
            </el-icon>
          </template>
        </el-input>
        <el-select v-model="query.role" placeholder="角色" clearable class="toolbar-item">
          <el-option v-for="opt in ROLE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="query.departmentId" placeholder="部门" clearable class="toolbar-item">
          <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
        <el-select v-model="query.status" placeholder="状态" clearable class="toolbar-item">
          <el-option v-for="opt in STATUS_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="onSearch">搜索</el-button>
        <el-button :icon="Refresh" @click="resetQuery">重置</el-button>
        <el-button type="primary" :icon="Plus" class="create-btn" @click="openCreate">新增用户</el-button>
      </div>

      <el-table v-loading="loading" :data="list" stripe empty-text="未找到匹配的用户">
        <el-table-column prop="username" label="用户名" width="140" />
        <el-table-column prop="displayName" label="姓名" width="140" />
        <el-table-column label="角色" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="ROLE_TAG[row.role as UserRole].type" effect="light">
              {{ ROLE_TAG[row.role as UserRole].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="departmentName" label="部门" width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-switch :model-value="row.status" active-value="active" inactive-value="disabled"
              :disabled="row.id === userStore.user?.id"
              @change="onStatusChange(row as UserView, $event as UserStatus)" />
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="200">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row as UserView)">编辑</el-button>
            <el-button link type="primary" size="small" @click="resetPassword(row as UserView)">重置密码</el-button>
            <el-button link type="danger" size="small" @click="onDelete(row as UserView)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="table-footer">
        <el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total"
          layout="total, prev, pager, next" background @current-change="loadList" />
      </div>
    </el-card>

    <!-- 新增用户 -->
    <el-dialog v-model="createVisible" title="新增用户" width="440">
      <el-form label-width="80px">
        <el-form-item label="用户名" required>
          <el-input v-model="createForm.username" placeholder="登录账号，唯一" />
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input v-model="createForm.displayName" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="createForm.password" placeholder="留空则默认 123456" show-password />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="createForm.role">
            <el-radio v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="部门">
          <el-select v-model="createForm.departmentId" class="full-width">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑用户（角色/部门调整） -->
    <el-dialog v-model="editVisible" :title="`编辑用户：${editForm.username}`" width="440">
      <el-form label-width="80px">
        <el-form-item label="角色">
          <el-radio-group v-model="editForm.role">
            <el-radio v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="部门">
          <el-select v-model="editForm.departmentId" class="full-width">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.toolbar-item {
  width: 150px;
}

.keyword-input {
  width: 220px;
}

.create-btn {
  margin-left: auto;
}

.table-footer {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.full-width {
  width: 100%;
}
</style>
