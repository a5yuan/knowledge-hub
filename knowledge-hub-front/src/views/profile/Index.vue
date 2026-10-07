<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { changePassword, updateProfile } from '@/api/auth'
import { fetchDepartments } from '@/api/departments'
import { fetchMyStats } from '@/api/stats'
import { fetchDocuments } from '@/api/documents'
import { isRealResource } from '@/api/endpoint'
import { useUserStore } from '@/stores/user'
import type { MyStats } from '@/types/api'

/**
 * 个人中心（工单 12 / 工单 05 收口）：
 * 昵称可编辑（用户名/部门/角色只读），保存走 PATCH /auth/profile 后同步 store → 顶栏即时更新；
 * 修改密码与资料更新钉在 Mock 通道（后端无对应接口）；
 * 统计：Mock 走 /stats/mine；真实模式后端无 fileSize 来源——隐藏存储占用，
 * 文档数改用真实列表 total（口径=本人未归档文档，与「我的文档」分区一致）。
 */
const userStore = useUserStore()

const realMode = computed(() => isRealResource('documents'))

// ---------- 基本资料 ----------
const displayName = ref('')
const departmentName = ref('')

const dirty = computed(() => displayName.value.trim() !== (userStore.user?.displayName ?? ''))

async function saveProfile(): Promise<void> {
  const name = displayName.value.trim()
  if (!name) {
    ElMessage.warning('昵称不能为空')
    return
  }
  try {
    const updated = await updateProfile(name)
    userStore.setUser(updated)
    ElMessage.success('昵称已更新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// ---------- 我的上传统计 ----------
const stats = ref<MyStats | null>(null)

function formatSize(bytes?: number): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ---------- 修改密码 ----------
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' })

async function submitPassword(): Promise<void> {
  if (!pwdForm.oldPassword || !pwdForm.newPassword) {
    ElMessage.warning('请填写旧密码与新密码')
    return
  }
  if (pwdForm.newPassword.length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  if (pwdForm.newPassword !== pwdForm.confirm) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }
  try {
    await changePassword(pwdForm.oldPassword, pwdForm.newPassword)
    ElMessage.success('密码已修改，下次登录请使用新密码')
    pwdForm.oldPassword = ''
    pwdForm.newPassword = ''
    pwdForm.confirm = ''
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '修改失败')
  }
}

onMounted(async () => {
  displayName.value = userStore.user?.displayName ?? ''
  try {
    const [depts, myStats] = await Promise.all([fetchDepartments(), loadMyStats()])
    departmentName.value = depts.find((d) => d.id === userStore.user?.departmentId)?.name ?? '—'
    stats.value = myStats
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '数据加载失败')
  }
})

/** 真实模式：后端无 /stats/mine——文档数取「我的文档」列表 total 并扣除被前端过滤的已归档行；totalSize 无来源（存储占用项隐藏） */
async function loadMyStats(): Promise<MyStats> {
  if (!realMode.value) return fetchMyStats()
  const page = await fetchDocuments({ zone: 'mine', page: 1, pageSize: 1 }, userStore.user?.id ?? '')
  return { docCount: page.total - (page.removedArchived ?? 0), totalSize: 0 }
}
</script>

<template>
  <div class="page profile-page">
    <h2 class="page-title">个人中心</h2>

    <el-row :gutter="16">
      <el-col :span="14">
        <el-card shadow="never">
          <template #header>基本资料</template>
          <el-form label-width="80px" class="profile-form">
            <el-form-item label="用户名">
              <span class="readonly-value">{{ userStore.user?.username }}</span>
            </el-form-item>
            <el-form-item label="昵称">
              <el-input v-model="displayName" maxlength="20" show-word-limit class="nick-input" />
            </el-form-item>
            <el-form-item label="部门">
              <span class="readonly-value">{{ departmentName }}</span>
            </el-form-item>
            <el-form-item label="角色">
              <el-tag size="small" :type="userStore.isAdmin ? 'danger' : 'info'">{{ userStore.roleLabel }}</el-tag>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :disabled="!dirty" @click="saveProfile">保存修改</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>我的上传统计</template>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-value">{{ stats?.docCount ?? '—' }}</div>
              <div class="stat-label">文档数</div>
            </div>
            <!-- 真实模式隐藏：后端文档数据无文件大小来源（spec §4.4 有损映射，工单 05） -->
            <div v-if="!realMode" class="stat-item">
              <div class="stat-value">{{ stats ? formatSize(stats.totalSize) : '—' }}</div>
              <div class="stat-label">存储占用</div>
            </div>
          </div>
          <p class="stat-note">口径与「我的文档」列表一致（不含已归档）</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="pwd-card">
      <template #header>修改密码</template>
      <el-form label-width="100px" class="pwd-form">
        <el-form-item label="旧密码">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password class="pwd-input" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 6 位"
            class="pwd-input" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwdForm.confirm" type="password" show-password class="pwd-input" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="submitPassword">修改密码</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.profile-form,
.pwd-form {
  max-width: 460px;
}

.nick-input,
.pwd-input {
  max-width: 280px;
}

.readonly-value {
  color: #606266;
}

.stat-grid {
  display: flex;
  gap: 48px;
  padding: 8px 0;
}

.stat-value {
  font-size: 26px;
  font-weight: 600;
  color: #303133;
}

.stat-label {
  margin-top: 4px;
  font-size: 13px;
  color: #909399;
}

.stat-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: #c0c4cc;
}

.pwd-card {
  margin-top: 16px;
}
</style>
