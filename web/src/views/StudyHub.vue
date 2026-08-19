<template>
  <div class="qa-hub">
    <div class="hub-tabs glass">
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">
        {{ t.label }}
      </button>
    </div>
    <div class="hub-body">
      <Exams v-if="tab === 'exams'" />
      <WrongBook v-else-if="tab === 'wrong'" />
      <Study v-else-if="tab === 'study'" />
      <Practice v-else-if="tab === 'practice'" />
      <Report v-else-if="tab === 'report'" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Exams from './Exams.vue';
import WrongBook from './WrongBook.vue';
import Study from './Study.vue';
import Practice from './Practice.vue';
import Report from './Report.vue';

const route = useRoute();
const router = useRouter();

const tabs = [
  { key: 'exams', label: '考试管理' },
  { key: 'wrong', label: '错题本' },
  { key: 'study', label: '学情分析' },
  { key: 'practice', label: '练习中心' },
  { key: 'report', label: '学习报告' }
];

const tab = computed(() =>
  ['exams', 'wrong', 'study', 'practice', 'report'].includes(route.query.tab) ? route.query.tab : 'exams'
);

function switchTab(key) {
  const q = { ...route.query, tab: key };
  delete q.node;
  router.push({ query: q });
}
</script>