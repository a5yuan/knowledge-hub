<script setup lang="ts">
/**
 * surface 渲染入口：从 root 开始递归。所有容错都在后端校验层做完了，
 * 这里只兜一种情况——某个组件渲染时抛错，用 errorCaptured 拦住，整块不显示，
 * 保证「少一块内容」而不是「整页崩掉」。
 */
import { onErrorCaptured, ref } from 'vue'
import type { Surface } from '@/api/ai'
import SurfaceNode from './SurfaceNode.vue'

defineProps<{ surface: Surface }>()

/** 组件渲染异常标记：置位后整块 surface 不渲染，正文照常显示 */
const broken = ref(false)

onErrorCaptured((err) => {
  broken.value = true
  console.warn('[surface] 渲染异常，已跳过该区块', err)
  // 返回 false 阻止错误继续冒泡到全局，避免影响整个对话区
  return false
})
</script>

<template>
  <div v-if="!broken && surface && surface.root in surface.nodes" class="surface">
    <SurfaceNode :surface="surface" :node-id="surface.root" />
  </div>
</template>

<style scoped>
.surface {
  margin-top: 10px;
}
</style>
