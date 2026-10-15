<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { OfficeBuilding, Plus } from '@element-plus/icons-vue'
import {
  createDepartment,
  deleteDepartment,
  fetchDepartmentTree,
  updateDepartment,
} from '@/api/departments'
import type { DepartmentNode } from '@/types/api'

/**
 * 系统管理-组织架构（18 号工单）。
 *
 * 后端 `/department` 已就绪：读接口仅需登录，写接口挂 `org:manage`（Admin 经 PermissionsGuard 旁路）。
 * 本页是 `org:manage` 权限码的唯一挂载点 —— 没有它，部门只能靠 SQL 维护。
 *
 * 层级约束：后端硬限 3 层（超层返回 400「部门层级不得超过 3 层」），前端按同一口径**提前禁用**
 * 「新增子部门」按钮，避免用户点了才被拒。
 *
 * 已知不支持：后端 `PATCH /department/:id` 刻意不接受 `parent_id`（移动子树需另开工单），
 * 故编辑弹窗里「上级部门」是只读展示。
 */

const MAX_DEPTH = 3

const loading = ref(false)
const tree = ref<DepartmentNode[]>([])
/** 打平后的节点列表（供上级部门下拉与层级计算使用） */
const flat = ref<DepartmentNode[]>([])

function flatten(nodes: DepartmentNode[]): DepartmentNode[] {
  const out: DepartmentNode[] = []
  const walk = (list: DepartmentNode[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** id → 层级（根 = 1），用于「层级」列展示与超层按钮禁用 */
const depthById = computed(() => {
  const byId = new Map(flat.value.map((n) => [n.id, n]))
  const map = new Map<string, number>()
  for (const node of flat.value) {
    let depth = 1
    let cursor: DepartmentNode | undefined = node
    // 防御上限：脏数据成环时不死循环
    while (cursor?.parentId && depth < 32) {
      cursor = byId.get(cursor.parentId)
      if (!cursor) break
      depth += 1
    }
    map.set(node.id, depth)
  }
  return map
})

async function load(): Promise<void> {
  loading.value = true
  try {
    // all=true：管理页必须看到禁用部门，否则禁用后再也无法启用
    tree.value = await fetchDepartmentTree({ all: true })
    flat.value = flatten(tree.value)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '组织架构加载失败')
    tree.value = []
    flat.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

// ---------- 新建 / 编辑 ----------
const dialogVisible = ref(false)
const isEdit = ref(false)
const editingId = ref('')
const form = reactive({
  name: '',
  code: '',
  parentId: '' as string,
  sort: 0,
  enabled: true,
})

/** 上级部门下拉：打平 + 按层级缩进，根级用空串表示 */
const parentOptions = computed(() =>
  flat.value.map((n) => ({
    id: n.id,
    label: `${'　'.repeat(Math.max(0, (depthById.value.get(n.id) ?? 1) - 1))}${n.name}`,
  })),
)

const editingNode = computed(() => flat.value.find((n) => n.id === editingId.value) ?? null)

function openCreateRoot(): void {
  isEdit.value = false
  editingId.value = ''
  form.name = ''
  form.code = ''
  form.parentId = ''
  form.sort = 0
  form.enabled = true
  dialogVisible.value = true
}

function openCreateChild(parentId: string): void {
  openCreateRoot()
  form.parentId = parentId
}

/** el-table 行插槽的类型是宽泛的 Record<PropertyKey, any>，故插槽只传 id，节点统一按 id 从打平列表取 */
function findNode(id: string): DepartmentNode | null {
  return flat.value.find((n) => n.id === id) ?? null
}

function openEdit(id: string): void {
  const node = findNode(id)
  if (!node) return
  isEdit.value = true
  editingId.value = node.id
  form.name = node.name
  form.code = node.code ?? ''
  form.parentId = node.parentId ?? ''
  form.sort = node.sort
  form.enabled = node.enabled
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('部门名称不能为空')
    return
  }
  try {
    if (isEdit.value) {
      await updateDepartment(editingId.value, {
        name,
        code: form.code.trim() || null,
        sort: form.sort,
        enabled: form.enabled,
      })
      ElMessage.success('部门已更新')
    } else {
      await createDepartment({
        name,
        code: form.code.trim() || undefined,
        parentId: form.parentId || null,
        sort: form.sort,
      })
      ElMessage.success('部门已创建')
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    // 后端中文提示直接透出：层级超限 / 重名 / 父部门不存在
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function onDelete(id: string): Promise<void> {
  const node = findNode(id)
  if (!node) return
  try {
    await ElMessageBox.confirm(`确定删除部门「${node.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return // 用户取消
  }
  try {
    await deleteDepartment(id)
    ElMessage.success('部门已删除')
    await load()
  } catch (error) {
    // 有子部门 / 有用户归属时后端返回 400 + 中文原因
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}
</script>

<template>
  <div class="page org-page">
    <h2 class="page-title">组织架构</h2>

    <el-card shadow="never">
      <div class="toolbar">
        <span class="toolbar-tip">最多 {{ MAX_DEPTH }} 层；有子部门或仍有用户归属的部门不可删除。</span>
        <div class="toolbar-spacer" />
        <el-button v-permission="'org:manage'" type="primary" :icon="Plus" @click="openCreateRoot">新建根部门</el-button>
        <el-button :icon="OfficeBuilding" @click="load">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="tree" row-key="id" default-expand-all
        :tree-props="{ children: 'children' }" :indent="20" style="width: 100%">
        <el-table-column prop="name" label="部门名称" min-width="220" />
        <el-table-column prop="code" label="部门编码" width="140">
          <template #default="{ row }">
            <span v-if="row.code">{{ row.code }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="层级" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="(depthById.get(row.id) ?? 1) >= MAX_DEPTH ? 'warning' : 'info'" effect="plain">
              {{ depthById.get(row.id) ?? 1 }} / {{ MAX_DEPTH }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sort" label="排序" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.enabled ? 'success' : 'info'">
              {{ row.enabled ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-tooltip :disabled="(depthById.get(row.id) ?? 1) < MAX_DEPTH"
              :content="`已达 ${MAX_DEPTH} 层上限，无法再建子部门`" placement="top">
              <span>
                <el-button v-permission="'org:manage'" link type="primary" size="small"
                  :disabled="(depthById.get(row.id) ?? 1) >= MAX_DEPTH" @click="openCreateChild(row.id)">
                  新增子部门
                </el-button>
              </span>
            </el-tooltip>
            <el-button v-permission="'org:manage'" link type="primary" size="small" @click="openEdit(row.id)">编辑</el-button>
            <el-button v-permission="'org:manage'" link type="danger" size="small" @click="onDelete(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑部门' : '新建部门'" width="480px">
      <el-form label-width="90px">
        <el-form-item label="部门名称" required>
          <el-input v-model="form.name" placeholder="请输入部门名称" maxlength="50" />
        </el-form-item>
        <el-form-item label="部门编码">
          <el-input v-model="form.code" placeholder="可选，如 RD" maxlength="50" />
        </el-form-item>
        <el-form-item label="上级部门">
          <template v-if="isEdit">
            <span class="readonly-value">{{ editingNode?.parentId ? editingNode.parentId : '（根级）' }}</span>
            <div class="form-hint">后端暂不支持调整上级部门（移动子树需另开工单）</div>
          </template>
          <el-select v-else v-model="form.parentId" placeholder="不选则为根部门" clearable style="width: 100%">
            <el-option v-for="opt in parentOptions" :key="opt.id" :label="opt.label" :value="opt.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item v-if="isEdit" label="状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="禁用" />
        </el-form-item>
        <div class="form-hint">层级限制：根部门为第 1 层，最深 {{ MAX_DEPTH }} 层。</div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">确定</el-button>
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

.toolbar-tip {
  font-size: 13px;
  color: #909399;
}

.muted {
  color: #c0c4cc;
}

.readonly-value {
  color: #606266;
}

.form-hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
</style>
