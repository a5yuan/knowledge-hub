import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  { ignores: ['dist/**', 'node_modules/**'] },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    // 视图层是「一页一目录」（views/documents/Index.vue、views/admin/Users.vue…），
    // 文件名即路由语义，不适用「组件名必须多词」。此规则自项目初始就命中全部 15 个视图文件。
    files: ['src/views/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  {
    // 代码中已按「_ 前缀 = 有意忽略」书写（如解构丢弃 password 字段），配置与之对齐。
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
)
