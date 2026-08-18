<template>
  <div class="figure-block">
    <div v-if="error" class="error-box">图形渲染失败：{{ error }}</div>
    <div v-else-if="!svg" class="muted"><span class="loading"></span>正在绘制图形…</div>
    <div v-else class="figure-canvas" v-html="svg"></div>
    <div v-if="svg" class="toolbar" style="margin: 6px 0 0">
      <span class="muted">系统根据 AI 提供的数据精确绘制</span>
      <div class="spacer"></div>
      <button class="small" :disabled="downloading" @click="downloadPng">
        <span v-if="downloading" class="loading"></span>下载 PNG
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api.js';
import { winAlert } from '../../dialogs.js';

const props = defineProps({ specText: { type: String, required: true } });
const svg = ref('');
const error = ref('');
const downloading = ref(false);
let spec = null;

function parse() {
  try {
    spec = JSON.parse(props.specText);
  } catch {
    error.value = '图形数据不是合法 JSON，请让 AI 重新输出';
    spec = null;
  }
}

async function render() {
  if (!spec) return;
  try {
    const r = await api.renderFigure(spec);
    svg.value = r.svg;
  } catch (e) {
    error.value = e.message;
  }
}

async function downloadPng() {
  downloading.value = true;
  try {
    const blob = await api.figurePngBlob(spec);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'figure.png';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    winAlert({ title: '下载失败', message: '下载失败：' + e.message });
  } finally {
    downloading.value = false;
  }
}

onMounted(() => {
  parse();
  render();
});
</script>
