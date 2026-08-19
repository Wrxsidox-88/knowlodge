<template>
  <div class="qa-hub">
    <div class="hub-tabs glass">
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">
        {{ t.label }}
      </button>
    </div>
    <div class="hub-body">
      <Materials v-if="tab === 'materials'" />
      <Analysis v-else-if="tab === 'analysis'" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Materials from './Materials.vue';
import Analysis from './Analysis.vue';

const route = useRoute();
const router = useRouter();

const tabs = [
  { key: 'materials', label: '材料管理' },
  { key: 'analysis', label: '分析生成' }
];

const tab = computed(() => (route.query.tab === 'analysis' ? 'analysis' : 'materials'));

function switchTab(key) {
  const q = { ...route.query, tab: key };
  if (key !== 'analysis') delete q.focus;
  router.push({ query: q });
}
</script>