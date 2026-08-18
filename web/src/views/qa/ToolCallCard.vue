<template>
  <div class="tool-card">
    <div class="toolbar" style="margin: 0 0 6px">
      <span class="badge pending">AI 请求执行工具</span>
      <strong>{{ TOOL_LABELS[call.tool] || call.tool }}</strong>
      <div class="spacer"></div>
      <span v-if="status === 'done'" class="badge done">已执行</span>
      <span v-else-if="status === 'error'" class="badge failed">失败</span>
      <span v-else-if="status === 'rejected'" class="badge">已拒绝</span>
    </div>
    <pre class="md-text" style="max-height: 140px; margin-bottom: 8px">{{ JSON.stringify(call.args, null, 2) }}</pre>

    <template v-if="status === 'pending'">
      <div class="muted" style="margin-bottom: 8px">该操作会修改系统数据，需你明确授权。拒绝时可输入引导词让 AI 调整方案。</div>
      <div class="toolbar" style="margin: 0">
        <button class="primary small" :disabled="executing" @click="approve">
          <span v-if="executing" class="loading"></span>授权执行
        </button>
        <button class="small danger" @click="rejectMode = true">拒绝</button>
      </div>
      <div v-if="rejectMode" class="toolbar" style="margin-top: 8px">
        <input v-model="guide" placeholder="引导词：告诉 AI 你希望它怎么做" style="flex: 1" @keyup.enter="reject" />
        <button class="small" @click="reject">发送引导</button>
      </div>
    </template>

    <template v-if="status === 'done' && result">
      <div class="muted" style="line-height: 1.7">{{ result.message }}</div>
      <button v-if="downloadInfo" class="chip" style="margin-top: 6px" :disabled="downloading" @click="download">
        <span v-if="downloading" class="loading"></span>下载生成文件 →
      </button>
    </template>
    <div v-if="status === 'error'" class="error-box" style="margin-top: 6px">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../../api.js';
import { winAlert } from '../../dialogs.js';

const props = defineProps({
  call: { type: Object, required: true },
  convId: { type: Number, default: null },
  // assistant 消息 id（用于持久化授权状态）
  messageId: { type: Number, default: null },
  // 该工具块在消息中的序号（用于持久化授权状态）
  index: { type: Number, default: 0 },
  // 已持久化的状态（重新进入页面时恢复，避免重复授权）
  savedState: { type: Object, default: null }
});
const emit = defineEmits(['guide']);

const TOOL_LABELS = {
  generate_document: '生成 Word 文档',
  reanalyze_material: '重新分析材料',
  countdown_add: '新建倒计时',
  countdown_delete: '删除倒计时',
  list_create: '新建知识清单',
  list_edit: '更新知识清单',
  mindmap_create: '新建脑图'
};

// 恢复历史状态：已授权/已拒绝过的工具调用不再显示授权按钮
const status = ref(savedStateStatus());
const result = ref(props.savedState?.result ? { message: props.savedState.result.message || '已执行', result: { downloadUrl: props.savedState.result.downloadUrl, id: props.savedState.result.id } } : null);
const executing = ref(false);
const downloading = ref(false);
const rejectMode = ref(false);
const guide = ref('');
const errorMsg = ref('');

function savedStateStatus() {
  const s = props.savedState?.status;
  return ['done', 'rejected', 'error'].includes(s) ? s : 'pending';
}

const downloadInfo = computed(() => {
  const url = result.value?.result?.downloadUrl;
  const id = result.value?.result?.id;
  return url && id ? { url, id } : null;
});

function persist(state, extra = null) {
  if (!props.messageId) return;
  api.saveToolState(props.messageId, props.index, state, extra).catch(() => {});
}

async function approve() {
  executing.value = true;
  try {
    const r = await api.executeTool(props.call.tool, props.call.args);
    result.value = r;
    status.value = 'done';
    persist('done', {
      message: r.message,
      downloadUrl: r.result?.downloadUrl || null,
      id: r.result?.id ?? null
    });
    if (props.convId) {
      api.addNote(props.convId, `已执行工具：${TOOL_LABELS[props.call.tool] || props.call.tool} — ${r.message}`).catch(() => {});
    }
  } catch (e) {
    status.value = 'error';
    errorMsg.value = e.message;
    persist('error', { message: e.message });
  } finally {
    executing.value = false;
  }
}

function reject() {
  status.value = 'rejected';
  persist('rejected');
  emit('guide', guide.value.trim());
}

async function download() {
  if (!downloadInfo.value) return;
  downloading.value = true;
  try {
    await api.downloadDocument(downloadInfo.value.id, `${downloadInfo.value.id}.docx`);
  } catch (e) {
    winAlert({ title: '下载失败', message: e.message });
  } finally {
    downloading.value = false;
  }
}
</script>
