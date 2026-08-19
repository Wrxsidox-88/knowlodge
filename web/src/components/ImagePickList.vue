<template>
  <div>
    <div v-if="loading" class="muted" style="font-size: 12px">
      <span class="loading" style="width: 12px; height: 12px"></span> 正在加载图片列表…
    </div>
    <template v-else-if="imgs.length">
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px">
        <button class="small" type="button" @click="selectAll">全选</button>
        <button class="small" type="button" @click="clearAll">清空</button>
        <span class="muted" style="font-size: 12px">已选 {{ modelValue.length }}/{{ imgs.length }} 张图片参与识别（滚动查看照片预览）</span>
      </div>
      <div class="reimg-list">
        <label v-for="img in imgs" :key="img.id" class="reimg-item">
          <input type="checkbox" :checked="modelValue.includes(img.id)" @change="toggle(img.id)" />
          <span class="reimg-thumb" :ref="(el) => setThumbEl(el, img.id)">
            <img v-if="thumbs[img.id]" :src="thumbs[img.id]" :alt="img.placeholder || ''" loading="lazy" />
            <span v-else class="reimg-thumb-placeholder">
              <span class="loading" style="width: 12px; height: 12px"></span>
            </span>
          </span>
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
// 缩略图按需加载：滚动到可见区域时才请求单张图片，避免一次性加载大量 base64 数据。
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  material: { type: Object, required: true },
  modelValue: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:modelValue']);

const imgs = ref([]);
const loading = ref(true);
const thumbs = reactive({});
const thumbEls = new Map(); // imgId -> element
let observer = null;

function setThumbEl(el, id) {
  if (el) {
    thumbEls.set(id, el);
    observer?.observe(el);
  } else {
    thumbEls.delete(id);
  }
}

async function loadThumb(id) {
  if (thumbs[id]) return;
  try {
    const d = await api.getMaterialImage(props.material.id, id);
    if (d?.dataUrl) thumbs[id] = d.dataUrl;
  } catch {
    thumbs[id] = ''; // 加载失败标记，避免反复请求
  }
}

onMounted(async () => {
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target;
          observer.unobserve(el);
          const id = [...thumbEls.entries()].find(([, e]) => e === el)?.[0];
          if (id) loadThumb(id);
        }
      }
    },
    { rootMargin: '80px' }
  );
  try {
    const d = await api.getMaterialImages(props.material.id, { meta: true });
    imgs.value = d.items || [];
    emit('update:modelValue', imgs.value.map((i) => i.id));
    // 等缩略图容器渲染后注册观察
    await nextTick();
    for (const [id, el] of thumbEls) observer?.observe(el);
  } catch {
    imgs.value = [];
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  thumbEls.clear();
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