<script setup lang="ts">
import { watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { RefreshLeft, RefreshRight } from '@element-plus/icons-vue'
import { EMPTY_DOC, type EditorJSON } from './json'

/**
 * TipTap 富文本通用封装（ADR-0002：编辑器是长期锁入点，独立组件不与业务页面耦合，便于二期替换）。
 * v-model 即 TipTap JSON；内置基础排版/表格/图片占位工具栏，不含任何业务概念。
 */
/** editable 必须显式默认 true：Vue 3 会把缺失的 Boolean prop cast 成 false，`props.editable ?? true` 救不回来 */
const props = withDefaults(defineProps<{ modelValue?: EditorJSON; editable?: boolean }>(), {
  editable: true,
})
const emit = defineEmits<{ 'update:modelValue': [json: EditorJSON] }>()

const editor = useEditor({
  content: props.modelValue ?? EMPTY_DOC,
  editable: props.editable,
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Image,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ],
  editorProps: { attributes: { class: 'rich-editor-body' } },
  onUpdate: ({ editor }) => emit('update:modelValue', editor.getJSON()),
})

// 只读模式切换（预览页复用本组件做无工具栏渲染）
watch(
  () => props.editable,
  (value) => editor.value?.setEditable(value),
)

// 外部重置内容（如文档异步加载完成）时同步进编辑器；与编辑器当前内容一致时跳过避免光标跳动
watch(
  () => props.modelValue,
  (json) => {
    if (!editor.value || !json) return
    if (JSON.stringify(editor.value.getJSON()) === JSON.stringify(json)) return
    editor.value.commands.setContent(json, false)
  },
)

function insertImage(): void {
  const url = window.prompt('输入图片 URL（一期为占位，不校验可用性）')
  if (!url?.trim()) return
  editor.value?.chain().focus().setImage({ src: url.trim() }).run()
}
</script>

<template>
  <div class="rich-editor">
    <div v-if="editable" class="rich-toolbar">
      <button class="rt-btn" title="撤销" :disabled="!editor?.can().undo()" @click="editor?.chain().focus().undo().run()">
        <el-icon>
          <RefreshLeft />
        </el-icon>
      </button>
      <button class="rt-btn" title="重做" :disabled="!editor?.can().redo()" @click="editor?.chain().focus().redo().run()">
        <el-icon>
          <RefreshRight />
        </el-icon>
      </button>
      <span class="rt-divider" />
      <button class="rt-btn" :class="{ active: editor?.isActive('heading', { level: 1 }) }"
        @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()">H1</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('heading', { level: 2 }) }"
        @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()">H2</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('heading', { level: 3 }) }"
        @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()">H3</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('paragraph') }"
        @click="editor?.chain().focus().setParagraph().run()">正文</button>
      <span class="rt-divider" />
      <button class="rt-btn" :class="{ active: editor?.isActive('bold') }" title="加粗"
        @click="editor?.chain().focus().toggleBold().run()"><b>B</b></button>
      <button class="rt-btn" :class="{ active: editor?.isActive('italic') }" title="斜体"
        @click="editor?.chain().focus().toggleItalic().run()"><i>I</i></button>
      <button class="rt-btn" :class="{ active: editor?.isActive('strike') }" title="删除线"
        @click="editor?.chain().focus().toggleStrike().run()"><s>S</s></button>
      <button class="rt-btn" :class="{ active: editor?.isActive('code') }" title="行内代码"
        @click="editor?.chain().focus().toggleCode().run()">&lt;&gt;</button>
      <span class="rt-divider" />
      <button class="rt-btn" :class="{ active: editor?.isActive('bulletList') }" title="无序列表"
        @click="editor?.chain().focus().toggleBulletList().run()">• 列表</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('orderedList') }" title="有序列表"
        @click="editor?.chain().focus().toggleOrderedList().run()">1. 列表</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('blockquote') }" title="引用"
        @click="editor?.chain().focus().toggleBlockquote().run()">引用</button>
      <button class="rt-btn" :class="{ active: editor?.isActive('codeBlock') }" title="代码块"
        @click="editor?.chain().focus().toggleCodeBlock().run()">代码块</button>
      <button class="rt-btn" title="分隔线" @click="editor?.chain().focus().setHorizontalRule().run()">——</button>
      <span class="rt-divider" />
      <button class="rt-btn" title="插入 3×3 表格"
        @click="editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()">表格</button>
      <button class="rt-btn" title="删除当前表格" :disabled="!editor?.isActive('table')"
        @click="editor?.chain().focus().deleteTable().run()">删表格</button>
      <button class="rt-btn" title="插入图片" @click="insertImage">图片</button>
    </div>
    <EditorContent :editor="editor" class="rich-content" />
  </div>
</template>

<style scoped>
.rich-editor {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  overflow: hidden;
}

.rich-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid #e4e7ed;
  background: #f5f7fa;
}

.rt-btn {
  border: none;
  background: transparent;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  line-height: 1.4;
  color: #303133;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.rt-btn:hover {
  background: #e9ecf1;
}

.rt-btn.active {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.rt-btn:disabled {
  color: #c0c4cc;
  cursor: not-allowed;
}

.rt-divider {
  width: 1px;
  height: 16px;
  background: #dcdfe6;
  margin: 0 4px;
}

.rich-content {
  padding: 16px 20px;
  min-height: 420px;
}

.rich-content :deep(.rich-editor-body) {
  outline: none;
  min-height: 400px;
  font-size: 14px;
  line-height: 1.8;
  color: #303133;
}

.rich-content :deep(.rich-editor-body)>*+* {
  margin-top: 0.8em;
}

.rich-content :deep(.rich-editor-body) h1,
.rich-content :deep(.rich-editor-body) h2,
.rich-content :deep(.rich-editor-body) h3 {
  line-height: 1.4;
}

.rich-content :deep(.rich-editor-body) ul,
.rich-content :deep(.rich-editor-body) ol {
  padding-left: 1.5em;
}

.rich-content :deep(.rich-editor-body) blockquote {
  border-left: 3px solid var(--el-color-primary-light-5);
  padding-left: 12px;
  color: #606266;
}

.rich-content :deep(.rich-editor-body) pre {
  background: #282c34;
  color: #abb2bf;
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
}

.rich-content :deep(.rich-editor-body) code {
  background: #f0f2f5;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 13px;
}

.rich-content :deep(.rich-editor-body) pre code {
  background: transparent;
  padding: 0;
}

.rich-content :deep(.rich-editor-body) table {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  overflow: hidden;
}

.rich-content :deep(.rich-editor-body) th,
.rich-content :deep(.rich-editor-body) td {
  border: 1px solid #dcdfe6;
  padding: 6px 10px;
  vertical-align: top;
  position: relative;
}

.rich-content :deep(.rich-editor-body) th {
  background: #f5f7fa;
  font-weight: 600;
  text-align: left;
}

.rich-content :deep(.rich-editor-body) img {
  max-width: 100%;
  border: 1px dashed #c0c4cc;
}

.rich-content :deep(.rich-editor-body) .selectedCell:after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(26 102 255 / 8%);
  pointer-events: none;
}
</style>
