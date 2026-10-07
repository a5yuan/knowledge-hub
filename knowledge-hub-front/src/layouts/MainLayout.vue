<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { fetchPendingReviewCount } from '@/api/documents'
import { isRealResource } from '@/api/endpoint'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

interface MenuItem {
  path: string
  title: string
  icon: string
  adminOnly?: boolean
  reviewerOnly?: boolean
  /** 页面权限码（权限模型控制工单）：配置后按当前用户权限过滤显隐 */
  permission?: string
}

const menuItems: MenuItem[] = [
  { path: '/dashboard', title: '首页大盘', icon: 'Odometer', permission: 'dashboard' },
  { path: '/documents', title: '文档管理', icon: 'FolderOpened', permission: 'document' },
  { path: '/documents/reviews', title: '审核工作台', icon: 'Finished', reviewerOnly: true },
  { path: '/search', title: '智能搜索', icon: 'Search', permission: 'search' },
  { path: '/ai-qa', title: 'AI智能问答', icon: 'ChatDotRound' },
  { path: '/knowledge-graph', title: '知识图谱', icon: 'Share' },
  { path: '/profile', title: '个人中心', icon: 'User', permission: 'profile' },
  { path: '/admin', title: '系统管理', icon: 'Setting', adminOnly: true },
]

const visibleMenuItems = computed(() =>
  menuItems.filter((item) => {
    if (item.adminOnly && !userStore.isAdmin) return false
    if (item.reviewerOnly && !userStore.canReview) return false
    if (item.permission && !userStore.hasPermission(item.permission)) return false
    return true
  }),
)

const activePath = computed(() => route.path)

// ---------- 待审角标（工单 03）：真实模式轮询待审数，30s 间隔且页签隐藏时暂停；Mock 模式保持演示值 3 ----------
const pendingCount = ref(3)
const realDocuments = computed(() => isRealResource('documents'))
let badgeTimer: ReturnType<typeof setInterval> | undefined
const BADGE_INTERVAL_MS = 30000

async function refreshBadge(): Promise<void> {
  if (document.hidden) return
  try {
    pendingCount.value = await fetchPendingReviewCount()
  } catch {
    // 角标拉取失败不打扰用户，保留上次值
  }
}

function startBadgePolling(): void {
  if (!realDocuments.value || !userStore.canReview) return
  void refreshBadge()
  badgeTimer ??= setInterval(() => void refreshBadge(), BADGE_INTERVAL_MS)
}

/** 审核动作后角标立即失效（Reviews.vue 发出），不依赖 30s 轮询 */
function onReviewChanged(): void {
  void refreshBadge()
}

onMounted(() => {
  startBadgePolling()
  window.addEventListener('kh:pending-review-changed', onReviewChanged)
})

onUnmounted(() => {
  if (badgeTimer !== undefined) clearInterval(badgeTimer)
  window.removeEventListener('kh:pending-review-changed', onReviewChanged)
})

function onUserCommand(command: string | number | object) {
  const cmd = String(command)
  if (cmd === 'profile') {
    router.push('/profile')
  } else if (cmd === 'logout') {
    userStore.logout()
    router.push('/login')
  }
}
</script>

<template>
  <el-container class="layout">
    <el-header class="layout-header" height="56px">
      <div class="header-left">
        <div class="logo">
          <el-icon class="logo-icon" :size="22">
            <Collection />
          </el-icon>
          <span class="logo-text">企业智能知识库系统</span>
        </div>
        <el-menu class="top-menu" mode="horizontal" :default-active="activePath" :ellipsis="false" router>
          <el-menu-item v-for="item in visibleMenuItems" :key="item.path" :index="item.path">
            <el-icon>
              <component :is="item.icon" />
            </el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-menu>
      </div>

      <div class="header-right">
        <el-tooltip :content="realDocuments ? `待审文档 ${pendingCount} 篇` : '通知'" placement="bottom">
          <el-badge :value="pendingCount" :hidden="pendingCount === 0" class="notice-badge">
            <el-icon :size="18" class="notice-icon">
              <Bell />
            </el-icon>
          </el-badge>
        </el-tooltip>
        <el-dropdown trigger="click" @command="onUserCommand">
          <span class="user-entry">
            <el-avatar :size="28" class="user-avatar">
              <el-icon>
                <UserFilled />
              </el-icon>
            </el-avatar>
            <span class="user-name">{{ userStore.user?.displayName }}</span>
            <el-icon class="user-arrow">
              <ArrowDown />
            </el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="noop" disabled>
                {{ userStore.user?.displayName }}（{{ userStore.roleLabel }}）
              </el-dropdown-item>
              <el-dropdown-item command="profile">个人中心</el-dropdown-item>
              <el-dropdown-item command="logout" :divided="true">
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </el-header>

    <el-main class="layout-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 24px;
  min-width: 0;
  flex: 1;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.logo-icon {
  color: var(--el-color-primary);
}

.logo-text {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  white-space: nowrap;
}

.top-menu {
  flex: 1;
  min-width: 0;
  border-bottom: none;
}

.top-menu .el-menu-item {
  height: 56px;
  line-height: 56px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
}

.notice-badge {
  display: flex;
  align-items: center;
}

.notice-icon {
  color: #606266;
  cursor: pointer;
}

.user-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
}

.user-avatar {
  background-color: var(--el-color-primary);
}

.user-name {
  font-size: 14px;
  color: #303133;
}

.user-arrow {
  font-size: 12px;
  color: #909399;
}

.layout-main {
  padding: 0;
  background-color: #f5f7fa;
  overflow: auto;
}
</style>
