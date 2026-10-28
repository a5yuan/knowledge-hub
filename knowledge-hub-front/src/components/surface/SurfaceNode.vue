<script setup lang="ts">
/**
 * 递归渲染单个 surface 节点。
 *
 * 三步：拿 id → 在 surface.nodes 里查 → 用 type 去 registry 查组件 → 渲染并把 children 递归下去。
 * children 是「谁装在我里面」，用 slot 透传给容器组件；非容器组件没有 <slot />，多传无害。
 *
 * 自引用（模板里的 <SurfaceNode> 指向自身）是 Vue SFC 的官方支持能力，不需要手动注册。
 */
import { computed } from 'vue'
import type { Surface } from '@/api/ai'
import { resolveComponent } from './registry'

const props = withDefaults(
  defineProps<{
    surface: Surface
    /** 当前要渲染的节点 id */
    nodeId: string
    /** 递归深度，用于兜底限流（后端已校验过，这里只防极端情况炸栈） */
    depth?: number
  }>(),
  { depth: 0 },
)

/** 与后端 surface.ts 的 maxDepth 保持一致 */
const MAX_DEPTH = 8

const node = computed(() => props.surface.nodes[props.nodeId])
/** 查表查不到（catalog 外组件）→ undefined，整块不渲染 */
const component = computed(() => (node.value ? resolveComponent(node.value.type) : undefined))
const childIds = computed(() => node.value?.children ?? [])
const resolvedProps = computed(() => node.value?.props ?? {})
</script>

<template>
  <component
    :is="component"
    v-if="component && depth <= MAX_DEPTH"
    v-bind="resolvedProps"
  >
    <SurfaceNode
      v-for="childId in childIds"
      :key="childId"
      :surface="surface"
      :node-id="childId"
      :depth="depth + 1"
    />
  </component>
</template>
