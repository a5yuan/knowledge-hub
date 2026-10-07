import type { Directive } from 'vue'
import { useUserStore } from '@/stores/user'

/**
 * 按钮级权限指令（三级权限模型第 1 层）：v-permission="'document:create'" 或 v-permission="['a','b']"
 * 任一权限码命中即保留元素；无权限直接移除元素（el.remove()）。
 * 判定逻辑统一走 user store 的 hasPermission（admin 短路 / 空集兜底）。
 */
function check(el: HTMLElement, value: string | string[]): void {
  const codes = Array.isArray(value) ? value : [value]
  const store = useUserStore()
  if (codes.length > 0 && !codes.some((c) => store.hasPermission(c))) {
    el.remove()
  }
}

export const permission: Directive<HTMLElement, string | string[]> = {
  mounted(el, binding) {
    check(el, binding.value)
  },
}
