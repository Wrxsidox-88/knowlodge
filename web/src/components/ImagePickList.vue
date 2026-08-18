<template>
  <div>
    <div v-if="loading" class="muted" style="font-size: 12px">
      <span class="loading" style="width: 12px; height: 12px"></span> 正在加载图片列表…
    </div>
    <template v-else-if="imgs.length">
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px">
        <button class="small" type="button" @click="selectAll">全选</button>
        <button class="small" type="button" @click="clearAll">清空</button>
        <span class="muted" style="font-size: 12px">已选 {{ modelValue.length }}/{{ imgs.length }} 张图片参与识别</span>
      </div>
      <div class="reimg-list">
        <label v-for="img in imgs" :key="img.id" class="reimg-item">
          <input type="checkbox" :checked="modelValue.includes(img.id)" @change="toggle(img.id)" />
          <span class="reimg-name">{{ img.placeholder || '图片 ' + img.id }}</span>
          <span class="muted reimg-desc">{{ img.hasDescription ? '已有识别结果' : '尚未识别' }}</span>
        </label>
      </div>
    </template>
    <div v-else class="muted" style="font-size: 12px">本材料没有图片</div>
  </div>
</template>

<script setup>
// 图片参与识别选择列表：加载材料图片轻量元信息，逐张勾选哪些照片参与本次视觉识别。
// v-model 为勾选的图片 id 数组；加载完成后默认全选（全部参与）。
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  material: { type: Object, required: true },
  modelValue: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:modelValue']);

const imgs = ref([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const d = await api.getMaterialImages(props.material.id, { meta: true });
    imgs.value = d.items || [];
    emit('update:modelValue', imgs.value.map((i) => i.id));
  } catch {
    imgs.value = [];
  } finally {
    loading.value = false;
  }
});

function toggle(id) {
  const arr = props.modelValue.slice();
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
  emit('update:modelValue', arr);
}

function selectAll() {
  emit('update:modelValue', imgs.value.map((i) => i.id));
}

function clearAll() {
  emit('update:modelValue', []);
}
</script>
