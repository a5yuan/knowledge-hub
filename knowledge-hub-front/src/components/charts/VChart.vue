<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { GraphChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

/** 工单 09：ECharts 按需注册（折线/环形 + 二期工单 07 力导图），tree-shaking 控制包体积 */
echarts.use([GraphChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps<{ option: EChartsCoreOption }>()

const el = ref<HTMLDivElement>()
let chart: echarts.EChartsType | null = null
let observer: ResizeObserver | null = null

onMounted(() => {
    if (!el.value) return
    chart = echarts.init(el.value)
    chart.setOption(props.option, true)
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(el.value)
})

watch(
    () => props.option,
    (opt) => chart?.setOption(opt, true), // notMerge：范围切换时点数变化，避免旧数据残留
)

onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    chart?.dispose()
    chart = null
})

/** 暴露实例：力导图缩放控件（dispatchAction/setOption）与节点点击事件依赖（二期工单 07） */
defineExpose({ getInstance: () => chart })
</script>

<template>
    <div ref="el" class="v-chart" />
</template>

<style scoped>
.v-chart {
    width: 100%;
    height: 100%;
    min-height: 280px;
}
</style>
