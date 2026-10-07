<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { fetchRoles, createRole, updateRole, deleteRole, type RoleView } from '@/api/roles'
import PermissionDialog from './components/PermissionDialog.vue'

/**
 * 系统管理-角色权限（权限模型控制工单）：复刻原型图。
 * 内置角色（init.sql 预置）不可删除，删除保护由后端校验（400），前端直接隐藏删除入口。
 */
const BUILTIN_ROLE_CODES = ['ROLE_ADMIN', 'ROLE_REVIEWER', 'ROLE_USER']

const loading = ref(false)
const list = ref<RoleView[]>([])
const total = ref(0)
const query = reactive({ page: 1, pageSize: 10 })

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const result = await fetchRoles(query.page, query.pageSize)
    list.value = result.list
    total.value = result.total
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '角色列表加载失败')
  } finally {
    loading.value = false
  }
}

// ---------- 新建角色 ----------
const createVisible = ref(false)
const createForm = reactive({ roleName: '', description: '' })

function openCreate(): void {
  createForm.roleName = ''
  createForm.description = ''
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!createForm.roleName.trim()) {
    ElMessage.warning('角色名称不能为空')
    return
  }
  try {
    await createRole({ roleName: createForm.roleName.trim(), description: createForm.description.trim() || undefined })
    ElMessage.success('角色创建成功')
    createVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败')
  }
}

// ---------- 启用/禁用 ----------
async function onStatusChange(row: RoleView, status: 0 | 1): Promise<void> {
  try {
    await updateRole(row.id, { status })
    ElMessage.success(status === 1 ? '已启用' : '已禁用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  } finally {
    await loadList() // 失败时以服务端状态回显
  }
}

// ---------- 删除（内置角色无入口） ----------
async function onDelete(row: RoleView): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定删除角色「${row.roleName}」吗？其权限配置与用户绑定将一并清除。`,
    '删除角色',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteRole(row.id)
    ElMessage.success('已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  } finally {
    await loadList()
  }
}

// ---------- 权限树弹窗 ----------
const permVisible = ref(false)
const currentRole = ref<RoleView | null>(null)

function openPermissions(row: RoleView): void {
  currentRole.value = row
  permVisible.value = true
}

onMounted(loadList)
</script>

<template>
  <div class="page roles-page">
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="openCreate">新建角色</el-button>
      </div>

      <el-table v-loading="loading" :data="list" stripe empty-text="暂无角色">
        <el-table-column prop="roleName" label="名称" min-width="140" />
        <el-table-column prop="roleCode" label="角色编码" min-width="180" />
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-switch :model-value="row.status" :active-value="1" :inactive-value="0"
              @change="onStatusChange(row as RoleView, $event as 0 | 1)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openPermissions(row as RoleView)">权限</el-button>
            <el-button v-if="!BUILTIN_ROLE_CODES.includes(row.roleCode)" link type="danger" size="small"
              @click="onDelete(row as RoleView)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="table-footer">
        <el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total"
          layout="prev, pager, next" background @current-change="loadList" />
      </div>
    </el-card>

    <!-- 新建角色 -->
    <el-dialog v-model="createVisible" title="新建角色" width="440">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="角色名称" required>
          <el-input v-model="createForm.roleName" maxlength="50" placeholder="如：测试" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" maxlength="200" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 权限树弹窗 -->
    <PermissionDialog v-model:visible="permVisible" :role="currentRole" />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.table-footer {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
