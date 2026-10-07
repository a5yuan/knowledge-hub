<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ElTree } from 'element-plus'
import {
  fetchPermissionTree,
  fetchRolePermissionIds,
  assignRolePermissions,
  type PermissionTreeNode,
} from '@/api/roles'
import type { RoleView } from '@/api/roles'

/**
 * 角色授权弹窗（权限模型控制工单）：复刻原型图，权限树勾选保存。
 * 树节点文案 = 权限名称 (权限编码)；父子级联勾选；
 * 回显只 set 叶子节点（级联模式下父节点勾选态由子节点推导，避免父 id 连带全勾）；
 * 保存提交 勾选 ∪ 半选（父菜单必存，与后端菜单树祖先链逻辑对齐）。
 */
const props = defineProps<{ role: RoleView | null }>()
const visible = defineModel<boolean>('visible', { required: true })

const treeRef = ref<InstanceType<typeof ElTree>>()
const treeData = ref<PermissionTreeNode[]>([])
const loading = ref(false)
const saving = ref(false)

/** 收集所有含子节点的父节点 id（用于回显时过滤，仅保留叶子） */
function collectParentIds(nodes: PermissionTreeNode[], into = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.children.length > 0) {
      into.add(n.id)
      collectParentIds(n.children, into)
    }
  }
  return into
}

watch(visible, async (open) => {
  if (!open || !props.role) return
  loading.value = true
  try {
    const [tree, checkedIds] = await Promise.all([
      fetchPermissionTree(),
      fetchRolePermissionIds(props.role.id),
    ])
    treeData.value = tree
    await nextTick() // destroy-on-close 重建树后才有 treeRef
    const parents = collectParentIds(tree)
    treeRef.value?.setCheckedKeys(checkedIds.filter((id) => !parents.has(id)))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '权限树加载失败')
  } finally {
    loading.value = false
  }
})

async function submit(): Promise<void> {
  if (!props.role) return
  saving.value = true
  try {
    const checked = (treeRef.value?.getCheckedKeys() ?? []).map(String)
    const halfChecked = (treeRef.value?.getHalfCheckedKeys() ?? []).map(String)
    await assignRolePermissions(props.role.id, [...checked, ...halfChecked])
    ElMessage.success('权限已保存')
    visible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="`权限：${role?.roleName ?? ''}`" width="800px" destroy-on-close>
    <el-tree v-loading="loading" ref="treeRef" :data="treeData" node-key="id" show-checkbox default-expand-all
      :props="{ children: 'children' }">
      <template #default="{ data }">
        <span class="tree-node-label">{{ (data as PermissionTreeNode).permissionName }} ({{ (data as
          PermissionTreeNode).permissionCode }})</span>
      </template>
    </el-tree>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tree-node-label {
  font-size: 14px;
}
</style>
