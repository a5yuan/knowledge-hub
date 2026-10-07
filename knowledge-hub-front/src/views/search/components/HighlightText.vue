<script setup lang="ts">
import { computed } from 'vue'

/** 关键词高亮：按关键词拆分文本，命中片段包 <mark>（节点级渲染，不引入 v-html 面） */
const props = defineProps<{ text: string; keyword?: string }>()

const parts = computed(() => {
    const text = props.text ?? ''
    const kw = props.keyword?.trim()
    if (!kw) return [{ hit: false, text }]
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text
        .split(new RegExp(`(${escaped})`, 'ig'))
        .filter(Boolean)
        .map((seg) => ({ hit: seg.toLowerCase() === kw.toLowerCase(), text: seg }))
})
</script>

<template>
    <!-- 单根 span：保证外部 class（如 title-text）能 fallthrough 生效 -->
    <span class="hl-text">
        <template v-for="(p, i) in parts" :key="i">
            <mark v-if="p.hit" class="hl">{{ p.text }}</mark>
            <template v-else>{{ p.text }}</template>
        </template>
    </span>
</template>

<style scoped>
mark.hl {
    background: #ffe58f;
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
}
</style>
