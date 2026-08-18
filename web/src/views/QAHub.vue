<template>
  <div class="qa-hub">
    <div class="hub-tabs glass">
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">
        {{ t.label }}
      </button>
    </div>
    <div class="hub-body" :style="{ minHeight: tab === 'chat' ? 'calc(100vh - 210px)' : 'auto' }">
      <ChatPanel v-if="tab === 'chat'" />
      <Semantic v-else-if="tab === 'semantic'" />
      <GraphPanel v-else-if="tab === 'graph'" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ChatPanel from './qa/ChatPanel.vue';
import Semantic from './Semantic.vue';
import GraphPanel from './GraphView.vue';

const route = useRoute();
const router = useRouter();

const tabs = [
  { key: 'chat', label: '智能对话' },
  { key: 'semantic', label: '语义检索' },
  { key: 'graph', label: '知识库（图谱）' }
];

const tab = computed(() => ['semantic', 'graph'].includes(route.query.tab) ? route.query.tab : 'chat');

function switchTab(key) {
  const q = { ...route.query, tab: key };
  if (key !== 'graph') delete q.node;
  router.push({ query: q });
}
</script>
