<template>
  <div>
    <div class="card">
      <div class="toolbar">
        <input
          v-model="query"
          placeholder="用自然语言查找资料，如：关于惯性的定义"
          style="flex: 1; min-width: 260px"
          @keyup.enter="search"
        />
        <WinComboBox
          :ItemsSource="topKOptions"
          DisplayMemberPath="label"
          SelectedValuePath="value"
          v-model:SelectedValue="topK"
          Width="120" />
        <button class="primary" :disabled="loading || !query.trim()" @click="search">
          <span v-if="loading" class="loading"></span>检索
        </button>
      </div>
      <div class="muted">基于向量模型的语义级检索；未配置 AI 时自动降级为关键词检索</div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <template v-if="results">
      <div class="muted" style="margin-bottom: 10px">
        “{{ results.query }}” 共命中 {{ results.items.length }} 条片段
      </div>
      <div v-if="!results.items.length" class="card empty">未命中任何材料片段，请先上传并分析材料</div>
      <div v-for="item in results.items" :key="item.chunkId" class="card" style="cursor: pointer" @click="item._open = !item._open">
        <div class="toolbar" style="margin: 0 0 8px">
          <span class="score-bar"><div :style="{ width: Math.round(item.score * 100) + '%' }"></div></span>
          <span class="muted">{{ Math.round(item.score * 100) }}%</span>
          <strong>{{ item.materialTitle }}</strong>
          <span class="badge">{{ item.subject || '未分类' }}</span>
          <span v-if="item.nodeName" class="badge search">知识点：{{ item.nodeName }}</span>
          <div class="spacer"></div>
          <span class="muted">片段 #{{ item.chunkId }} · {{ item.title }}</span>
        </div>
        <div class="muted" style="line-height: 1.7; white-space: pre-wrap">
          {{ item._open ? item.text : item.text.slice(0, 120) + (item.text.length > 120 ? ' ...' : '') }}
        </div>
        <router-link :to="`/materials?focus=${item.materialId}`" style="font-size: 12px" @click.stop>查看出处 →</router-link>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import WinComboBox from '../winui/components/WinComboBox.vue';
import { api } from '../api.js';

const route = useRoute();
const query = ref(route.query.q || '');
const topK = ref(8);
const results = ref(null);
const loading = ref(false);
const error = ref('');
const topKOptions = [5, 8, 12, 20].map((n) => ({ label: `Top ${n}`, value: n }));

async function search() {
  if (!query.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    const data = await api.search(query.value, topK.value);
    data.items.forEach((i) => (i._open = false));
    results.value = data;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

if (query.value) search();
</script>
