<script setup lang="ts">
/**
 * 纵向布局容器（catalog: stack）。
 *
 * 存在的意义是让 surface 能表达「编排」：先卡片、后来源，还是反过来。
 * 稀疏到几乎不用写，但它决定了「布局权归 Agent、样式权归设计系统」这条分工能不能成立。
 */
withDefaults(defineProps<{ gap?: number }>(), { gap: 8 })
</script>

<template>
  <div class="stack" :style="{ gap: `${gap}px` }">
    <slot />
  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
}
</style>
