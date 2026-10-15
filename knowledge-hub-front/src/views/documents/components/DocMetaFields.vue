<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fetchCategories } from '@/api/categories'
import { fetchFolders } from '@/api/folders'
import { createTag, fetchTags } from '@/api/tags'
import { isRealResource } from '@/api/endpoint'
import type { Category, DocZone, Folder, Tag, Visibility } from '@/types/api'

/** 新建在线文档 / 编辑元信息 / 批量上传共用的元信息字段（分类/标签/可见范围/文件夹） */

export interface MetaForm {
  categoryId: string
  tagIds: string[]
  visibility: Visibility
  folderId: string | null
}

const props = defineProps<{ zone: DocZone }>()
const form = defineModel<MetaForm>({ required: true })

const categories = ref<Category[]>([])
const tags = ref<Tag[]>([])
const folders = ref<Folder[]>([])

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'company', label: '公司可见' },
  { value: 'department', label: '部门可见' },
  { value: 'private', label: '仅本人可见' },
]

/**
 * ⚠️ 「部门可见」在真实模式下**依然隐藏**（18 号工单核实后维持工单 05 的判断）。
 *
 * 18 号工单原本认为补上「用户→部门」映射即可恢复本选项，但实测确认真正的阻碍不是部门数据源，
 * 而是 **kh_document 根本没有 visibility 列**（只有 is_public boolean），且
 * `es/visibility-scope.ts` 的可见性规则里也没有「已发布 + 本部门可见」这一条。
 *
 * 因此若在真实模式放开该选项，用户选「部门可见」后写入会被静默丢弃（见 api/documents.ts 的
 * `meta.visibility !== 'department'` 守卫），列表回显成「仅本人可见」——**这是误导性 UI，比隐藏更差**。
 * 恢复它需要新开工单：加 `kh_document.visibility` 列 + PG/ES 两侧补「同部门已发布可见」规则。
 * 缺口已登记在 backend-todo.md §2.4b。
 */
const realMode = computed(() => isRealResource('documents'))
const visibleVisibilityOptions = computed(() =>
  VISIBILITY_OPTIONS.filter((o) => o.value !== 'department' || !realMode.value),
)

async function loadFolders(): Promise<void> {
  try {
    folders.value = await fetchFolders({ zone: props.zone })
  } catch {
    folders.value = []
  }
}

onMounted(async () => {
  loadFolders()
  try {
    const [cats, tgs] = await Promise.all([fetchCategories(), fetchTags()])
    categories.value = cats
    tags.value = tgs
  } catch {
    /* 下拉为空即可，不阻塞弹窗 */
  }
})

watch(() => props.zone, loadFolders)

/** 提交前调用：allow-create 产生的标签名先落库换取 id，已有 id 原样返回 */
async function resolveTagIds(): Promise<string[]> {
  const out: string[] = []
  for (const value of form.value.tagIds) {
    if (tags.value.some((t) => t.id === value)) {
      out.push(value)
      continue
    }
    const created = await createTag(value)
    tags.value.push(created)
    out.push(created.id)
  }
  return out
}

defineExpose({ resolveTagIds })
</script>

<template>
  <el-form-item label="分类" prop="categoryId" required>
    <el-select v-model="form.categoryId" placeholder="选择文档分类" style="width: 100%">
      <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
    </el-select>
  </el-form-item>
  <el-form-item label="标签">
    <el-select v-model="form.tagIds" multiple filterable allow-create default-first-option placeholder="选择已有标签或输入新标签"
      style="width: 100%">
      <el-option v-for="t in tags" :key="t.id" :label="t.name" :value="t.id" />
    </el-select>
  </el-form-item>
  <el-form-item label="可见范围" prop="visibility" required>
    <el-radio-group v-model="form.visibility">
      <el-radio v-for="opt in visibleVisibilityOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
    </el-radio-group>
  </el-form-item>
  <el-form-item label="所属文件夹">
    <el-select v-model="form.folderId" clearable placeholder="不选择则归入分区根" style="width: 100%">
      <el-option v-for="f in folders" :key="f.id" :label="f.name" :value="f.id" />
    </el-select>
  </el-form-item>
</template>
