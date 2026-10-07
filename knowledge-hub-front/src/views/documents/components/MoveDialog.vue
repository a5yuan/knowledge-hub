<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { batchDocuments } from '@/api/documents'
import { fetchFolders } from '@/api/folders'
import type { DocZone, Folder } from '@/types/api'

/** 批量移动弹窗：选目标分区 + 文件夹，移动后文档分区归属随目标文件夹变化 */

const props = defineProps<{ ids: string[] }>()
const emit = defineEmits<{ moved: [affected: number] }>()
const visible = defineModel<boolean>('visible', { required: true })

const ZONE_OPTIONS: { value: DocZone; label: string }[] = [
  { value: 'mine', label: '我的文档' },
  { value: 'public', label: '公共文档' },
  { value: 'department', label: '部门文档' },
]

const targetZone = ref<DocZone>('mine')
const folders = ref<Folder[]>([])
const folderId = ref<string>()
const submitting = ref(false)

async function loadFolders(): Promise<void> {
  folderId.value = undefined
  try {
    folders.value = await fetchFolders({ zone: targetZone.value })
  } catch {
    folders.value = []
  }
}

watch(targetZone, loadFolders)
watch(visible, (open) => {
  if (open) {
    targetZone.value = 'mine'
    loadFolders()
  }
})

async function submit(): Promise<void> {
  if (!folderId.value) {
    ElMessage.warning('请选择目标文件夹')
    return
  }
  submitting.value = true
  try {
    const { affected } = await batchDocuments({ action: 'move', ids: props.ids, folderId: folderId.value })
    ElMessage.success(`已移动 ${affected} 个文档`)
    visible.value = false
    emit('moved', affected)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '移动失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="移动到" width="420px" destroy-on-close>
    <el-form label-width="90px" @submit.prevent>
      <el-form-item label="目标分区">
        <el-select v-model="targetZone" style="width: 100%">
          <el-option v-for="z in ZONE_OPTIONS" :key="z.value" :label="z.label" :value="z.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="目标文件夹" required>
        <el-select v-model="folderId" placeholder="选择目标文件夹" style="width: 100%">
          <el-option v-for="f in folders" :key="f.id" :label="f.name" :value="f.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">移动</el-button>
    </template>
  </el-dialog>
</template>
