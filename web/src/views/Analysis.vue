<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="card">
      <div class="toolbar">
        <h3 style="margin: 0">材料列表</h3>
        <input v-model="guide" placeholder="分析引导词（可选）" style="width: 220px" />
        <div class="spacer"></div>
        <button class="primary small" :disabled="busy || !pendingMaterials.length" @click="openBatch">
          <span v-if="busy" class="loading"></span>批量分析待分析材料（{{ pendingMaterials.length }}）
        </button>
        <button class="small" @click="load">刷新</button>
      </div>
      <p class="muted" style="margin: 6px 0 0; font-size: 12px">
        启动分析前可逐份勾选哪些照片参与识别；批量提交后 AI 逐份处理（分批），全部完成后自动生成统一汇总。分析时 AI 会先阅读已有图谱，尽量复用已有知识点并归入已有子网。
      </p>
      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="!materials.length" class="empty">暂无材料，请先到"材料管理"上传</div>
      <table v-else>
        <thead>
          <tr><th>ID</th><th>标题</th><th>科目</th><th>状态</th><th>字数</th><th>图片</th><th>更新时间</th><th>操作</th></tr>
        </thead>
        <tr v-for="m in materials" :key="m.id">
          <td>{{ m.id }}</td>
          <td>{{ m.title }}</td>
          <td class="muted">{{ m.subject || '待分类' }}</td>
          <td><span class="badge" :class="m.status">{{ STATUS_TEXT[m.status] || m.status }}</span></td>
          <td class="muted">{{ m.content_length }}</td>
          <td><span v-if="m.image_count" class="badge search">{{ m.image_count }} 图</span><span v-else class="muted">-</span></td>
          <td class="muted">{{ m.updated_at }}</td>
          <td>
            <button
              class="small primary"
              :disabled="m.status === 'analyzing' || runningSet.has(m.id)"
              @click="openRun(m)"
            >
              {{ m.status === 'done' ? '重新分析' : '开始分析' }}
            </button>
          </td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h3>分析任务（AI 流水线：图片识别 → 分类 → 概览 → 元信息 → 知识抽取 → 向量化 → 并入图谱）</h3>
      <p class="muted" style="margin: -6px 0 10px">
        重新分析默认复用已有的图片识别结果以节省 token；如需重新识别图片，请在"重新分析"弹窗中勾选。
      </p>
      <div v-if="!jobs.length" class="empty">暂无任务</div>
      <table v-else>
        <thead>
          <tr><th>ID</th><th>材料</th><th>状态</th><th>进度</th><th>阶段</th><th>结果/消息</th><th>更新时间</th></tr>
        </thead>
        <tr v-for="j in jobs" :key="j.id">
          <td>{{ j.id }}</td>
          <td>{{ j.material_title }}</td>
          <td><span class="badge" :class="j.status">{{ STATUS_TEXT[j.status] || j.status }}</span></td>
          <td><div class="progress"><div :style="{ width: j.progress + '%' }"></div></div></td>
          <td class="muted">
            <span v-if="j.status === 'running' || j.status === 'queued'" class="loading"></span>{{ j.step }}
          </td>
          <td class="muted">{{ j.message || '-' }}</td>
          <td class="muted">{{ j.updated_at }}</td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h3>批量分析批次（AI 分批处理 · 完成后统一汇总）</h3>
      <div v-if="!batches.length" class="empty">暂无批量分析记录</div>
      <div v-for="b in batches" :key="b.id" class="node-card" style="margin-bottom: 10px">
        <div class="toolbar" style="margin: 0 0 6px">
          <span class="badge" :class="b.status === 'done' ? 'done' : b.status === 'running' ? 'analyzing' : 'failed'">
            {{ b.status === 'done' ? '已完成' : b.status === 'running' ? '进行中' : '失败' }}
          </span>
          <strong>批次 #{{ b.id }}</strong>
          <span class="muted">共 {{ b.total }} 份 · 成功 {{ b.done_count }} · 失败 {{ b.failed_count }}</span>
          <span v-if="b.status === 'running'" class="loading"></span>
          <div class="spacer"></div>
          <span class="muted">{{ b.created_at }}</span>
        </div>
        <div v-if="b.summary" class="muted" style="line-height: 1.7; white-space: pre-wrap">{{ b.summary }}</div>
        <div v-else-if="b.status === 'running'" class="muted">AI 正在逐份分析，全部完成后将在此生成统一汇总…</div>
      </div>
    </div>

    <div class="card">
      <h3>已构建子知识网（按题目/主题划分）</h3>
      <p class="muted" style="margin: -6px 0 10px">同主题的多份材料会并入同一子网（按名称复用），避免一份资料一个新子网。</p>
      <div v-if="!subGraphs.length" class="empty">分析材料后将在此出现子知识网</div>
      <table v-else>
        <thead><tr><th>ID</th><th>名称</th><th>说明</th><th>节点数</th><th>来源材料</th></tr></thead>
        <tr v-for="s in subGraphs" :key="s.id">
          <td>{{ s.id }}</td>
          <td>{{ s.name }}</td>
          <td class="muted">{{ s.description || '-' }}</td>
          <td>{{ s.node_count }}</td>
          <td class="muted">{{ s.material_title || '-' }}</td>
        </tr>
      </table>
    </div>

    <!-- 开始分析弹窗（待分析/失败材料，含图片）：引导词 + 勾选参与识别的照片 -->
    <div v-if="startModal" class="modal-mask" @click.self="startModal = null">
      <div class="modal" style="width: min(580px, 92vw)">
        <h3>开始分析《{{ startModal.title }}》</h3>
        <label class="field">
          <span>分析引导词（可选）</span>
          <textarea v-model="startGuide" rows="3" placeholder="如：重点提取做题方法与注意事项；注意本材料包含多个科目…"></textarea>
        </label>
        <div v-if="(startModal.image_count || 0) > 0" style="margin-bottom: 14px">
          <div class="muted" style="margin-bottom: 8px">选择哪些照片参与识别（默认全部参与；未勾选且无识别结果的图片将跳过）：</div>
          <ImagePickList :material="startModal" v-model="startSelected" />
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button @click="startModal = null">取消</button>
          <button class="primary" :disabled="startBusy" @click="confirmStart">
            <span v-if="startBusy" class="loading"></span>开始分析
          </button>
        </div>
      </div>
    </div>

    <!-- 批量分析弹窗：逐份材料勾选 + 逐份选择参与识别的照片 -->
    <div v-if="batchModal" class="modal-mask" @click.self="batchModal = null">
      <div class="modal" style="width: min(640px, 92vw)">
        <h3>批量分析（{{ batchItems.length }} 份待分析材料）</h3>
        <p class="muted" style="line-height: 1.7; margin-bottom: 12px">
          提交后 AI 将<b>逐份串行分析</b>（分批处理，避免并发超载），全部完成后自动生成<b>统一汇总</b>。
          含图片的材料可展开勾选哪些照片参与识别（默认全部参与）。
        </p>
        <label class="field">
          <span>分析引导词（可选，应用于本批次全部材料）</span>
          <textarea v-model="batchGuide" rows="2" placeholder="如：重点提取做题方法与注意事项…"></textarea>
        </label>
        <div class="reimg-list" style="margin-bottom: 14px">
          <div v-for="m in batchItems" :key="m.id" class="reimg-item" style="flex-direction: column; align-items: stretch">
            <div style="display: flex; gap: 8px; align-items: center">
              <input type="checkbox" :checked="batchIncluded.includes(m.id)" @change="toggleInclude(m.id)" />
              <span class="reimg-name">《{{ m.title }}》</span>
              <span v-if="m.image_count" class="badge search">{{ m.image_count }} 图</span>
              <div class="spacer"></div>
              <button v-if="m.image_count" class="small" type="button" @click="toggleBatchPick(m)">
                {{ batchPickOpen[m.id] ? '收起图片选择' : '选择识别图片' }}
              </button>
            </div>
            <div v-if="batchPickOpen[m.id]" style="margin-top: 8px">
              <ImagePickList :material="m" v-model="batchSel[m.id]" />
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button @click="batchModal = null">取消</button>
          <button class="primary" :disabled="batchBusy || !batchIncluded.length" @click="confirmBatch">
            <span v-if="batchBusy" class="loading"></span>开始批量分析（{{ batchIncluded.length }} 份）
          </button>
        </div>
      </div>
    </div>

    <!-- 重新分析确认弹窗：引导词 + 逐张勾选要重新识别的图片 -->
    <div v-if="reModal" class="modal-mask" @click.self="reModal = null">
      <div class="modal" style="width: min(580px, 92vw)">
        <h3>重新分析《{{ reModal.title }}》</h3>
        <p class="muted" style="line-height: 1.7; margin-bottom: 12px">
          为节省 token，重新分析默认<b>复用已有的图片识别结果</b>。如需重新识别，请在下方勾选对应图片（仅重识别勾选项，不影响其他正常图片）。
        </p>
        <label class="field">
          <span>分析引导词（可选）</span>
          <textarea v-model="reGuide" rows="3" placeholder="如：重点提取做题方法与注意事项；注意本材料包含多个科目…"></textarea>
        </label>
        <div v-if="(reModal.image_count || 0) > 0" style="margin-bottom: 14px">
          <div class="muted" style="margin-bottom: 8px">
            本材料共 {{ reImgList.length || reModal.image_count }} 张图片<template v-if="reUndescribedCount">，其中 {{ reUndescribedCount }} 张尚无识别结果（将照常识别）</template><template v-if="reDescribed.length">，{{ reDescribed.length }} 张已有结果（默认复用，不消耗 token）</template>
          </div>
          <div v-if="reImgLoading" class="page-loading" style="padding: 16px 0"><span class="loading"></span>正在加载图片列表…</div>
          <template v-else-if="reDescribed.length">
            <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px">
              <button class="small" @click="reSelected = reDescribed.map((i) => i.id)">全选</button>
              <button class="small" @click="reSelected = []">清空</button>
              <span class="muted">已勾选 {{ reSelected.length }} 张重新识别（将消耗 token）</span>
            </div>
            <div class="reimg-list">
              <label v-for="img in reDescribed" :key="img.id" class="reimg-item">
                <input type="checkbox" :checked="reSelected.includes(img.id)" @change="toggleReImg(img.id)" />
                <span class="reimg-name">{{ img.placeholder || '图片 ' + img.id }}</span>
                <span class="muted reimg-desc">{{ (img.description || '').replace(/\s+/g, ' ').slice(0, 42) }}…</span>
              </label>
            </div>
          </template>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button @click="reModal = null">取消</button>
          <button class="primary" :disabled="reBusy" @click="confirmRun">
            <span v-if="reBusy" class="loading"></span>开始重新分析
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { STATUS_TEXT } from '../util.js';
import ImagePickList from '../components/ImagePickList.vue';

const materials = ref([]);
const jobs = ref([]);
const batches = ref([]);
const subGraphs = ref([]);
const error = ref('');
const busy = ref(false);
const guide = ref('');
const runningSet = ref(new Set());
// 开始分析弹窗（待分析/失败材料，含图片时可勾选参与识别的照片）
const startModal = ref(null);
const startGuide = ref('');
const startBusy = ref(false);
const startSelected = ref([]);
// 批量分析弹窗
const batchModal = ref(false);
const batchGuide = ref('');
const batchBusy = ref(false);
const batchIncluded = ref([]);
const batchPickOpen = reactive({});
const batchSel = reactive({});
// 重新分析确认弹窗（针对已完成材料）
const reModal = ref(null);
const reGuide = ref('');
const reBusy = ref(false);
const reImgList = ref([]); // 图片元信息 [{id, placeholder, description, hasDescription}]
const reImgLoading = ref(false);
const reSelected = ref([]); // 勾选要重新识别的图片 id
const pageLoading = ref(true);
let timer = null;

const pendingMaterials = computed(() => materials.value.filter((m) => m.status === 'pending' || m.status === 'failed'));
const batchItems = computed(() => pendingMaterials.value);
const hasRunning = computed(() => jobs.value.some((j) => j.status === 'running' || j.status === 'queued'));
const hasRunningBatch = computed(() => batches.value.some((b) => b.status === 'running'));
const reDescribed = computed(() => reImgList.value.filter((i) => i.hasDescription));
const reUndescribedCount = computed(() => reImgList.value.length - reDescribed.value.length);

async function load() {
  const [m, j, s, b] = await Promise.all([
    api.listMaterials({}),
    api.listJobs(),
    api.subGraphs(),
    api.listBatches()
  ]);
  materials.value = m.items;
  jobs.value = j.items;
  subGraphs.value = s.items;
  batches.value = b.items;
}

async function openRun(m) {
  error.value = '';
  if (m.status === 'done') {
    // 重新分析：弹窗确认，默认复用图片识别结果；可逐张勾选要重新识别的图片
    reGuide.value = guide.value;
    reSelected.value = [];
    reImgList.value = [];
    reModal.value = m;
    if ((m.image_count || 0) > 0) {
      reImgLoading.value = true;
      try {
        const d = await api.getMaterialImages(m.id, { meta: true });
        reImgList.value = d.items || [];
      } catch {
        reImgList.value = [];
      } finally {
        reImgLoading.value = false;
      }
    }
    return;
  }
  if ((m.image_count || 0) > 0) {
    // 含图片的待分析材料：弹窗让用户选择哪些照片参与识别
    startGuide.value = guide.value;
    startSelected.value = [];
    startModal.value = m;
    return;
  }
  run(m.id);
}

function toggleReImg(id) {
  const i = reSelected.value.indexOf(id);
  if (i >= 0) reSelected.value.splice(i, 1);
  else reSelected.value.push(id);
}

async function run(id, opts) {
  error.value = '';
  runningSet.value.add(id);
  try {
    await api.runAnalysis(id, guide.value.trim() || undefined, opts);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function confirmStart() {
  const m = startModal.value;
  if (!m) return;
  startBusy.value = true;
  try {
    startModal.value = null;
    runningSet.value.add(m.id);
    await api.runAnalysis(m.id, startGuide.value.trim() || undefined, { imageIds: startSelected.value });
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    startBusy.value = false;
  }
}

async function confirmRun() {
  const m = reModal.value;
  if (!m) return;
  reBusy.value = true;
  try {
    reModal.value = null;
    runningSet.value.add(m.id);
    await api.runAnalysis(m.id, reGuide.value.trim() || undefined, { reanalyzeImageIds: reSelected.value });
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    reBusy.value = false;
  }
}

// ---------- 批量分析 ----------
function openBatch() {
  error.value = '';
  batchGuide.value = guide.value;
  batchIncluded.value = pendingMaterials.value.map((m) => m.id);
  for (const k of Object.keys(batchPickOpen)) delete batchPickOpen[k];
  for (const k of Object.keys(batchSel)) delete batchSel[k];
  batchModal.value = true;
}

function toggleInclude(id) {
  const i = batchIncluded.value.indexOf(id);
  if (i >= 0) batchIncluded.value.splice(i, 1);
  else batchIncluded.value.push(id);
}

function toggleBatchPick(m) {
  if (batchPickOpen[m.id]) {
    delete batchPickOpen[m.id];
  } else {
    batchPickOpen[m.id] = true;
    if (!Array.isArray(batchSel[m.id])) batchSel[m.id] = [];
  }
}

async function confirmBatch() {
  batchBusy.value = true;
  try {
    const ids = batchIncluded.value.slice();
    const imageIdsMap = {};
    for (const id of ids) {
      // 仅对展开过图片选择的材料提交选定结果；未展开 = 全部图片参与（后端默认）
      if (Array.isArray(batchSel[id])) imageIdsMap[id] = batchSel[id];
    }
    batchModal.value = false;
    ids.forEach((id) => runningSet.value.add(id));
    await api.runBatchAnalysis(ids, batchGuide.value.trim() || undefined, imageIdsMap);
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    batchBusy.value = false;
  }
}

function startPolling() {
  timer = setInterval(async () => {
    if (!hasRunning.value && !hasRunningBatch.value) return;
    const j = await api.listJobs();
    jobs.value = j.items;
    const m = await api.listMaterials({});
    materials.value = m.items;
    runningSet.value = new Set(j.items.filter((x) => x.status === 'running' || x.status === 'queued').map((x) => x.material_id));
    const b = await api.listBatches();
    batches.value = b.items;
    if (!hasRunning.value && !hasRunningBatch.value) {
      const s = await api.subGraphs();
      subGraphs.value = s.items;
    }
  }, 1500);
}

onMounted(() => {
  load()
    .catch(() => {})
    .then(() => {
      pageLoading.value = false;
      startPolling();
    });
});
onUnmounted(() => clearInterval(timer));
</script>
