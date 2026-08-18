<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo" aria-hidden="true">&#xE8A1;</div>
      <h1>知识图谱智能问答系统</h1>
      <div class="sub">knowlodge — Knowledge Graph QA Platform</div>
      <div v-if="error" class="error-box">{{ error }}</div>
      <label class="field">
        <span>用户名</span>
        <input v-model="username" placeholder="admin" autocomplete="username" @keyup.enter="login" />
      </label>
      <label class="field">
        <span>密码</span>
        <input v-model="password" type="password" placeholder="默认 admin123" autocomplete="current-password" @keyup.enter="login" />
      </label>
      <button class="primary" :disabled="loading" @click="login">
        <span v-if="loading" class="loading"></span>登录
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';

const router = useRouter();
const username = ref('admin');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function login() {
  error.value = '';
  loading.value = true;
  try {
    const data = await api.login(username.value, password.value);
    localStorage.setItem('kl_token', data.token);
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>