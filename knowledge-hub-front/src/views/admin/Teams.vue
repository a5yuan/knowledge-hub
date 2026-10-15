<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, UserFilled } from '@element-plus/icons-vue'
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  fetchTeamMembers,
  fetchTeams,
  removeTeamMember,
  updateMemberRole,
  updateTeam,
  type TeamMemberRole,
  type TeamMemberView,
  type TeamView,
} from '@/api/team'
import { useUserStore } from '@/stores/user'

/**
 * 系统管理-团队管理（15 号工单）：后端 `/team` 接口组已就绪，本页为纯前端接入。
 *
 * 权限：team:create / team:edit / team:delete / team:member（v-permission 控制渲染）。
 * 注意 team:delete 在 init.sql 中未授权任何角色 —— 仅 Admin 旁路可删，非 Admin 看不到删除按钮。
 */
const userStore = useUserStore()

const loading = ref(false)
const list = ref<TeamView[]>([])
const total = ref(0)
const query = reactive({ page: 1, pageSize: 10, name: '' })
const statusFilter = ref<number | undefined>(undefined)

/** 全量团队（供父团队选择器与上级团队列展示；演示规模下一次性拉取） */
const allTeams = ref<TeamView[]>([])

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const result = await fetchTeams({
      name: query.name.trim() || undefined,
      status: statusFilter.value,
      page: query.page,
      pageSize: query.pageSize,
    })
    list.value = result.list
    total.value = result.total
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '团队列表加载失败')
  } finally {
    loading.value = false
  }
}

async function loadAllTeams(): Promise<void> {
  try {
    const result = await fetchTeams({ pageSize: 100 })
    allTeams.value = result.list
  } catch {
    // 父团队选择器数据源失败不阻塞主流程
    allTeams.value = []
  }
}

function onSearch(): void {
  query.page = 1
  void loadList()
}

function onReset(): void {
  query.name = ''
  statusFilter.value = undefined
  query.page = 1
  void loadList()
}

function parentName(parentId: string | null): string {
  if (!parentId) return '顶级团队'
  return allTeams.value.find((t) => t.id === parentId)?.name ?? '—'
}

// ---------- 新建 / 编辑 ----------
const formVisible = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  code: '',
  description: '',
  parentId: null as string | null,
  sort: 0,
})

const isEdit = computed(() => editingId.value !== null)

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.code = ''
  form.description = ''
  form.parentId = null
  form.sort = 0
  formVisible.value = true
}

function openEdit(row: TeamView): void {
  editingId.value = row.id
  form.name = row.name
  form.code = row.code ?? ''
  form.description = row.description ?? ''
  form.parentId = row.parentId
  form.sort = row.sort
  formVisible.value = true
}

/**
 * 父团队候选：排除自身及其全部后代。
 * 后端对 parent_id 成环无校验，必须由前端过滤 —— 否则会把团队挂成自己的子孙，层级渲染直接错乱。
 */
const parentOptions = computed(() => {
  const selfId = editingId.value
  if (!selfId) return allTeams.value

  const banned = new Set<string>([selfId])
  // 迭代展开后代：每轮把「父已在禁用集」的节点也加入禁用集，直到不再新增
  let frontier = [selfId]
  while (frontier.length) {
    const next: string[] = []
    for (const t of allTeams.value) {
      if (t.parentId && frontier.includes(t.parentId) && !banned.has(t.id)) {
        banned.add(t.id)
        next.push(t.id)
      }
    }
    frontier = next
  }
  return allTeams.value.filter((t) => !banned.has(t.id))
})

async function submitForm(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('团队名称不能为空')
    return
  }
  const payload = {
    name: form.name.trim(),
    code: form.code.trim() || null,
    description: form.description.trim() || null,
    parentId: form.parentId,
    sort: form.sort,
  }
  try {
    if (editingId.value) {
      await updateTeam(editingId.value, payload)
      ElMessage.success('团队已更新')
    } else {
      await createTeam(payload)
      ElMessage.success('团队创建成功')
    }
    formVisible.value = false
    await loadList()
    await loadAllTeams()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// ---------- 删除 ----------
async function onDelete(row: TeamView): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定删除团队「${row.name}」吗？该操作不可恢复。`,
    '删除团队',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteTeam(row.id)
    ElMessage.success('已删除')
    if (activeTeam.value?.id === row.id) activeTeam.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  } finally {
    await loadList()
    await loadAllTeams()
  }
}

// ---------- 成员管理 ----------
const activeTeam = ref<TeamView | null>(null)
const members = ref<TeamMemberView[]>([])
const membersLoading = ref(false)

async function openMembers(row: TeamView): Promise<void> {
  activeTeam.value = row
  await loadMembers(row.id)
}

async function loadMembers(teamId: string): Promise<void> {
  membersLoading.value = true
  try {
    members.value = await fetchTeamMembers(teamId)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '成员列表加载失败')
    members.value = []
  } finally {
    membersLoading.value = false
  }
}

const memberVisible = ref(false)
const memberForm = reactive({ userId: '' })

function openAddMember(): void {
  memberForm.userId = ''
  memberVisible.value = true
}

async function submitAddMember(): Promise<void> {
  if (!activeTeam.value) return
  const uid = memberForm.userId.trim()
  if (!uid) {
    ElMessage.warning('请填写用户 ID')
    return
  }
  try {
    await addTeamMember(activeTeam.value.id, { userId: uid })
    ElMessage.success('成员已添加')
    memberVisible.value = false
    await loadMembers(activeTeam.value.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '添加失败')
  }
}

async function onMemberRoleChange(member: TeamMemberView, role: TeamMemberRole): Promise<void> {
  if (!activeTeam.value) return
  try {
    await updateMemberRole(activeTeam.value.id, member.userId, role)
    ElMessage.success('角色已更新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新失败')
  } finally {
    await loadMembers(activeTeam.value.id)
  }
}

async function onRemoveMember(member: TeamMemberView): Promise<void> {
  if (!activeTeam.value) return
  const confirmed = await ElMessageBox.confirm(
    `确定将「${member.realName || member.username}」移出该团队吗？`,
    '移除成员',
    { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await removeTeamMember(activeTeam.value.id, member.userId)
    ElMessage.success('成员已移除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '移除失败')
  } finally {
    await loadMembers(activeTeam.value.id)
  }
}

onMounted(() => {
  void loadList()
  void loadAllTeams()
})
</script>

<template>
  <div class="page teams-page">
    <el-card shadow="never">
      <div class="toolbar">
        <el-input v-model="query.name" placeholder="搜索团队名称" clearable class="toolbar-item" style="width: 200px"
          @keyup.enter="onSearch" @clear="onSearch" />
        <el-select v-model="statusFilter" placeholder="状态" clearable class="toolbar-item" style="width: 120px"
          @change="onSearch">
          <el-option label="启用" :value="1" />
          <el-option label="禁用" :value="0" />
        </el-select>
        <el-button type="primary" @click="onSearch">查询</el-button>
        <el-button @click="onReset">重置</el-button>
        <div class="toolbar-spacer" />
        <el-button v-permission="'team:create'" type="primary" :icon="Plus" @click="openCreate">新建团队</el-button>
      </div>

      <el-table v-loading="loading" :data="list" stripe empty-text="暂无团队">
        <el-table-column prop="name" label="团队名称" min-width="160" />
        <el-table-column label="团队编码" min-width="140">
          <template #default="{ row }">{{ row.code || '—' }}</template>
        </el-table-column>
        <el-table-column label="描述" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.description || '—' }}</template>
        </el-table-column>
        <el-table-column label="上级团队" min-width="140">
          <template #default="{ row }">{{ parentName(row.parentId) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" effect="light" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openMembers(row as TeamView)">成员</el-button>
            <el-button v-permission="'team:edit'" link type="primary" size="small"
              @click="openEdit(row as TeamView)">编辑</el-button>
            <el-button v-permission="'team:delete'" link type="danger" size="small"
              @click="onDelete(row as TeamView)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
          layout="total, prev, pager, next" background @current-change="loadList" />
      </div>
    </el-card>

    <!-- 成员管理：选中团队后展开 -->
    <el-card v-if="activeTeam" shadow="never" class="member-card">
      <template #header>
        <div class="member-head">
          <span class="member-title">
            <el-icon><UserFilled /></el-icon>
            成员管理 · {{ activeTeam.name }}
          </span>
          <div>
            <el-button v-permission="'team:member'" type="primary" size="small" :icon="Plus"
              @click="openAddMember">添加成员</el-button>
            <el-button link size="small" @click="activeTeam = null">收起</el-button>
          </div>
        </div>
      </template>

      <el-table v-loading="membersLoading" :data="members" stripe empty-text="该团队暂无成员">
        <el-table-column prop="username" label="用户名" min-width="140" />
        <el-table-column label="真实姓名" min-width="140">
          <template #default="{ row }">{{ row.realName || '—' }}</template>
        </el-table-column>
        <el-table-column label="角色" width="170">
          <template #default="{ row }">
            <el-select v-if="userStore.hasPermission('team:member')" :model-value="row.memberRole" size="small"
              @change="onMemberRoleChange(row as TeamMemberView, $event as TeamMemberRole)">
              <el-option label="负责人" value="leader" />
              <el-option label="成员" value="member" />
            </el-select>
            <el-tag v-else :type="row.memberRole === 'leader' ? 'warning' : 'info'" effect="light" size="small">
              {{ row.memberRole === 'leader' ? '负责人' : '成员' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button v-permission="'team:member'" link type="danger" size="small"
              @click="onRemoveMember(row as TeamMemberView)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建 / 编辑团队 -->
    <el-dialog v-model="formVisible" :title="isEdit ? '编辑团队' : '新建团队'" width="520px">
      <el-form label-width="90px">
        <el-form-item label="团队名称" required>
          <el-input v-model="form.name" placeholder="请输入团队名称" maxlength="100" />
        </el-form-item>
        <el-form-item label="团队编码">
          <el-input v-model="form.code" placeholder="可选，如 BACKEND_TEAM" maxlength="50" />
        </el-form-item>
        <el-form-item label="上级团队">
          <el-select v-model="form.parentId" placeholder="不选则为顶级团队" clearable style="width: 100%">
            <el-option v-for="t in parentOptions" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- 添加成员 -->
    <el-dialog v-model="memberVisible" title="添加成员" width="460px">
      <el-form label-width="80px">
        <el-form-item label="用户 ID" required>
          <el-input v-model="memberForm.userId" placeholder="请输入用户 ID（雪花 ID 字符串）" />
        </el-form-item>
        <div class="form-hint">提示：用户选择器待「用户与部门」模块接通后提供。</div>
      </el-form>
      <template #footer>
        <el-button @click="memberVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAddMember">确定</el-button>
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

.toolbar-spacer {
  flex: 1;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.member-card {
  margin-top: 16px;
}

.member-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.member-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

.form-hint {
  padding-left: 80px;
  font-size: 12px;
  color: #909399;
}
</style>
