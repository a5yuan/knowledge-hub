<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const formRef = ref<FormInstance>()
const loading = ref(false)
const form = reactive({ username: '', password: '' })

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function handleLogin(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await userStore.login(form.username, form.password)
    ElMessage.success('登录成功')
    // redirect 仅接受站内路径，防开放重定向
    const redirect =
      typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
        ? route.query.redirect
        : '/dashboard'
    await router.push(redirect)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登录失败，请稍后重试')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-head">
        <el-icon class="login-logo" :size="34"><Collection /></el-icon>
        <h1 class="login-title">企业智能知识库系统</h1>
        <p class="login-subtitle">知识汇聚 · 智慧共享</p>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" size="large" @submit.prevent="handleLogin">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="用户名" :prefix-icon="User" autocomplete="username" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            :prefix-icon="Lock"
            show-password
            autocomplete="current-password"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-button class="login-btn" type="primary" native-type="submit" :loading="loading">
            登 录
          </el-button>
        </el-form-item>
      </el-form>

      <p class="login-tip">演示账号：admin / 123456（管理员） · li / 123456（成员）</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #e7eeff 0%, #f5f7fa 55%, #e7eeff 100%);
}

.login-card {
  width: 400px;
  padding: 40px 36px 28px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgb(26 102 255 / 10%);
}

.login-head {
  text-align: center;
  margin-bottom: 28px;
}

.login-logo {
  color: var(--el-color-primary);
  margin-bottom: 8px;
}

.login-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

.login-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #909399;
}

.login-btn {
  width: 100%;
}

.login-tip {
  margin: 4px 0 0;
  text-align: center;
  font-size: 12px;
  color: #a8abb2;
}
</style>
