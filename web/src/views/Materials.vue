<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="row" style="align-items: flex-start">
      <div class="card" style="max-width: 420px">
        <h3>上传新材料</h3>
        <div v-if="error" class="error-box">{{ error }}</div>
        <label class="field">
          <span>标题 *</span>
          <input v-model="form.title" placeholder="如：牛顿运动定律讲义" />
        </label>
        <div class="row">
          <label class="field">
            <span>科目（可留空由 AI 判断；多科目材料可选"综合"）</span>
            <select v-model="form.subject">
              <option value="">自动</option>
              <option v-for="s in subjects" :key="s">{{ s }}</option>
            </select>
          </label>
          <label class="field">
            <span>分册</span>
            <input v-model="form.volume" placeholder="如：必修一" />
          </label>
        </div>
        <label class="field">
          <span>类型</span>
          <select v-model="form.kind">
            <option value="">自动</option>
            <option>题目</option>
            <option>笔记</option>
            <option>知识点总结</option>
            <option>教材章节</option>
            <option>其他</option>
          </select>
        </label>

        <div class="tabs">
          <button :class="{ active: tab === 'text' }" @click="tab = 'text'">粘贴文本</button>
          <button :class="{ active: tab === 'file' }" @click="tab = 'file'">上传文件</button>
        </div>

        <label v-if="tab === 'text'" class="field">
          <span>内容 *</span>
          <textarea v-model="form.content" rows="9" placeholder="粘贴学习内容（文档、题目、笔记等）"></textarea>
        </label>
        <label v-else class="field">
          <span>文件（可一次选择多份，.txt/.md/.csv/.json/.docx/.pdf/图片，单份 ≤50MB，最多 20 份）</span>
          <input
            ref="fileInput"
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp"
            @change="onFile"
          />
          <span v-if="files.length > 1" class="muted" style="margin-top: 5px">
            已选 {{ files.length }} 份文件：{{ files.map((f) => f.name).join('、') }}（多份上传时标题各取文件名）
          </span>
          <span class="muted" style="margin-top: 5px">Word/PDF 将自动提取文本与内嵌图像；图片可直接作为材料，分析时由视觉模型解读</span>
        </label>

        <button class="primary" style="width: 100%" :disabled="submitting" @click="submit">
          <span v-if="submitting" class="loading"></span>提交入库（状态：待分析）
        </button>
      </div>

      <div class="card" style="flex: 2">
        <div class="toolbar">
          <input v-model="filter.keyword" placeholder="搜索标题/概览" style="width: 200px" @keyup.enter="load" />
          <select v-model="filter.status" style="width: 130px">
            <option value="">全部状态</option>
            <option value="pending">待分析</option>
            <option value="analyzing">分析中</option>
            <option value="done">已完成</option>
            <option value="failed">失败</option>
          </select>
          <button class="small" @click="load">查询</button>
          <div class="spacer"></div>
          <span class="muted">共 {{ items.length }} 份材料</span>
        </div>
        <div v-if="!items.length" class="empty">暂无材料，请先上传</div>
        <table v-else>
          <thead>
            <tr><th>ID</th><th>标题</th><th>科目/分册</th><th>类型</th><th>大小</th><th>图片</th><th>状态</th><th>上传时间</th><th>操作</th></tr>
          </thead>
          <tr v-for="m in items" :key="m.id">
            <td>{{ m.id }}</td>
            <td>{{ m.title }}</td>
            <td class="muted">{{ m.subject || '-' }} {{ m.volume ? '/ ' + m.volume : '' }}</td>
            <td class="muted">{{ m.kind || '-' }}</td>
            <td class="muted">{{ m.content_length }} 字</td>
            <td><span v-if="m.image_count" class="badge search">{{ m.image_count }} 图</span><span v-else class="muted">-</span></td>
            <td>
              <span class="badge" :class="m.status">{{ STATUS_TEXT[m.status] || m.status }}</span>
              <div v-if="m.status === 'analyzing' && jobSteps[m.id]" class="muted" style="font-size: 11px; margin-top: 3px">
                <span class="loading" style="width: 10px; height: 10px"></span>{{ jobSteps[m.id] }}
              </div>
            </td>
            <td class="muted">{{ m.created_at }}</td>
            <td>
              <button class="small" @click="view(m)">查看</button>
              <button class="small danger" @click="del(m)">删除</button>
            </td>
          </tr>
        </table>
      </div>
    </div>

    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal">
        <h3>{{ detail.title }}</h3>
        <div class="kv">
          <span class="k">状态</span><span><span class="badge" :class="detail.status">{{ STATUS_TEXT[detail.status] }}</span></span>
          <span class="k">科目</span><span>{{ detail.subject || '-' }} {{ detail.volume ? '/ ' + detail.volume : '' }}</span>
          <span class="k">类型</span><span>{{ detail.kind || '-' }}</span>
          <span class="k">源文件</span><span>{{ detail.file_name || '文本粘贴' }}</span>
          <span class="k">片段数</span><span>{{ detail.chunkCount }}</span>
          <span class="k">更新时间</span><span>{{ detail.updated_at }}</span>
        </div>
        <div v-if="detail.summary">
          <h3>AI 概览</h3>
          <p class="muted" style="margin-bottom: 12px; line-height: 1.7">{{ detail.summary }}</p>
        </div>
        <div v-if="detail.meta?.logicalParts?.length">
          <h3>逻辑部分</h3>
          <div v-for="p in detail.meta.logicalParts" :key="p.title" class="node-card">
            <div class="name">{{ p.title }}</div>
            <div class="muted">{{ p.summary }}</div>
          </div>
        </div>
        <div v-if="images.length">
          <h3>材料图像（共 {{ images.length }} 张 · 一页一张，按需加载）</h3>
          <div class="img-pager">
            <div class="img-pager-bar">
              <button class="small" :disabled="imgPage <= 0" @click="gotoImage(imgPage - 1)">← 上一张</button>
              <span class="muted">第 {{ imgPage + 1 }} / {{ images.length }} 张{{ currentImage?.placeholder ? ' · ' + currentImage.placeholder : '' }}</span>
              <button class="small" :disabled="imgPage >= images.length - 1" @click="gotoImage(imgPage + 1)">下一张 →</button>
            </div>
            <div class="img-pager-stage">
              <img v-if="imgDataUrl" :src="imgDataUrl" :alt="currentImage?.placeholder || ''" />
              <div v-else-if="imgLoading" class="page-loading" style="padding: 20px 0"><span class="loading"></span>正在加载图片…</div>
              <button v-else class="primary small" @click="loadCurrentImage">点击加载图片预览</button>
            </div>
            <div v-if="currentImage?.note" class="muted" style="font-size: 12px; margin-top: 8px">备注：{{ currentImage.note }}</div>
            <div v-if="currentImage?.description" class="muted" style="font-size: 12px; line-height: 1.6; margin-top: 6px">
              <b>AI 识别：</b>{{ currentImage.description }}
            </div>
            <div v-else class="muted" style="font-size: 12px; margin-top: 6px">（尚无视觉描述，分析后生成）</div>
          </div>
        </div>
        <h3>原文</h3>
        <pre class="md-text">{{ detail.content }}</pre>
        <div style="text-align: right; margin-top: 12px"><button @click="detail = null">关闭</button></div>
      </div>
    </div>

    <!-- 入库成功：询问是否立即分析（可附引导词、逐份勾选参与识别的照片；多份时批量分析并统一汇总） -->
    <div v-if="askModal" class="modal-mask">
      <div class="modal" style="width: min(600px, 92vw)">
        <h3>{{ askModal.items.length > 1 ? `已入库 ${askModal.items.length} 份材料` : '材料已入库' }}</h3>
        <p class="muted" style="line-height: 1.7; margin-bottom: 12px">
          <template v-if="askModal.items.length === 1">
            《{{ askModal.items[0].title }}》已保存成功。是否立即开始 AI 分析（构建知识图谱、生成概览与语义检索索引）？
          </template>
          <template v-else>
            共 {{ askModal.items.length }} 份材料保存成功。立即分析时 AI 将<b>逐份分批处理</b>，全部完成后自动生成<b>统一汇总</b>。
          </template>
          <template v-if="askHasImages">含图片的材料可展开勾选哪些照片参与识别（默认全部参与）。</template>
        </p>
        <label class="field">
          <span>分析引导词（可选）</span>
          <textarea v-model="askGuide" rows="3" placeholder="如：重点提取做题方法与注意事项；本材料包含多个科目，请分别为知识点标注科目…"></textarea>
        </label>
        <div v-if="askHasImages" class="reimg-list" style="margin-bottom: 14px">
          <div v-for="m in askModal.items" :key="m.id" class="reimg-item" style="flex-direction: column; align-items: stretch">
            <div style="display: flex; gap: 8px; align-items: center">
              <span class="reimg-name">《{{ m.title }}》</span>
              <span v-if="m.imageCount" class="badge search">{{ m.imageCount }} 图</span>
              <div class="spacer"></div>
              <button v-if="m.imageCount" class="small" type="button" @click="toggleAskPick(m)">
                {{ askPickOpen[m.id] ? '收起图片选择' : '选择识别图片' }}
              </button>
            </div>
            <div v-if="askPickOpen[m.id]" style="margin-top: 8px">
              <ImagePickList :material="{ id: m.id, image_count: m.imageCount }" v-model="askSel[m.id]" />
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button @click="cancelAsk">稍后分析</button>
          <button class="primary" :disabled="askBusy" @click="analyzeNow">
            <span v-if="askBusy" class="loading"></span>{{ askModal.items.length > 1 ? `立即批量分析（${askModal.items.length} 份）` : '立即分析' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { STATUS_TEXT } from '../util.js';
import ImagePickList from '../components/ImagePickList.vue';
import { winConfirm } from '../dialogs.js';

const route = useRoute();
const subjects = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '综合', '其他'];
const items = ref([]);
const detail = ref(null);
const images = ref([]);
const error = ref('');
const submitting = ref(false);
const tab = ref('text');
const files = ref([]); // 支持一次选择多份文件
const fileInput = ref(null);
const form = reactive({ title: '', subject: '', volume: '', kind: '', content: '' });
const filter = reactive({ keyword: '', status: '' });

// 上传成功后的"是否立即分析"确认弹窗（支持多份材料 + 逐份勾选参与识别的照片）
const askModal = ref(null); // { items: [{id, title, imageCount}] }
const askGuide = ref('');
const askBusy = ref(false);
const askPickOpen = reactive({});
const askSel = reactive({});
const askHasImages = computed(() => (askModal.value?.items || []).some((m) => m.imageCount > 0));
// 分析中材料的实时步骤（material_id → step 文案，如"正在识别图片 2/3"）
const jobSteps = ref({});
const pageLoading = ref(true);
let stepTimer = null;

async function load() {
  const data = await api.listMaterials({
    keyword: filter.keyword || undefined,
    status: filter.status || undefined
  });
  items.value = data.items;
}

function onFile(e) {
  files.value = Array.from(e.target.files || []);
  if (files.value.length === 1 && !form.title) form.title = files.value[0].name.replace(/\.[^.]+$/, '');
}

async function submit() {
  error.value = '';
  submitting.value = true;
  try {
    let newItems = [];
    if (tab.value === 'text') {
      const r = await api.createMaterial({ ...form });
      newItems = [{ id: r.id, title: form.title, imageCount: 0 }];
    } else {
      if (!files.value.length) throw new Error('请选择文件');
      const fd = new FormData();
      for (const f of files.value) fd.append('files', f);
      if (form.title && files.value.length === 1) fd.append('title', form.title);
      if (form.subject) fd.append('subject', form.subject);
      if (form.volume) fd.append('volume', form.volume);
      if (form.kind) fd.append('kind', form.kind);
      const r = await api.uploadMaterial(fd);
      newItems = (r.items || [{ id: r.id, title: form.title, imageCount: r.imageCount }]).map((it) => ({
        id: it.id,
        title: it.title,
        imageCount: it.imageCount || 0
      }));
      if (r.errors?.length) {
        error.value = `部分文件未入库：${r.errors.map((e) => `${e.file}（${e.error}）`).join('；')}`;
      }
    }
    Object.assign(form, { title: '', content: '' });
    files.value = [];
    if (fileInput.value) fileInput.value.value = '';
    await load();
    // 不再自动分析：弹窗询问用户是否立即分析（可附引导词、可勾选参与识别的照片；多份走批量分析并统一汇总）
    if (newItems.length) {
      askGuide.value = '';
      for (const k of Object.keys(askPickOpen)) delete askPickOpen[k];
      for (const k of Object.keys(askSel)) delete askSel[k];
      askModal.value = { items: newItems };
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
  }
}

function toggleAskPick(m) {
  if (askPickOpen[m.id]) {
    delete askPickOpen[m.id];
  } else {
    askPickOpen[m.id] = true;
    if (!Array.isArray(askSel[m.id])) askSel[m.id] = [];
  }
}

async function analyzeNow() {
  if (!askModal.value) return;
  askBusy.value = true;
  try {
    const list = askModal.value.items;
    const guide = askGuide.value.trim() || undefined;
    if (list.length === 1) {
      const m = list[0];
      // 单份：普通分析；仅当用户展开过图片选择时提交选定结果（未展开 = 全部参与）
      const imageIds = Array.isArray(askSel[m.id]) ? askSel[m.id] : undefined;
      await api.runAnalysis(m.id, guide, imageIds ? { imageIds } : {});
    } else {
      // 多份：批量分析（AI 逐份处理，完成后统一汇总）
      const imageIdsMap = {};
      for (const m of list) {
        if (Array.isArray(askSel[m.id])) imageIdsMap[m.id] = askSel[m.id];
      }
      await api.runBatchAnalysis(list.map((m) => m.id), guide, imageIdsMap);
    }
    askModal.value = null;
    await load();
    startStepPolling();
  } catch (e) {
    error.value = e.message;
  } finally {
    askBusy.value = false;
  }
}

function cancelAsk() {
  askModal.value = null;
}

// 有"分析中"材料时轮询任务步骤，让用户看到如"正在识别图片 2/3"的实时进度
function startStepPolling() {
  if (stepTimer) return;
  stepTimer = setInterval(async () => {
    const analyzing = items.value.filter((m) => m.status === 'analyzing');
    if (!analyzing.length) {
      jobSteps.value = {};
      clearInterval(stepTimer);
      stepTimer = null;
      return;
    }
    try {
      const j = await api.listJobs();
      const map = {};
      for (const job of j.items) {
        if ((job.status === 'running' || job.status === 'queued') && !(job.material_id in map)) {
          map[job.material_id] = job.step || '排队中';
        }
      }
      jobSteps.value = map;
    } catch {
      /* 忽略轮询失败 */
    }
  }, 1500);
}

async function view(m) {
  detail.value = await api.getMaterial(m.id);
  images.value = [];
  imgPage.value = 0;
  imgDataUrl.value = null;
  if (detail.value.imageCount > 0) {
    try {
      // 仅取轻量元信息（不含图片数据）：看哪张再点哪张加载，避免一次性加载大量图片
      images.value = (await api.getMaterialImages(m.id, { meta: true })).items;
    } catch {
      images.value = [];
    }
  }
}

// ---------- 图片分页浏览：一页一张，手动点击加载 ----------
const imgPage = ref(0);
const imgDataUrl = ref(null);
const imgLoading = ref(false);
const currentImage = computed(() => images.value[imgPage.value] || null);

function gotoImage(i) {
  if (i < 0 || i >= images.value.length) return;
  imgPage.value = i;
  imgDataUrl.value = null; // 切换后不自动加载，等待用户手动点击
}

async function loadCurrentImage() {
  const img = currentImage.value;
  if (!img || !detail.value) return;
  imgLoading.value = true;
  try {
    const d = await api.getMaterialImage(detail.value.id, img.id);
    imgDataUrl.value = d.dataUrl || null;
    if (!imgDataUrl.value) error.value = '图片文件加载失败（文件可能缺失）';
  } catch (e) {
    error.value = e.message;
  } finally {
    imgLoading.value = false;
  }
}

async function del(m) {
  if (!(await winConfirm({ title: '删除确认', message: `确认删除材料《${m.title}》？（对应文本片段与向量将一并删除，共享知识点保留）`, danger: true }))) return;
  await api.deleteMaterial(m.id);
  await load();
}

onMounted(async () => {
  try {
    await load();
  } finally {
    pageLoading.value = false;
  }
  if (items.value.some((m) => m.status === 'analyzing')) startStepPolling();
  if (route.query.focus) {
    try {
      await view({ id: route.query.focus });
    } catch {
      /* 材料不存在时忽略 */
    }
  }
});

onUnmounted(() => {
  if (stepTimer) clearInterval(stepTimer);
});
</script>
