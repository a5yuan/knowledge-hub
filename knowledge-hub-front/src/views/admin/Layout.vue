<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user'

/**
 * 系统管理布局（权限模型控制工单）：左侧子菜单 + 右侧内容区，复刻角色权限页原型图。
 * 子菜单按当前用户权限码过滤（system:user / system:role / system:team）。
 */
const route = useRoute()
const userStore = useUserStore()

interface AdminMenuItem {
  path: string
  title: string
  icon: string
  permission: string
}

const menuItems: AdminMenuItem[] = [
  { path: '/admin/users', title: '用户管理', icon: 'User', permission: 'system:user' },
  { path: '/admin/roles', title: '角色权限', icon: 'Lock', permission: 'system:role' },
  { path: '/admin/teams', title: '团队管理', icon: 'UserFilled', permission: 'system:team' },
]

const visibleMenuItems = computed(() =>
  menuItems.filter((item) => userStore.hasPermission(item.permission)),
)

const activePath = computed(() => route.path)
</script>

<template>
  <div class="admin-layout">
    <aside class="admin-aside">
      <div class="aside-label">系统管理</div>
      <el-menu :default-active="activePath" router class="aside-menu">
        <el-menu-item v-for="item in visibleMenuItems" :key="item.path" :index="item.path">
          <el-icon>
            <component :is="item.icon" />
          </el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </aside>
    <main class="admin-main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  align-items: stretch;
  height: 100%;
}

.admin-aside {
  width: 200px;
  flex-shrink: 0;
  margin: 16px 0 16px 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
}

.aside-label {
  padding: 16px 20px 8px;
  font-size: 13px;
  color: #909399;
}

.aside-menu {
  border-right: none;
}

.admin-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: auto;
}
</style>
