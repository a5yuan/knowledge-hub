<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { createDocument, updateDocument, type DocumentWithOwner } from '@/api/documents'
import type { DocZone } from '@/types/api'
import DocMetaFields, { type MetaForm } from './DocMetaFields.vue'

/**
 * 新建在线文档 / 编辑元信息 双模式弹窗。
 * create：建空 JSON 在线文档后由父组件跳编辑器（编辑器本体在工单 06）；
 * edit：仅更新元信息，内容编辑也在 06。
 */

const props = defineProps<{
  zone: DocZone
  mode: 'create' | 'edit'
  doc?: DocumentWithOwner | null
}>()
const emit = defineEmits<{ created: [doc: DocumentWithOwner]; saved: [] }>()
const visible = defineModel<boolean>('visible', { required: true })

const fieldsRef = ref<InstanceType<typeof DocMetaFields>>()
const formRef = ref<FormInstance>()
const submitting = ref(false)

/** el-form 校验依赖 :model，故 title 与元信息合并为同一响应式对象 */
interface DialogForm extends MetaForm {
  title: string
}
const form = reactive<DialogForm>({ title: '', categoryId: '', tagIds: [], visibility: 'private', folderId: null })

const rules: FormRules = {
  title: [{ required: true, message: '请输入文档标题', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请选择文档分类', trigger: 'change' }],
}

watch(visible, (open) => {
  if (!open) return
  const isEdit = props.mode === 'edit' && props.doc
  Object.assign(
    form,
    isEdit
      ? {
        title: props.doc!.title,
        categoryId: props.doc!.categoryId,
        tagIds: [...props.doc!.tagIds],
        visibility: props.doc!.visibility,
        folderId: props.doc!.folderId,
      }
      : { title: '', categoryId: '', tagIds: [], visibility: 'private', folderId: null },
  )
  formRef.value?.clearValidate()
})

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const tagIds = (await fieldsRef.value?.resolveTagIds()) ?? []
    if (props.mode === 'create') {
      const doc = await createDocument({
        title: form.title.trim(),
        type: 'online',
        categoryId: form.categoryId,
        tagIds,
        visibility: form.visibility,
        zone: props.zone,
        folderId: form.folderId,
      })
      ElMessage.success('在线文档已创建')
      visible.value = false
      emit('created', doc)
    } else {
      await updateDocument(props.doc!.id, {
        title: form.title.trim(),
        categoryId: form.categoryId,
        tagIds,
        visibility: form.visibility,
        folderId: form.folderId,
      })
      ElMessage.success('文档信息已更新')
      visible.value = false
      emit('saved')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="mode === 'create' ? '新建在线文档' : '编辑文档信息'" width="520px" destroy-on-close>
    <el-form ref="formRef" label-width="90px" :model="form" :rules="rules" @submit.prevent>
      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" maxlength="80" show-word-limit placeholder="请输入文档标题" />
      </el-form-item>
      <el-form-item v-if="mode === 'create'" label="类型">
        <el-tag effect="plain">在线文档</el-tag>
        <span class="type-hint">创建后进入编辑器撰写内容</span>
      </el-form-item>
      <DocMetaFields ref="fieldsRef" v-model="form" :zone="zone" />
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ mode === 'create' ? '创建并编辑' : '保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.type-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}
</style>
