/**
 * surface 组件注册表：`type` → Vue 组件的唯一映射。
 *
 * 这是渲染侧的**安全边界**——`<component :is>` 拿到的永远是这里显式 import 过的组件，
 * 不存在「用字符串动态解析任意组件」的路径。模型在 surface 里编一个不存在的 type，
 * 查表查不到，整块不渲染（v-if 已处理），不会白屏也不会报错。
 *
 * 新增组件的第 2 步（第 1 步是后端 catalog 加一条）：在这里加一行映射。事件类型、
 * 渲染分支、父组件的 switch 全都不用动——这就是抽 surface 这层要换来的东西。
 */
import type { Component } from 'vue'
import StackLayout from '@/components/layout/StackLayout.vue'
import KnowledgeCards from '@/components/cards/KnowledgeCards.vue'
import WebLinks from '@/components/cards/WebLinks.vue'
import SourceList from '@/components/cards/SourceList.vue'
import MemoryChips from '@/components/cards/MemoryChips.vue'
import GraphMini from '@/components/cards/GraphMini.vue'
import MarkdownView from '@/components/markdown/MarkdownView.vue'

/** 组件目录：key 必须与后端 catalog.ts 的 key 一一对应 */
export const REGISTRY: Record<string, Component> = {
  stack: StackLayout,
  knowledgeCards: KnowledgeCards,
  webLinks: WebLinks,
  graphMini: GraphMini,
  sourceList: SourceList,
  memoryChips: MemoryChips,
  markdown: MarkdownView,
}

/** 查表；查不到返回 undefined，由调用方决定降级方式 */
export function resolveComponent(type: string): Component | undefined {
  return REGISTRY[type]
}
