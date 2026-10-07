<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, type UploadUserFile } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { uploadDocuments } from '@/api/documents'
import { useUserStore } from '@/stores/user'
import type { DocZone, Visibility } from '@/types/api'
import DocMetaFields, { type MetaForm } from './DocMetaFields.vue'

/**
 * 批量上传弹窗：拖拽/多选文件 + 统一元信息。
 * 真实通道：N 次单文件请求 + 补偿 PATCH；失败项（超限/格式不支持/补写失败）单独呈现（工单 03）。
 */

const props = defineProps<{ zone: DocZone; folderId?: string }>()
const emit = defineEmits<{ uploaded: [count: number] }>()
const visible = defineModel<boolean>('visible', { required: true })
const userStore = useUserStore()

const fieldsRef = ref<InstanceType<typeof DocMetaFields>>()
const fileList = ref<UploadUserFile[]>([])
const submitting = ref(false)
const failedItems = ref<{ name: string; message: string }[]>([])

const meta = ref<MetaForm>({ categoryId: '', tagIds: [], visibility: 'private', folderId: null })

watch(visible, (open) => {
  if (!open) return
  fileList.value = []
  failedItems.value = []
  const defaultVisibility: Record<DocZone, Visibility> = {
    mine: 'private',
    department: 'department',
    public: 'company',
    archive: 'private',
  }
  meta.value = {
    categoryId: '',
    tagIds: [],
    visibility: defaultVisibility[props.zone],
    folderId: props.folderId ?? null,
  }
})

async function submit(): Promise<void> {
  const files: File[] = []
  fileList.value.forEach((f) => {
    if (f.raw instanceof File) files.push(f.raw)
  })
  if (files.length === 0) {
    ElMessage.warning('请先选择要上传的文件')
    return
  }
  if (!meta.value.categoryId) {
    ElMessage.warning('请选择文档分类')
    return
  }
  submitting.value = true
  failedItems.value = []
  try {
    const tagIds = (await fieldsRef.value?.resolveTagIds()) ?? []
    const { items, failed } = await uploadDocuments(
      files,
      { ...meta.value, tagIds, zone: props.zone },
      userStore.user?.id ?? '',
    )
    failedItems.value = failed
    if (items.length > 0) {
      const suffix = failed.length > 0 ? `，${failed.length} 个失败` : ''
      ElMessage.success(`已上传 ${items.length} 个文件，解析任务已启动${suffix}`)
      visible.value = false
      emit('uploaded', files.length)
    } else if (failed.length > 0) {
      ElMessage.error(`全部上传失败：${failed[0].message}`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '上传失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="批量上传" width="560px" destroy-on-close>
    <el-form label-width="90px" @submit.prevent>
      <el-form-item label="选择文件" required>
        <el-upload v-model:file-list="fileList" drag multiple :auto-upload="false"
          accept=".pdf,.docx,.xlsx,.pptx,.md,.txt">
          <el-icon :size="40" class="upload-icon">
            <UploadFilled />
          </el-icon>
          <div class="el-upload__text">将文件拖到此处，或<em>点击选择</em></div>
          <template #tip>
            <div class="el-upload__tip">支持 PDF / DOCX / XLSX / PPTX / MD / TXT，单个 ≤ 10MB，可多选；上传后自动开始解析</div>
          </template>
        </el-upload>
      </el-form-item>
      <DocMetaFields ref="fieldsRef" v-model="meta" :zone="zone" />
    </el-form>
    <el-alert v-if="failedItems.length > 0" type="error" :closable="false" class="failed-alert">
      <div v-for="f in failedItems" :key="f.name" class="failed-item">
        <b>{{ f.name }}</b>：{{ f.message }}
      </div>
    </el-alert>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">开始上传</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.upload-icon {
  color: var(--el-color-primary);
  margin-bottom: 8px;
}

.failed-alert {
  margin-top: 8px;
}

.failed-item + .failed-item {
  margin-top: 4px;
}
</style>
