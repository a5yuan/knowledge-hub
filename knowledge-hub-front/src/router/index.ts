import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import MainLayout from '@/layouts/MainLayout.vue'
import { getToken } from '@/api/http'
import { useUserStore } from '@/stores/user'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/login/Index.vue'),
      meta: { title: '登录', public: true },
    },
    {
      path: '/',
      component: MainLayout,
      redirect: '/dashboard',
      children: [
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/views/dashboard/Index.vue'),
          meta: { title: '首页大盘' },
        },
        {
          path: 'documents',
          name: 'documents',
          component: () => import('@/views/documents/Index.vue'),
          meta: { title: '文档管理', permission: 'document' },
        },
        {
          path: 'documents/reviews',
          name: 'document-reviews',
          component: () => import('@/views/documents/Reviews.vue'),
          meta: { title: '审核工作台', requiresReviewer: true },
        },
        {
          path: 'documents/:id/edit',
          name: 'document-editor',
          component: () => import('@/views/documents/Editor.vue'),
          meta: { title: '编辑文档' },
        },
        {
          path: 'documents/:id/preview',
          name: 'document-preview',
          component: () => import('@/views/documents/Preview.vue'),
          meta: { title: '文档预览' },
        },
        {
          path: 'search',
          name: 'search',
          component: () => import('@/views/search/Index.vue'),
          meta: { title: '智能搜索', permission: 'search' },
        },
        {
          path: 'ai-qa',
          name: 'ai-qa',
          component: () => import('@/views/ai-qa/Index.vue'),
          meta: { title: 'AI智能问答' },
        },
        {
          path: 'knowledge-graph',
          name: 'knowledge-graph',
          component: () => import('@/views/knowledge-graph/Index.vue'),
          meta: { title: '知识图谱' },
        },
        {
          path: 'profile',
          name: 'profile',
          component: () => import('@/views/profile/Index.vue'),
          meta: { title: '个人中心' },
        },
        {
          path: 'admin',
          component: () => import('@/views/admin/Layout.vue'),
          redirect: '/admin/users',
          meta: { title: '系统管理', requiresAdmin: true },
          children: [
            {
              path: 'users',
              name: 'admin-users',
              component: () => import('@/views/admin/Users.vue'),
              meta: { title: '用户管理' },
            },
            {
              path: 'roles',
              name: 'admin-roles',
              component: () => import('@/views/admin/Roles.vue'),
              meta: { title: '角色权限' },
            },
            {
              path: 'teams',
              name: 'admin-teams',
              component: () => import('@/views/admin/Teams.vue'),
              meta: { title: '团队管理' },
            },
          ],
        },
      ],
    },
  ],
})

/**
 * 全局守卫（spec §5.1）：会话恢复 → 登录校验 → 角色校验。
 * 刷新后 store 为空但本地有 token 时先恢复会话；恢复失败已被拦截器清凭证，走未登录分支。
 */
router.beforeEach(async (to) => {
  const userStore = useUserStore()
  if (getToken() && !userStore.isLoggedIn) await userStore.restoreSession()

  if (to.meta.public) {
    return userStore.isLoggedIn ? { path: '/dashboard' } : true
  }
  if (!userStore.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.meta.requiresAdmin && !userStore.isAdmin) {
    ElMessage.warning('该页面仅管理员可访问')
    return { path: '/dashboard' }
  }
  // 审核工作台（工单 03）：与 requiresAdmin 对称，必须排在登录校验之后
  if (to.meta.requiresReviewer && !userStore.canReview) {
    ElMessage.warning('该页面仅审核人员可访问')
    return { path: '/dashboard' }
  }
  // 页面权限（权限模型控制工单）：meta.permission 为权限码，无权限码则拦截，跟在登录校验之后
  if (to.meta.permission && !userStore.hasPermission(String(to.meta.permission))) {
    ElMessage.warning('暂无该页面访问权限')
    return { path: '/dashboard' }
  }
  return true
})

export default router
