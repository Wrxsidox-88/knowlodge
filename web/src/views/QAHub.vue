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
      <Lists v-else-if="tab === 'lists'" />
      <MindMap v-else-if="tab === 'mindmap'" />
      <Notes v-else-if="tab === 'notes'" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ChatPanel from './qa/ChatPanel.vue';
import Semantic from './Semantic.vue';
import GraphPanel from './GraphView.vue';
import Lists from './Lists.vue';
import MindMap from './MindMap.vue';
import Notes from './Notes.vue';

const route = useRoute();
const router = useRouter();

const tabs = [
  { key: 'chat', label: '智能对话' },
  { key: 'semantic', label: '语义检索' },
  { key: 'graph', label: '知识图谱' },
  { key: 'lists', label: '知识清单' },
  { key: 'mindmap', label: '脑图' },
  { key: 'notes', label: '学习笔记' }
];

const tab = computed(() =>
  ['semantic', 'graph', 'lists', 'mindmap', 'notes'].includes(route.query.tab) ? route.query.tab : 'chat'
);

function switchTab(key) {
  const q = { ...route.query, tab: key };
  if (key !== 'graph') delete q.node;
  router.push({ query: q });
}
</script>
