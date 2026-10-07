<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from './render'

/**
 * markdown 正文只读渲染（ADR-0006）。预览页 / 编辑页 / 审核工作台共用。
 * `source` 是适配层归一后的正文，本组件不感知 Mock 与真实通道的差异。
 */
const props = withDefaults(defineProps<{ source?: string }>(), { source: '' })

const bodyRef = ref<HTMLElement>()
const html = computed(() => renderMarkdown(props.source))
const IMG_BROKEN = '[图片不可用]'

/**
 * MinerU 正文里的图片是带保留期的原始外链（后端 `images` 恒空、图片从不搬到 RustFS），
 * 因此 markdown 里的图必然裂。两个入口都要覆盖：插入时已失败的（complete 且 naturalWidth 为 0）
 * 立即替换；尚未失败的靠挂载时注册的捕获阶段 error 监听 —— error 事件不冒泡，必须捕获。
 */
function replaceBrokenImage(img: HTMLImageElement): void {
  if (img.dataset.broken === '1') return
  img.dataset.broken = '1'
  const span = document.createElement('span')
  span.className = 'md-img-broken'
  span.textContent = IMG_BROKEN
  img.replaceWith(span)
}

function sweepBrokenImages(): void {
  const root = bodyRef.value
  if (!root) return
  root.querySelectorAll('img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) replaceBrokenImage(img)
  })
}

function onImgError(ev: Event): void {
  if (ev.target instanceof HTMLImageElement) replaceBrokenImage(ev.target)
}

onMounted(() => {
  bodyRef.value?.addEventListener('error', onImgError, true)
  void nextTick(sweepBrokenImages)
})

onBeforeUnmount(() => {
  bodyRef.value?.removeEventListener('error', onImgError, true)
})

// 正文变化时 v-html 会重建子节点，重新扫描一遍
watch(html, () => void nextTick(sweepBrokenImages))

/** 代码块「复制」按钮：v-html 内容无法挂 Vue 事件，故在容器上做事件委托 */
function onCopyClick(ev: MouseEvent): void {
  if (!(ev.target instanceof HTMLElement)) return
  const btn = ev.target.closest('.md-code-copy')
  if (!btn) return
  const code = btn.parentElement?.querySelector('code')?.textContent ?? ''
  navigator.clipboard.writeText(code).then(
    () => ElMessage.success('代码已复制'),
    () => ElMessage.error('复制失败，请手动选择'),
  )
}
</script>

<template>
  <div ref="bodyRef" class="md-body" v-html="html" @click="onCopyClick" />
</template>

<style scoped>
/* v-html 注入的节点不带 scope 属性，样式必须走 :deep() */
.md-body {
  font-size: 14px;
  line-height: 1.75;
  color: #303133;
  word-break: break-word;
}

.md-body :deep(> :first-child) {
  margin-top: 0;
}

.md-body :deep(> :last-child) {
  margin-bottom: 0;
}

.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 20px 0 10px;
  font-weight: 600;
  line-height: 1.4;
}

.md-body :deep(h1) {
  font-size: 22px;
}

.md-body :deep(h2) {
  font-size: 19px;
}

.md-body :deep(h3) {
  font-size: 16px;
}

.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  font-size: 14px;
}

.md-body :deep(p) {
  margin: 10px 0;
}

.md-body :deep(a) {
  color: #2a6ee0;
  text-decoration: none;
}

.md-body :deep(a:hover) {
  text-decoration: underline;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 10px 0;
  padding-left: 24px;
}

.md-body :deep(li) {
  margin: 4px 0;
}

.md-body :deep(blockquote) {
  margin: 12px 0;
  padding: 4px 12px;
  border-left: 3px solid #dcdfe6;
  background: #fafafa;
  color: #606266;
}

.md-body :deep(hr) {
  margin: 20px 0;
  border: none;
  border-top: 1px solid #ebeef5;
}

/* 行内代码 */
.md-body :deep(code) {
  padding: 1px 5px;
  background: #f5f6f8;
  border-radius: 3px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  color: #c7254e;
}

/* 代码块（render.ts 自建外壳，无高亮库） */
.md-body :deep(.md-code-block) {
  position: relative;
  margin: 12px 0;
  border-radius: 4px;
  background: #f7f8fa;
  border: 1px solid #ebeef5;
}

.md-body :deep(.md-code-lang) {
  display: inline-block;
  padding: 4px 10px 0;
  font-size: 12px;
  color: #909399;
  font-family: Consolas, Monaco, 'Courier New', monospace;
}

.md-body :deep(.md-code-copy) {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 2px 8px;
  font-size: 12px;
  color: #606266;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 3px;
  cursor: pointer;
}

.md-body :deep(.md-code-copy:hover) {
  color: #2a6ee0;
  border-color: #2a6ee0;
}

.md-body :deep(.md-code) {
  margin: 0;
  padding: 10px 14px;
  overflow-x: auto;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #303133;
  white-space: pre-wrap;
  word-break: break-word;
}

.md-body :deep(.md-code code) {
  padding: 0;
  background: none;
  color: inherit;
  font-size: inherit;
}

/* 表格 */
.md-body :deep(table) {
  width: 100%;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: 13px;
}

.md-body :deep(th),
.md-body :deep(td) {
  padding: 7px 10px;
  border: 1px solid #ebeef5;
  text-align: left;
}

.md-body :deep(th) {
  background: #fafafa;
  font-weight: 600;
}

/* 图片：裂图由脚本替换为占位 */
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 4px;
}

.md-body :deep(.md-img-broken) {
  display: inline-block;
  padding: 1px 6px;
  background: #fdf6ec;
  border: 1px dashed #e6a23c;
  border-radius: 3px;
  font-size: 12px;
  color: #b88230;
}
</style>
